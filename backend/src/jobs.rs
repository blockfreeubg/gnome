//! Periodic background jobs with graceful shutdown.
//!
//! Modules contribute [`Job`]s via `Module::jobs`. Each job runs on its own task: first after `first_run_after`,
//! then every `every` (measured from the end of the previous run, so runs never overlap), or immediately when
//! [`JobRegistry::trigger`] is called (e.g. an admin "refresh now" endpoint). On shutdown the loops stop and a run in
//! progress is dropped at its next await point; long jobs should also watch `state.shutdown`. Each run is its own
//! task, so a run that panics is recorded as a failure (`panicked: …`) and the job keeps its schedule.

use std::future::Future;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Notify;

use crate::state::AppState;
use crate::util::{BoxError, BoxFuture, now_ms};

type JobFn = Arc<dyn Fn(AppState) -> BoxFuture<'static, Result<(), BoxError>> + Send + Sync>;

/// A periodic task.
#[derive(Clone)]
pub struct Job {
    pub name: &'static str,
    pub every: Duration,
    pub first_run_after: Duration,
    run: JobFn,
}

impl std::fmt::Debug for Job {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Job").field("name", &self.name).field("every", &self.every).finish()
    }
}

impl Job {
    /// `name` must be unique (it is used for logs, diagnostics and [`JobRegistry::trigger`]).
    pub fn new<F, Fut>(name: &'static str, every: Duration, f: F) -> Self
    where
        F: Fn(AppState) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), BoxError>> + Send + 'static,
    {
        Self { name, every, first_run_after: every, run: Arc::new(move |state| Box::pin(f(state))) }
    }

    /// Delay before the first run (default: one interval).
    pub fn first_run_after(mut self, delay: Duration) -> Self {
        self.first_run_after = delay;
        self
    }
}

/// Last-known state of a job (diagnostics).
#[derive(Debug, Clone, Default, Serialize)]
pub struct JobStatus {
    pub name: &'static str,
    pub every_s: u64,
    pub runs: u64,
    pub failures: u64,
    pub running: bool,
    pub last_started_at: Option<i64>,
    pub last_duration_ms: Option<u64>,
    pub last_error: Option<String>,
}

struct Entry {
    status: Mutex<JobStatus>,
    wake: Notify,
}

/// Registry of started jobs (lives in `AppState`).
#[derive(Default)]
pub struct JobRegistry {
    entries: RwLock<Vec<(&'static str, Arc<Entry>)>>,
}

impl std::fmt::Debug for JobRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.snapshot().iter().map(|s| s.name)).finish()
    }
}

impl JobRegistry {
    /// Run a job now (if it is idle, the next run starts immediately). Returns `false` for unknown jobs.
    pub fn trigger(&self, name: &str) -> bool {
        let entries = self.entries.read().unwrap_or_else(|e| e.into_inner());
        match entries.iter().find(|(n, _)| *n == name) {
            Some((_, e)) => {
                e.wake.notify_one();
                true
            }
            None => false,
        }
    }

    pub fn snapshot(&self) -> Vec<JobStatus> {
        let entries = self.entries.read().unwrap_or_else(|e| e.into_inner());
        entries.iter().map(|(_, e)| e.status.lock().unwrap_or_else(|p| p.into_inner()).clone()).collect()
    }

    /// Start every job on `state.tasks`; loops end when `state.shutdown` is cancelled.
    ///
    /// # Panics
    /// If two jobs share a name.
    pub fn start(&self, state: &AppState, jobs: Vec<Job>) {
        let mut entries = self.entries.write().unwrap_or_else(|e| e.into_inner());
        for job in jobs {
            assert!(!entries.iter().any(|(n, _)| *n == job.name), "duplicate job name {}", job.name);
            let entry = Arc::new(Entry {
                status: Mutex::new(JobStatus { name: job.name, every_s: job.every.as_secs(), ..JobStatus::default() }),
                wake: Notify::new(),
            });
            entries.push((job.name, entry.clone()));
            let state = state.clone();
            state.tasks.clone().spawn(run_loop(state, job, entry));
        }
    }
}

async fn run_loop(state: AppState, job: Job, entry: Arc<Entry>) {
    let token = state.shutdown.clone();
    let mut next = tokio::time::Instant::now() + job.first_run_after;
    loop {
        tokio::select! {
            () = token.cancelled() => break,
            () = tokio::time::sleep_until(next) => {}
            () = entry.wake.notified() => {}
        }
        let started = Instant::now();
        {
            let mut s = entry.status.lock().unwrap_or_else(|e| e.into_inner());
            s.running = true;
            s.last_started_at = Some(now_ms());
        }
        let mut run = tokio::spawn((job.run)(state.clone()));
        let result = tokio::select! {
            () = token.cancelled() => {
                run.abort();
                None
            }
            joined = &mut run => Some(joined.unwrap_or_else(|e| Err(join_error(e)))),
        };
        let elapsed = started.elapsed();
        {
            let mut s = entry.status.lock().unwrap_or_else(|e| e.into_inner());
            s.running = false;
            s.runs += 1;
            s.last_duration_ms = Some(u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX));
            match &result {
                Some(Ok(())) => s.last_error = None,
                Some(Err(e)) => {
                    s.failures += 1;
                    s.last_error = Some(e.to_string());
                }
                None => {}
            }
        }
        match result {
            None => break,
            Some(Ok(())) => tracing::debug!(job = job.name, ms = elapsed.as_millis() as u64, "job finished"),
            Some(Err(e)) => tracing::warn!(job = job.name, error = %e, "job failed"),
        }
        next = tokio::time::Instant::now() + job.every;
    }
    tracing::debug!(job = job.name, "job stopped");
}

/// A run that did not return: its panic message (the panic itself is logged by the panic hook), or cancellation.
fn join_error(e: tokio::task::JoinError) -> BoxError {
    if !e.is_panic() {
        return e.to_string().into();
    }
    let payload = e.into_panic();
    let detail = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic payload".into());
    format!("panicked: {detail}").into()
}
