//! The catalog's sources and their fixed properties (ids, hosts, politeness limits).
//!
//! Everything here comes from `docs/research/games-sources.md` (verified 2026-11-09) and the shapes re-checked on
//! 2026-11-10 while building the importers.

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// A catalog source. Stored in `games.source` as [`Source::id`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// GamePix v2 JSON feed (publisher SID; the public `sid=1` is the default). Embeddable.
    GamePix,
    /// GameDistribution catalog feed. Embeddable; needs a registered publisher.
    GameDistribution,
    /// Playgama catalogue API. Embeddable; needs a partner CLID.
    Playgama,
    /// GameMonetize `feed.php`. Embeddable; needs the operator's site registered in the GM dashboard.
    GameMonetize,
    /// Famobi feed. Embeddable; needs an affiliate ID.
    Famobi,
    /// itch.io browse RSS feeds. Discovery / link-out only.
    ItchIo,
    /// js13kGames per-year RSS. Link-out only (framing is blocked by the site).
    Js13k,
    /// Curated open-source games from `oss-games.toml`, self-hosted from the proxy origin.
    Oss,
}

impl Source {
    /// Every source, in a stable order.
    pub const ALL: [Source; 8] = [
        Source::GamePix,
        Source::GameDistribution,
        Source::Playgama,
        Source::GameMonetize,
        Source::Famobi,
        Source::ItchIo,
        Source::Js13k,
        Source::Oss,
    ];

    /// Stable identifier (database value, config value, API value).
    pub const fn id(self) -> &'static str {
        match self {
            Source::GamePix => "gamepix",
            Source::GameDistribution => "gamedistribution",
            Source::Playgama => "playgama",
            Source::GameMonetize => "gamemonetize",
            Source::Famobi => "famobi",
            Source::ItchIo => "itchio",
            Source::Js13k => "js13k",
            Source::Oss => "oss",
        }
    }

    /// Parse an identifier (case-insensitive; a few common aliases are accepted).
    pub fn from_id(s: &str) -> Option<Source> {
        let s = s.trim().to_ascii_lowercase();
        Some(match s.as_str() {
            "gamepix" => Source::GamePix,
            "gamedistribution" | "gd" => Source::GameDistribution,
            "playgama" => Source::Playgama,
            "gamemonetize" | "gm" => Source::GameMonetize,
            "famobi" => Source::Famobi,
            "itchio" | "itch" | "itch.io" => Source::ItchIo,
            "js13k" | "js13kgames" => Source::Js13k,
            "oss" | "opensource" | "open-source" => Source::Oss,
            _ => return None,
        })
    }

    /// Human-readable name used in attributions ("via GamePix").
    pub const fn display_name(self) -> &'static str {
        match self {
            Source::GamePix => "GamePix",
            Source::GameDistribution => "GameDistribution",
            Source::Playgama => "Playgama",
            Source::GameMonetize => "GameMonetize",
            Source::Famobi => "Famobi",
            Source::ItchIo => "itch.io",
            Source::Js13k => "js13kGames",
            Source::Oss => "Open source",
        }
    }

    /// Whether records of this source can be played inside GNOME (iframe or self-hosted). `false` means link-out
    /// only: the UI must open `source_url` in a new tab and never frame it.
    pub const fn playable(self) -> bool {
        !matches!(self, Source::ItchIo | Source::Js13k)
    }

    /// Whether the source requires an operator publisher/affiliate ID (or explicit opt-in) before it may be enabled.
    pub const fn needs_operator_id(self) -> bool {
        matches!(self, Source::GameDistribution | Source::Playgama | Source::GameMonetize | Source::Famobi)
    }

    /// Minimum spacing between two requests to this source (politeness; research §9.1).
    pub const fn min_interval(self) -> Duration {
        match self {
            Source::GamePix | Source::GameDistribution | Source::Famobi => Duration::from_secs(1),
            Source::Js13k => Duration::from_secs(2),
            Source::Playgama => Duration::from_secs(5),
            Source::GameMonetize => Duration::from_secs(10),
            // "<= 2 requests/min" (itch.io answered 429 even at one request per 25 s).
            Source::ItchIo => Duration::from_secs(30),
            Source::Oss => Duration::ZERO,
        }
    }

    /// Base back-off after an HTTP 429 from this source (doubled per attempt, capped).
    pub const fn rate_limit_backoff(self) -> Duration {
        match self {
            Source::ItchIo => Duration::from_secs(150),
            Source::GameMonetize => Duration::from_secs(60),
            _ => Duration::from_secs(5),
        }
    }

    /// Hosts that serve this source's thumbnails (the thumbnail proxy allow-list is derived from these).
    pub const fn thumbnail_hosts(self) -> &'static [&'static str] {
        match self {
            Source::GamePix => &["img.gamepix.com"],
            Source::GameDistribution => &["img.gamedistribution.com"],
            Source::Playgama => &["static.playgama.com"],
            Source::GameMonetize => &["img.gamemonetize.com"],
            Source::Famobi => &["img.cdn.famobi.com"],
            Source::ItchIo => &["img.itch.zone"],
            Source::Js13k => &["play.js13kgames.com"],
            // Self-hosted: thumbnails are relative paths on the proxy origin, never fetched by the thumbnail proxy.
            Source::Oss => &[],
        }
    }

    /// Hosts the importer requests feed pages from (the server's feed client allow-list, WAVE-C §4.8 item 2).
    pub const fn feed_hosts(self) -> &'static [&'static str] {
        match self {
            Source::GamePix => &["feeds.gamepix.com"],
            Source::GameDistribution => &["catalog.api.gamedistribution.com"],
            Source::Playgama => &["widgets.playgama.com"],
            Source::GameMonetize => &["gamemonetize.com"],
            Source::Famobi => &["api.famobi.com"],
            Source::ItchIo => &["itch.io"],
            Source::Js13k => &["js13kgames.com"],
            Source::Oss => &[],
        }
    }

    /// Fixed embed (iframe) hosts of the source (the server's frame policy, WAVE-C D4). Playgama also embeds a few
    /// games from the developers' own hosts, which the operator approves one by one (`GNOME_GAMES_EMBED_HOSTS`).
    pub const fn embed_hosts(self) -> &'static [&'static str] {
        match self {
            Source::GamePix => &["play.gamepix.com"],
            Source::GameDistribution => &["html5.gamedistribution.com"],
            Source::Playgama => &["playgama.com"],
            Source::GameMonetize => &["html5.gamemonetize.co"],
            Source::Famobi => &["play.famobi.com"],
            Source::ItchIo | Source::Js13k | Source::Oss => &[],
        }
    }
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_and_serde_matches() {
        for s in Source::ALL {
            assert_eq!(Source::from_id(s.id()), Some(s));
            assert_eq!(serde_json::to_string(&s).unwrap(), format!("\"{}\"", s.id()));
        }
        assert_eq!(Source::from_id(" Itch.io "), Some(Source::ItchIo));
        assert_eq!(Source::from_id("crazygames"), None);
        assert!(!Source::ItchIo.playable() && !Source::Js13k.playable() && Source::Oss.playable());
    }

    #[test]
    fn every_adapter_requests_its_feed_hosts() {
        let config = crate::CatalogConfig::default();
        for s in Source::ALL {
            let Some(adapter) = crate::sources::adapter(s, &config) else {
                assert!(s.feed_hosts().is_empty());
                continue;
            };
            let first = adapter.first(1_762_776_000_000);
            let url = crate::url::Url::parse(&adapter.request(&first).url).unwrap();
            assert!(s.feed_hosts().contains(&url.host.as_str()), "{s}: {}", url.host);
        }
    }
}
