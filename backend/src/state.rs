//! Shared application state.
//!
//! [`AppState`] is a cheap `Arc` handle given to every handler (`State<AppState>`), middleware, job and module. It
//! holds the core services plus the state modules publish at startup ([`AppState::ext`], see [`crate::module`]).

use std::ops::Deref;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::auth::anon::AnonKey;
use crate::auth::backoff::LoginBackoff;
use crate::auth::password::Passwords;
use crate::config::Config;
use crate::db::Db;
use crate::jobs::JobRegistry;
use crate::metrics::Metrics;
use crate::module::{Module, ModuleSetup, builtin_modules};
use crate::security::client::TrustedProxies;
use crate::security::headers::SecurityHeaders;
use crate::security::origin::OriginPolicy;
use crate::security::rate_limit::RateLimiter;
use crate::security::secret_key::{self, SecretKey};
use crate::static_files::{StaticFiles, StaticPolicies};
use crate::util::now_ms;

/// Fatal startup problem (printed and the process exits non-zero).
#[derive(Debug)]
pub struct StartupError(pub String);

impl std::fmt::Display for StartupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StartupError {}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppInner>,
}

pub struct AppInner {
    pub config: Arc<Config>,
    pub db: Db,
    pub secret: SecretKey,
    pub anon_key: AnonKey,
    pub passwords: Passwords,
    pub limiter: RateLimiter,
    pub backoff: LoginBackoff,
    pub metrics: Metrics,
    pub static_files: StaticFiles,
    pub security_headers: SecurityHeaders,
    pub origins: OriginPolicy,
    pub trusted_proxies: TrustedProxies,
    pub jobs: JobRegistry,
    /// Cancelled when the server begins shutting down. Long-lived tasks (WebSocket splices, imports) watch it.
    pub shutdown: CancellationToken,
    /// Background tasks awaited (with a grace period) during shutdown. Spawn long-lived work here.
    pub tasks: TaskTracker,
    pub started_at: Instant,
    pub started_at_ms: i64,
    modules: OnceLock<Vec<Arc<dyn Module>>>,
    /// Module state published through [`ModuleSetup::provide`] (values are `Arc<T>`).
    extensions: OnceLock<http::Extensions>,
}

impl Deref for AppState {
    type Target = AppInner;

    fn deref(&self) -> &AppInner {
        &self.inner
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("modules", &self.modules().iter().map(|m| m.name()).collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

/// Create `dir` (and parents) with owner-only permissions if missing.
pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        b.mode(0o700);
    }
    b.create(dir)
}

impl AppState {
    /// Prepare everything the server needs: data dir, secret key, database (migrated), static index, modules.
    pub async fn open(config: Config) -> Result<Self, StartupError> {
        Self::open_with(config, builtin_modules).await
    }

    /// [`AppState::open`] with a custom module list (tests, embedding). `modules` runs once, after the core
    /// services exist; it may publish module state with [`ModuleSetup::provide`].
    pub async fn open_with<F>(config: Config, modules: F) -> Result<Self, StartupError>
    where
        F: FnOnce(&mut ModuleSetup<'_>) -> Vec<Arc<dyn Module>>,
    {
        ensure_private_dir(&config.data_dir)
            .map_err(|e| StartupError(format!("cannot create data dir {}: {e}", config.data_dir.display())))?;
        let secret = secret_key::load_or_create(&config).map_err(StartupError)?;
        let db = Db::open(config.db_path(), config.db_readers)
            .await
            .map_err(|e| StartupError(format!("database {}: {e}", config.db_path().display())))?;
        let passwords = Passwords::new(config.argon2_memory_kib).map_err(|e| StartupError(e.to_string()))?;
        let static_dir = config.static_dir.clone();
        let policies = StaticPolicies::from_config(&config);
        let static_files = tokio::task::spawn_blocking(move || StaticFiles::load(&static_dir, &policies))
            .await
            .map_err(|e| StartupError(format!("static index: {e}")))?;
        let inner = AppInner {
            anon_key: AnonKey::new(&secret, config.access_mode, config.access_code.as_ref()),
            secret,
            db,
            passwords,
            limiter: RateLimiter::new(config.rate_limit_scale),
            backoff: LoginBackoff::default(),
            metrics: Metrics::default(),
            static_files,
            security_headers: SecurityHeaders::new(&config),
            origins: OriginPolicy::new(config.public_origins.clone()),
            trusted_proxies: TrustedProxies::new(config.trusted_proxies.clone()),
            jobs: JobRegistry::default(),
            shutdown: CancellationToken::new(),
            tasks: TaskTracker::new(),
            started_at: Instant::now(),
            started_at_ms: now_ms(),
            modules: OnceLock::new(),
            extensions: OnceLock::new(),
            config: Arc::new(config),
        };
        let state = Self { inner: Arc::new(inner) };
        let mut setup = ModuleSetup::new(&state);
        let list = modules(&mut setup);
        let extensions = setup.finish();
        // Both are set exactly once, right after construction and before anything can observe them.
        let _ = state.inner.extensions.set(extensions);
        let _ = state.inner.modules.set(list);
        Ok(state)
    }

    /// Await every module's `prepare` in mount order (WAVE-C D21). Called by `server::serve_all` before
    /// `start_jobs()`, by the `catalog` CLI, and by the test harness after `open_with`.
    pub async fn prepare_modules(&self) {
        for module in self.modules() {
            module.prepare(self).await;
        }
    }

    /// Enabled modules in mount order.
    pub fn modules(&self) -> &[Arc<dyn Module>] {
        self.inner.modules.get().map_or(&[], Vec::as_slice)
    }

    /// Module state of type `T` published at startup with [`ModuleSetup::provide`], if any.
    pub fn ext<T: Send + Sync + 'static>(&self) -> Option<Arc<T>> {
        self.inner.extensions.get()?.get::<Arc<T>>().cloned()
    }

    /// Seconds since startup.
    pub fn uptime_s(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    /// Start every module's jobs (call once, when serving).
    pub fn start_jobs(&self) {
        let jobs = self.modules().iter().flat_map(|m| m.jobs(self)).collect();
        self.jobs.start(self, jobs);
    }
}
