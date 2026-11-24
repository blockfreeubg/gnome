//! Which game embeds may be framed (WAVE-C D4), the per-game wrapper document `/play-frame/<slug>` (D2), and the
//! pending/refused host report behind `/admin/diagnostics` → `games.embed_hosts`.
//!
//! Catalog data never adds a framable host by itself: an iframe game is framed only when its embed URL's host is a
//! fixed embed host of an enabled source or a developer host the operator approved (`GNOME_GAMES_EMBED_HOSTS`), never
//! this server's app or proxy host. The wrapper's `frame-src` names that one origin, computed per request.

use std::sync::RwLock;

use gnome_catalog::url::Url;
use gnome_catalog::{GameDetail, Source};
use serde::Serialize;

use super::oss::OssBuilds;
use crate::config::Config;

/// The inner frame's sandbox for network and approved developer embeds.
pub const EMBED_SANDBOX: &str = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox \
                                 allow-forms allow-pointer-lock allow-orientation-lock";
/// The inner (and outer) frame's `allow` for network and approved developer embeds.
pub const EMBED_ALLOW: &str = "fullscreen; autoplay; gamepad; accelerometer; gyroscope";
/// The wrapper's only style.
pub const WRAPPER_STYLE: &str = crate::security::csp::WRAPPER_STYLE;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct FrameReport {
    /// `Source::embed_hosts` of the enabled sources.
    pub fixed: Vec<String>,
    /// `GNOME_GAMES_EMBED_HOSTS` entries that visible games embed from.
    pub approved_in_use: Vec<String>,
    /// Hosts visible iframe games embed from that are neither fixed nor approved: their games are
    /// `embed_allowed: false`.
    pub pending: Vec<HostCount>,
    /// Iframe games whose embed host is an app or proxy origin host: never framed (a poisoned record, D4).
    pub refused: Vec<HostCount>,
    pub computed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HostCount {
    pub host: String,
    pub games: u64,
}

/// What `/play-frame/<slug>` renders for one game.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameTarget {
    /// The `src` of the inner iframe: the rendered embed URL, or `<proxy origin>/oss/<slug>/<entry>`.
    pub src: String,
    /// The wrapper's `frame-src` value (`https://<host>[:port]`, or `<proxy origin>/oss/<slug>/`).
    pub frame_source: String,
    pub sandbox: &'static str,
    pub allow: String,
    pub title: String,
}

#[derive(Debug)]
pub struct FramePolicy {
    fixed: Vec<String>,
    approved: Vec<String>,
    /// `host` and `host:port` of every app and proxy origin this server knows.
    own: Vec<String>,
    proxy_origin: Option<String>,
    report: RwLock<FrameReport>,
}

/// `host` and `host:port` forms of an origin (`scheme://host[:port]`).
fn host_forms(origin: &str) -> Vec<String> {
    let Some((_, authority)) = origin.split_once("://") else { return Vec::new() };
    let authority = authority.trim_end_matches('/').to_ascii_lowercase();
    match authority.rsplit_once(':') {
        Some((host, port)) if !authority.ends_with(']') && port.bytes().all(|b| b.is_ascii_digit()) => {
            vec![host.to_string(), authority.clone()]
        }
        _ => vec![authority],
    }
}

impl FramePolicy {
    pub fn new(config: &Config) -> Self {
        let mut fixed: Vec<String> =
            config.catalog.sources.iter().flat_map(|s| s.embed_hosts().iter().map(|h| (*h).to_string())).collect();
        fixed.sort();
        fixed.dedup();
        let mut own: Vec<String> = config
            .proxy
            .app_origins()
            .iter()
            .chain(&config.public_origins)
            .map(String::as_str)
            .chain(config.proxy.origin())
            .flat_map(host_forms)
            .collect();
        own.sort();
        own.dedup();
        let report = FrameReport { fixed: fixed.clone(), ..FrameReport::default() };
        Self {
            fixed,
            approved: config.games_embed_hosts.clone(),
            own,
            proxy_origin: config.proxy.isolated().then(|| config.proxy.origin().map(str::to_string)).flatten(),
            report: RwLock::new(report),
        }
    }

    /// `host[:port]` of an iframe game's embed URL when it may be framed.
    fn iframe_origin(&self, embed_url: &str) -> Option<(Url, String)> {
        let url = Url::parse(embed_url)?;
        if url.scheme != "https" || !url.has_plain_path() {
            return None;
        }
        let authority = match url.port {
            Some(p) => format!("{}:{p}", url.host),
            None => url.host.clone(),
        };
        if self.own.iter().any(|o| *o == url.host || *o == authority) {
            return None;
        }
        let fixed = self.fixed.contains(&authority);
        let approved = url.port.is_none() && self.approved.contains(&url.host);
        (fixed || approved).then_some((url, authority))
    }

    /// Whether this game may be framed (D4). Iframe games: the embed URL parses with the crate's strict `Url`, is
    /// `https:`, has a plain path ([`Url::has_plain_path`]) and its host (and port) is a fixed host of an enabled
    /// source or an approved host, never an app or proxy origin host. `selfhost` games: `source = oss` and a served
    /// build (its URL is rendered here, never taken from the record). `link`: never.
    pub fn allows(&self, game: &GameDetail, oss: &OssBuilds) -> bool {
        self.target(game, oss).is_some()
    }

    /// `allows` plus the attributes of the inner frame; `None` when not allowed.
    pub fn target(&self, game: &GameDetail, oss: &OssBuilds) -> Option<FrameTarget> {
        let title = game.summary.title.clone();
        match game.embed_kind.as_str() {
            "iframe" => {
                let (_, authority) = self.iframe_origin(&game.embed_url)?;
                Some(FrameTarget {
                    src: game.embed_url.clone(),
                    frame_source: format!("https://{authority}"),
                    sandbox: EMBED_SANDBOX,
                    allow: EMBED_ALLOW.to_string(),
                    title,
                })
            }
            "selfhost" if game.summary.source == Source::Oss => {
                let proxy = self.proxy_origin.as_deref()?;
                let build = oss.get(&game.summary.slug)?;
                let sandbox = match (build.isolated, build.pointer_lock) {
                    (true, true) => "allow-scripts allow-pointer-lock",
                    (true, false) => "allow-scripts",
                    (false, true) => "allow-scripts allow-same-origin allow-forms allow-pointer-lock",
                    (false, false) => "allow-scripts allow-same-origin allow-forms",
                };
                let allow = if build.gamepad { "autoplay; gamepad" } else { "autoplay" };
                Some(FrameTarget {
                    src: format!("{proxy}/oss/{}/{}", build.slug, build.entry),
                    frame_source: format!("{proxy}/oss/{}/", build.slug),
                    sandbox,
                    allow: allow.to_string(),
                    title,
                })
            }
            _ => None,
        }
    }

    /// Recompute the report from the catalog (a reader connection).
    pub fn refresh(
        &self,
        catalog: &gnome_catalog::Catalog,
        conn: &rusqlite::Connection,
        now_ms: i64,
    ) -> Result<FrameReport, gnome_catalog::CatalogError> {
        let counts = catalog.embed_host_counts(conn)?;
        let mut report = FrameReport { fixed: self.fixed.clone(), computed_at: Some(now_ms), ..FrameReport::default() };
        for (host, games) in counts {
            let bare = host.split(':').next().unwrap_or(&host).to_string();
            if self.own.iter().any(|o| *o == host || *o == bare) {
                report.refused.push(HostCount { host, games });
            } else if self.fixed.contains(&host) {
            } else if !host.contains(':') && self.approved.contains(&host) {
                report.approved_in_use.push(host);
            } else {
                report.pending.push(HostCount { host, games });
            }
        }
        *self.report.write().unwrap_or_else(|e| e.into_inner()) = report.clone();
        Ok(report)
    }

    pub fn report(&self) -> FrameReport {
        self.report.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Number of approved hosts (metrics).
    pub fn approved_count(&self) -> usize {
        self.approved.len()
    }
}

/// HTML-attribute escaping of `& < > " '`.
pub fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// The wrapper document (exact).
pub fn render_wrapper(target: &FrameTarget) -> String {
    let title = escape_attr(&target.title);
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{title} (game)</title><style>{WRAPPER_STYLE}</style></head><body><iframe src=\"{src}\" title=\"{title} (game)\" sandbox=\"{sandbox}\" allow=\"{allow}\" allowfullscreen referrerpolicy=\"strict-origin-when-cross-origin\"></iframe></body></html>",
        src = escape_attr(&target.src),
        sandbox = escape_attr(target.sandbox),
        allow = escape_attr(&target.allow),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_host_forms() {
        assert_eq!(host_forms("https://gnome.example.com"), ["gnome.example.com"]);
        assert_eq!(host_forms("http://127.0.0.1:21000"), ["127.0.0.1", "127.0.0.1:21000"]);
    }

    #[test]
    fn wrapper_is_escaped() {
        let t = FrameTarget {
            src: "https://play.gamepix.com/a/embed?sid=1&x=\"".into(),
            frame_source: "https://play.gamepix.com".into(),
            sandbox: EMBED_SANDBOX,
            allow: EMBED_ALLOW.into(),
            title: "Press <Space> & 'go'".into(),
        };
        let html = render_wrapper(&t);
        assert!(html.contains("<title>Press &lt;Space&gt; &amp; &#39;go&#39; (game)</title>"), "{html}");
        assert!(html.contains("src=\"https://play.gamepix.com/a/embed?sid=1&amp;x=&quot;\""), "{html}");
        assert!(html.starts_with("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>"));
        assert!(!html.contains("<script"));
    }
}
