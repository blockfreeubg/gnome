//! `gnome-server catalog import --replay <index.json>` (WAVE-C D19): the importers' requests are answered from
//! captured responses instead of the network, with the adapter settings the captures were made with and a pinned
//! clock. Development and tests only: never contacts a host, and the overrides never reach a running server.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use gnome_catalog::{
    BoxFuture, CatalogConfig, Clock, FetchError, FetchRequest, FetchResponse, Fetcher, FixtureFetcher, FixtureResponse,
    Source,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u32,
    #[serde(default)]
    #[allow(dead_code)]
    note: Option<String>,
    now: String,
    #[serde(default)]
    config: BTreeMap<String, SourceOverrides>,
    #[serde(default)]
    sources: BTreeMap<String, Vec<Capture>>,
}

/// The adapter settings a capture was made with (replay mode only).
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceOverrides {
    per_page: Option<u32>,
    category: Option<String>,
    max_pages: Option<u32>,
    first_year: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    url_contains: Vec<String>,
    status: u16,
    file: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

/// The captures as a [`Fetcher`]: an unmatched request fails with the non-retryable `Blocked("no fixture for …")`,
/// never `Network`, so nothing backs off.
pub struct ReplayFetcher(FixtureFetcher);

impl ReplayFetcher {
    /// Every request received so far.
    pub fn requests(&self) -> Vec<gnome_catalog::FetchRequest> {
        self.0.requests()
    }
}

impl Fetcher for ReplayFetcher {
    fn fetch(&self, request: FetchRequest) -> BoxFuture<'_, Result<FetchResponse, FetchError>> {
        Box::pin(async move {
            match self.0.fetch(request).await {
                Err(FetchError::Network(m)) if m.starts_with("no fixture for ") => Err(FetchError::Blocked(m)),
                other => other,
            }
        })
    }
}

/// A loaded replay index.
pub struct Replay {
    pub fetcher: ReplayFetcher,
    pub clock: ReplayClock,
    overrides: BTreeMap<String, SourceOverrides>,
}

impl std::fmt::Debug for Replay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Replay").finish_non_exhaustive()
    }
}

/// `now` + the time "slept": sleeps return at once, so request spacing and back-off cost no real time.
#[derive(Debug)]
pub struct ReplayClock {
    now_ms: AtomicI64,
}

impl ReplayClock {
    pub fn new(now_ms: i64) -> Self {
        Self { now_ms: AtomicI64::new(now_ms) }
    }
}

impl Clock for ReplayClock {
    fn now_ms(&self) -> i64 {
        self.now_ms.load(Ordering::Relaxed)
    }

    fn sleep(&self, d: Duration) -> BoxFuture<'_, ()> {
        self.now_ms.fetch_add(i64::try_from(d.as_millis()).unwrap_or(i64::MAX / 2), Ordering::Relaxed);
        Box::pin(async {})
    }
}

/// A path relative to the index directory (absolute paths and `..` are refused).
fn relative(base: &Path, file: &str) -> Result<PathBuf, String> {
    let p = Path::new(file);
    if file.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("{file:?}: replay files must be relative paths inside the index directory"));
    }
    Ok(base.join(p))
}

impl Replay {
    pub fn load(index_path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(index_path).map_err(|e| format!("{}: {e}", index_path.display()))?;
        let index: Index = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", index_path.display()))?;
        if index.version != 1 {
            return Err(format!("{}: unsupported version {}", index_path.display(), index.version));
        }
        let now_ms = gnome_catalog::date::parse_iso8601(&index.now)
            .ok_or_else(|| format!("now: {:?} is not a time", index.now))?;
        for id in index.config.keys().chain(index.sources.keys()) {
            if Source::from_id(id).is_none() {
                return Err(format!("unknown source {id:?} in the replay index"));
            }
        }
        let base = index_path.parent().unwrap_or(Path::new("."));
        let fetcher = FixtureFetcher::new();
        for captures in index.sources.values() {
            for c in captures {
                let body = std::fs::read(relative(base, &c.file)?).map_err(|e| format!("{}: {e}", c.file))?;
                let parts: Vec<&str> = c.url_contains.iter().map(String::as_str).collect();
                let response = FixtureResponse {
                    status: c.status,
                    headers: c.headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect(),
                    body,
                };
                fetcher.on_url(&parts, vec![response]);
            }
        }
        Ok(Self { fetcher: ReplayFetcher(fetcher), clock: ReplayClock::new(now_ms), overrides: index.config })
    }

    /// The catalog configuration with the index's adapter settings applied.
    pub fn apply(&self, config: &CatalogConfig) -> CatalogConfig {
        let mut c = config.clone();
        for (id, o) in &self.overrides {
            match Source::from_id(id) {
                Some(Source::GamePix) => {
                    if let Some(n) = o.per_page {
                        c.gamepix.per_page = n;
                    }
                    if o.category.is_some() {
                        c.gamepix.category.clone_from(&o.category);
                    }
                }
                Some(Source::GameDistribution) => {
                    if let Some(n) = o.per_page {
                        c.gamedistribution.per_page = n;
                    }
                }
                Some(Source::Playgama) => {
                    if let Some(n) = o.per_page {
                        c.playgama.per_page = n;
                    }
                }
                Some(Source::GameMonetize) => {
                    if let Some(n) = o.per_page {
                        c.gamemonetize.per_page = n;
                    }
                }
                Some(Source::ItchIo) => {
                    if let Some(n) = o.max_pages {
                        c.itchio.max_pages = n;
                    }
                }
                Some(Source::Js13k) => {
                    if let Some(y) = o.first_year {
                        c.js13k.first_year = y;
                    }
                }
                _ => {}
            }
        }
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside() {
        let base = Path::new("/idx");
        assert_eq!(relative(base, "a/b.json").unwrap(), Path::new("/idx/a/b.json"));
        for bad in ["/etc/passwd", "../x", "a/../../x", "./a", ""] {
            assert!(relative(base, bad).is_err(), "{bad}");
        }
    }
}
