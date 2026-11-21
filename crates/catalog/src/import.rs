//! The import driver: streams a source page by page.
//!
//! For each page: wait for the source's minimum request interval, send the request with `If-None-Match` /
//! `If-Modified-Since` when validators are cached, retry 429 / 5xx / transport errors with exponential back-off
//! (honouring `Retry-After`), parse and normalize the page, and store it in one transaction. A `304` replays the
//! cached list of ids (those games are still listed). Only one page is held in memory at a time.
//!
//! At the end the run is *complete* only if it reached the end of the feed without errors or limits and the
//! number of games listed is within ±10% of the previous complete sync (and of the source's reported total);
//! only complete runs count towards hiding games missing from 3 consecutive syncs.

use std::time::Duration;

use serde::Serialize;

use crate::Catalog;
use crate::error::{CatalogError, Result};
use crate::fetch::{Clock, FetchRequest, FetchResponse, Fetcher, WriteDb};
use crate::source::Source;
use crate::sources::{self, ItemCtx, PageInfo};
use crate::store::{self, Finish, NotModified, PageWrite};

/// Attempts per request (1 + retries).
pub const MAX_ATTEMPTS: u32 = 5;
/// Back-off cap.
pub const MAX_BACKOFF: Duration = Duration::from_secs(10 * 60);
/// Base back-off after a 5xx or a transport error.
pub const SERVER_ERROR_BACKOFF: Duration = Duration::from_secs(2);
/// Pages after which a run stops as runaway (the largest real feed, GameDistribution, has ~220 pages; GamePix at
/// the smallest page size ~1,250).
pub const MAX_PAGES_PER_RUN: u32 = 10_000;
/// Consecutive pages of one feed consisting only of games already listed earlier in the run after which the feed
/// is considered to be repeating itself (e.g. it ignores the page parameter) and the run stops. Counted per feed:
/// a multi-feed source (itch.io browse feeds) may legitimately list games another feed already listed.
pub const MAX_REPEATED_PAGES: u32 = 3;

/// Options of one import run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ImportOptions {
    /// Stop after this many games (CLI `--limit`). Limited runs never count as complete.
    pub limit: Option<usize>,
    /// Stop after this many pages. Limited runs never count as complete.
    pub max_pages: Option<u32>,
}

/// Result of one import run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportReport {
    /// `catalog_imports.id` of this run.
    pub run_id: i64,
    /// The imported source.
    pub source: Source,
    /// `complete` | `incomplete` | `failed`.
    pub status: String,
    /// Whether the run is complete (trusted for hiding missing games).
    pub complete: bool,
    /// Pages stored (304 replays included).
    pub pages: u32,
    /// Pages answered `304 Not Modified`.
    pub not_modified_pages: u32,
    /// HTTP requests made, retries included.
    pub requests: u32,
    /// Retried requests (429, 5xx, transport errors).
    pub retries: u32,
    /// Distinct games the source listed in this run.
    pub seen: i64,
    /// New games.
    pub inserted: u32,
    /// Games whose normalized record changed.
    pub updated: u32,
    /// Games seen again without changes.
    pub unchanged: u32,
    /// Records that failed validation.
    pub rejected: u32,
    /// Games that reached the missing-from-3-syncs threshold in this run.
    pub hidden: i64,
    /// Why the run is incomplete, or an informational note (e.g. catalog growth).
    pub note: Option<String>,
    /// Fatal fetch/parse error that ended the run.
    pub error: Option<String>,
    /// Wall time of the run.
    pub duration_ms: i64,
}

#[derive(Default)]
struct Counters {
    pages: u32,
    not_modified: u32,
    requests: u32,
    retries: u32,
    inserted: u32,
    updated: u32,
    unchanged: u32,
    rejected: u32,
    items: usize,
    /// Requests / retries already recorded with a stored page.
    stored_requests: u32,
    stored_retries: u32,
}

/// Spacing between requests to one source.
struct Pacer {
    interval_ms: i64,
    last: Option<i64>,
}

impl Pacer {
    async fn wait<C: Clock + ?Sized>(&mut self, clock: &C) {
        if let Some(last) = self.last {
            let due = last + self.interval_ms;
            let now = clock.now_ms();
            if due > now {
                clock.sleep(Duration::from_millis((due - now) as u64)).await;
            }
        }
        self.last = Some(clock.now_ms());
    }
}

/// Deterministic ±20% jitter (no RNG dependency; varies with time and attempt).
fn jitter(base: Duration, now_ms: i64, attempt: u32) -> Duration {
    let x =
        (now_ms as u64 ^ (u64::from(attempt).wrapping_mul(0x9E37_79B9_7F4A_7C15))).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    let frac = (x >> 11) as f64 / (1u64 << 53) as f64; // 0..1
    base.mul_f64(0.8 + 0.4 * frac)
}

/// `Retry-After` (seconds or HTTP date) relative to `now_ms`.
pub fn retry_after(resp: &FetchResponse, now_ms: i64) -> Option<Duration> {
    let v = resp.header("retry-after")?.trim();
    if let Ok(secs) = v.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = crate::date::parse_rfc2822(v)?;
    Some(Duration::from_millis(u64::try_from(at - now_ms).unwrap_or(0)))
}

/// Cloudflare "error 1015" (rate limited) pages, which GameMonetize may serve with status 200.
fn is_rate_limit_page(resp: &FetchResponse) -> bool {
    resp.body.len() < 64 * 1024 && resp.body.windows(16).any(|w| w == b"error code: 1015")
}

enum Outcome {
    Response(FetchResponse),
    Failed(String),
}

async fn fetch_with_retry<F, C>(
    fetcher: &F,
    clock: &C,
    pacer: &mut Pacer,
    source: Source,
    req: FetchRequest,
    c: &mut Counters,
) -> Outcome
where
    F: Fetcher + ?Sized,
    C: Clock + ?Sized,
{
    let mut last_error = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        pacer.wait(clock).await;
        c.requests += 1;
        let wait = match fetcher.fetch(req.clone()).await {
            Ok(r) if r.status == 429 || is_rate_limit_page(&r) => {
                last_error = format!("rate limited by {} (HTTP {})", source.id(), r.status);
                let base = source.rate_limit_backoff().saturating_mul(1 << attempt);
                base.max(retry_after(&r, clock.now_ms()).unwrap_or_default())
            }
            Ok(r) if (500..600).contains(&r.status) => {
                last_error = format!("HTTP {} from {}", r.status, req.url);
                SERVER_ERROR_BACKOFF
                    .max(source.min_interval())
                    .saturating_mul(1 << attempt)
                    .max(retry_after(&r, clock.now_ms()).unwrap_or_default())
            }
            Ok(r) => return Outcome::Response(r),
            Err(e) if e.retryable() => {
                last_error = format!("{e} ({})", req.url);
                SERVER_ERROR_BACKOFF.max(source.min_interval()).saturating_mul(1 << attempt)
            }
            Err(e) => return Outcome::Failed(format!("{e} ({})", req.url)),
        };
        if attempt + 1 == MAX_ATTEMPTS {
            break;
        }
        c.retries += 1;
        let wait = jitter(wait.min(MAX_BACKOFF), clock.now_ms(), attempt);
        tracing::warn!(source = source.id(), attempt = attempt + 1, wait_s = wait.as_secs(), error = %last_error, "catalog fetch failed, retrying");
        clock.sleep(wait).await;
    }
    Outcome::Failed(format!("{last_error} after {MAX_ATTEMPTS} attempts"))
}

impl Catalog {
    /// Import one source. Returns `Err` only for database problems, a disabled source or a concurrent run; feed
    /// problems end the run with status `failed`/`incomplete` (see [`ImportReport`]).
    pub async fn import<F, C, D>(
        &self,
        fetcher: &F,
        clock: &C,
        db: &D,
        source: Source,
        opts: ImportOptions,
    ) -> Result<ImportReport>
    where
        F: Fetcher + ?Sized,
        C: Clock + ?Sized,
        D: WriteDb,
    {
        if !self.config.is_enabled(source) {
            return Err(CatalogError::SourceDisabled(source));
        }
        let started = clock.now_ms();
        let limited = opts.limit.is_some() || opts.max_pages.is_some();
        let run = db.write(move |c| store::begin_run(c, source, started, limited)).await?;
        tracing::info!(source = source.id(), run = run.run_id, "catalog import started");
        let mut c = Counters::default();
        let result = if source == Source::Oss {
            self.import_oss(clock, db, run.run_id, run.prev_complete_seen.is_some(), &mut c).await
        } else {
            self.import_http(fetcher, clock, db, source, run.run_id, run.prev_complete_seen.is_some(), opts, &mut c)
                .await
        };
        let (reached_end, error, truncated) = match result {
            Ok(r) => r,
            // Database errors abort the run; record what we can and propagate.
            Err(e) => {
                let msg = e.to_string();
                let order = self.config.dedup_order.clone();
                let now = clock.now_ms();
                let _ = db
                    .write(move |conn| {
                        store::finish_run(
                            conn,
                            Finish {
                                run_id: run.run_id,
                                source,
                                now,
                                reached_end: false,
                                limited,
                                error: Some(msg),
                                truncated: None,
                                prev_complete_seen: run.prev_complete_seen,
                                requests: 0,
                                retries: 0,
                                dedup_order: order,
                            },
                        )
                    })
                    .await;
                return Err(e);
            }
        };
        let now = clock.now_ms();
        let order = self.config.dedup_order.clone();
        let fin = Finish {
            run_id: run.run_id,
            source,
            now,
            reached_end,
            limited,
            error: error.clone(),
            truncated,
            prev_complete_seen: run.prev_complete_seen,
            // Attempts that did not produce a stored page (the final failure, if any).
            requests: c.requests - c.stored_requests,
            retries: c.retries - c.stored_retries,
            dedup_order: order,
        };
        let summary = db.write(move |conn| store::finish_run(conn, fin)).await?;
        let report = ImportReport {
            run_id: run.run_id,
            source,
            status: summary.status,
            complete: summary.complete,
            pages: c.pages,
            not_modified_pages: c.not_modified,
            requests: c.requests,
            retries: c.retries,
            seen: summary.seen,
            inserted: c.inserted,
            updated: c.updated,
            unchanged: c.unchanged,
            rejected: c.rejected,
            hidden: summary.hidden,
            note: summary.note,
            error: summary.error,
            duration_ms: now - started,
        };
        tracing::info!(
            source = source.id(), run = report.run_id, status = %report.status, seen = report.seen,
            inserted = report.inserted, updated = report.updated, hidden = report.hidden, pages = report.pages,
            "catalog import finished"
        );
        Ok(report)
    }

    /// Import every enabled source, one after another (each source's failure is reported, not fatal).
    pub async fn import_enabled<F, C, D>(
        &self,
        fetcher: &F,
        clock: &C,
        db: &D,
        opts: ImportOptions,
    ) -> Vec<Result<ImportReport>>
    where
        F: Fetcher + ?Sized,
        C: Clock + ?Sized,
        D: WriteDb,
    {
        let mut out = Vec::new();
        for s in self.config.sources.clone() {
            out.push(self.import(fetcher, clock, db, s, opts).await);
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    async fn import_http<F, C, D>(
        &self,
        fetcher: &F,
        clock: &C,
        db: &D,
        source: Source,
        run_id: i64,
        has_complete_sync: bool,
        opts: ImportOptions,
        c: &mut Counters,
    ) -> Result<(bool, Option<String>, Option<String>)>
    where
        F: Fetcher + ?Sized,
        C: Clock + ?Sized,
        D: WriteDb,
    {
        let adapter = sources::adapter(source, &self.config).ok_or(CatalogError::SourceDisabled(source))?;
        let mut pacer = Pacer { interval_ms: source.min_interval().as_millis() as i64, last: None };
        let mut page = adapter.first(clock.now_ms());
        let mut rank_base = 0u32;
        let mut reported_total: Option<u64> = None;
        let mut truncated: Option<String> = None;
        let mut seen_keys = std::collections::HashSet::new();
        let mut repeated_pages = 0u32;
        let mut repeated_feed: Option<usize> = None;
        loop {
            if opts.max_pages.is_some_and(|m| c.pages >= m) || opts.limit.is_some_and(|l| c.items >= l) {
                return Ok((false, None, truncated));
            }
            if c.pages >= MAX_PAGES_PER_RUN {
                let note = format!("stopped after {MAX_PAGES_PER_RUN} pages: the feed does not end");
                return Ok((false, None, Some(note)));
            }
            if !seen_keys.insert(page.key.clone()) {
                return Ok((false, Some(format!("paging loop at {}", page.key)), truncated));
            }
            let key = page.key.clone();
            let cached = db.write(move |conn| store::cached_page(conn, source, &key)).await?;
            let mut req = adapter.request(&page);
            req.headers.push(("User-Agent".into(), self.config.user_agent.clone()));
            if let Some(cp) = &cached {
                if let Some(e) = &cp.etag {
                    req.headers.push(("If-None-Match".into(), e.clone()));
                }
                if let Some(lm) = &cp.last_modified {
                    req.headers.push(("If-Modified-Since".into(), lm.clone()));
                }
            }
            let (requests_before, retries_before) = (c.requests, c.retries);
            let resp = match fetch_with_retry(fetcher, clock, &mut pacer, source, req, c).await {
                Outcome::Response(r) => r,
                Outcome::Failed(e) => return Ok((false, Some(e), truncated)),
            };
            let (requests, retries) = (c.requests - requests_before, c.retries - retries_before);
            let now = clock.now_ms();
            let info: PageInfo = match resp.status {
                304 => {
                    let Some(cp) = cached else {
                        return Ok((
                            false,
                            Some(format!("{} answered 304 without a cached page", page.url)),
                            truncated,
                        ));
                    };
                    let n = NotModified {
                        source,
                        run_id,
                        now,
                        item_ids: cp.item_ids,
                        reported_total: cp.info.reported_total,
                        requests,
                        retries,
                        dedup_order: self.config.dedup_order.clone(),
                    };
                    let stats = db.write(move |conn| store::apply_not_modified(conn, n)).await?;
                    c.stored_requests += requests;
                    c.stored_retries += retries;
                    c.pages += 1;
                    c.not_modified += 1;
                    c.unchanged += stats.unchanged;
                    c.items += cp.info.item_count;
                    cp.info
                }
                200 | 201 => {
                    let parsed = match adapter.parse(&page, &resp.body) {
                        Ok(p) => p,
                        Err(e) => return Ok((false, Some(format!("{}: {e}", page.url)), truncated)),
                    };
                    if parsed.info.reported_total.is_some() {
                        reported_total = parsed.info.reported_total;
                    }
                    let ctx_total = reported_total;
                    let mut games = Vec::with_capacity(parsed.items.len());
                    let mut rejected = 0u32;
                    let budget = opts.limit.map(|l| l.saturating_sub(c.items));
                    for (i, raw) in parsed.items.iter().enumerate() {
                        if budget.is_some_and(|b| i >= b) {
                            break;
                        }
                        let rank = rank_base.saturating_add(u32::try_from(i).unwrap_or(u32::MAX)).saturating_add(1);
                        let ctx = ItemCtx { rank, reported_total: ctx_total, config: &self.config };
                        match adapter.normalize(raw, &ctx) {
                            Ok(g) => games.push(g),
                            Err(reason) => {
                                rejected += 1;
                                tracing::debug!(source = source.id(), %reason, "catalog record rejected");
                            }
                        }
                    }
                    c.items += parsed.items.len().min(budget.unwrap_or(usize::MAX));
                    let w = PageWrite {
                        source,
                        run_id,
                        now,
                        page_key: page.key.clone(),
                        etag: resp.header("etag").map(str::to_owned),
                        last_modified: resp.header("last-modified").map(str::to_owned),
                        info: parsed.info.clone(),
                        games,
                        rejected,
                        requests,
                        retries,
                        has_complete_sync,
                        dedup_order: self.config.dedup_order.clone(),
                    };
                    let stats = db.write(move |conn| store::apply_page(conn, w)).await?;
                    c.stored_requests += requests;
                    c.stored_retries += retries;
                    c.pages += 1;
                    c.inserted += stats.inserted;
                    c.updated += stats.updated;
                    c.unchanged += stats.unchanged;
                    c.rejected += rejected + stats.refused;
                    let stored = stats.inserted + stats.updated + stats.unchanged;
                    let same_feed = repeated_feed == Some(page.feed);
                    repeated_feed = Some(page.feed);
                    repeated_pages = match (stored > 0 && stats.repeated == stored, same_feed) {
                        (true, true) => repeated_pages + 1,
                        (true, false) => 1,
                        (false, _) => 0,
                    };
                    if repeated_pages >= MAX_REPEATED_PAGES {
                        let note = format!(
                            "the feed repeats pages: {repeated_pages} pages in a row listed only games already seen in this run (stopped at {})",
                            page.url
                        );
                        return Ok((false, None, Some(note)));
                    }
                    parsed.info
                }
                s if adapter.is_end_status(&page, s) => return Ok((true, None, truncated)),
                s => {
                    let hint = String::from_utf8_lossy(&resp.body[..resp.body.len().min(200)]).into_owned();
                    return Ok((false, Some(format!("HTTP {s} from {}: {}", page.url, hint.trim())), truncated));
                }
            };
            if let Some(t) = &info.truncated {
                truncated = Some(t.clone());
            }
            rank_base = rank_base.saturating_add(u32::try_from(info.item_count).unwrap_or(u32::MAX));
            match adapter.next(&page, &info, clock.now_ms()) {
                Some(n) => page = n,
                None => return Ok((true, None, truncated)),
            }
        }
    }

    async fn import_oss<C, D>(
        &self,
        clock: &C,
        db: &D,
        run_id: i64,
        has_complete_sync: bool,
        c: &mut Counters,
    ) -> Result<(bool, Option<String>, Option<String>)>
    where
        C: Clock + ?Sized,
        D: WriteDb,
    {
        let manifest = match sources::oss::load_manifest(&self.config.oss) {
            Ok(m) => m,
            Err(e) => return Ok((false, Some(e.to_string()), None)),
        };
        let mut games = Vec::new();
        let mut rejected = 0u32;
        for (i, e) in manifest.games.iter().filter(|e| e.importable(&self.config.oss)).enumerate() {
            let ctx = ItemCtx { rank: i as u32 + 1, reported_total: None, config: &self.config };
            match sources::oss::normalize_entry(e, &ctx) {
                Ok(g) => games.push(g),
                Err(reason) => {
                    rejected += 1;
                    tracing::warn!(slug = %e.slug, %reason, "oss manifest entry rejected");
                }
            }
        }
        c.items = games.len();
        let now = clock.now_ms();
        let w = PageWrite {
            source: Source::Oss,
            run_id,
            now,
            page_key: "manifest".into(),
            etag: None,
            last_modified: None,
            info: PageInfo { item_count: games.len(), ..PageInfo::default() },
            games,
            rejected,
            requests: 0,
            retries: 0,
            has_complete_sync,
            dedup_order: self.config.dedup_order.clone(),
        };
        let stats = db.write(move |conn| store::apply_page(conn, w)).await?;
        c.pages = 1;
        c.inserted = stats.inserted;
        c.updated = stats.updated;
        c.unchanged = stats.unchanged;
        c.rejected = rejected + stats.refused;
        Ok((true, None, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_parsing() {
        let r = |v: &str| FetchResponse { status: 429, headers: vec![("Retry-After".into(), v.into())], body: vec![] };
        assert_eq!(retry_after(&r("120"), 0), Some(Duration::from_secs(120)));
        let now = crate::date::parse_rfc2822("Wed, 12 Nov 2025 12:34:52 GMT").unwrap();
        assert_eq!(retry_after(&r("Wed, 12 Nov 2025 12:35:52 GMT"), now), Some(Duration::from_secs(60)));
        assert_eq!(retry_after(&r("soon"), 0), None);
    }

    #[test]
    fn jitter_stays_within_bounds() {
        for a in 0..5 {
            for t in [0i64, 1, 1_762_950_892_000, i64::MAX / 3] {
                let j = jitter(Duration::from_secs(100), t, a);
                assert!(j >= Duration::from_secs(80) && j <= Duration::from_secs(120), "{j:?}");
            }
        }
    }

    #[test]
    fn cloudflare_1015_is_rate_limiting() {
        let body = b"<html><title>Access denied | gamemonetize.com used Cloudflare to restrict access</title>error code: 1015</html>".to_vec();
        assert!(is_rate_limit_page(&FetchResponse { status: 200, headers: vec![], body }));
        assert!(!is_rate_limit_page(&FetchResponse { status: 200, headers: vec![], body: b"[]".to_vec() }));
    }
}
