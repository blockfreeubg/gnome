//! Per-source parsing and normalization of the captured feed responses (tests/fixtures/).

mod common;

use common::{T0, config, fixture, fixture_str};
use gnome_catalog::Source;
use gnome_catalog::categories::Category;
use gnome_catalog::model::{EmbedKind, NewGame, Orientation, ThumbKind};
use gnome_catalog::sources::{self, ItemCtx, PageInfo};

/// Parse a fixture with the source's adapter and normalize every item.
fn normalize(source: Source, file: &str) -> (Vec<NewGame>, Vec<String>, PageInfo) {
    let cfg = config(&[source]);
    let adapter = sources::adapter(source, &cfg).unwrap();
    let page = adapter.first(T0);
    let parsed = adapter.parse(&page, &fixture(file)).unwrap();
    let mut ok = Vec::new();
    let mut rejected = Vec::new();
    for (i, raw) in parsed.items.iter().enumerate() {
        let ctx = ItemCtx { rank: i as u32 + 1, reported_total: parsed.info.reported_total, config: &cfg };
        match adapter.normalize(raw, &ctx) {
            Ok(g) => ok.push(g),
            Err(e) => rejected.push(e),
        }
    }
    (ok, rejected, parsed.info)
}

fn assert_clean(g: &NewGame) {
    for s in [&g.title, &g.description, &g.instructions, &g.attribution] {
        assert!(!s.contains(['<', '\u{0}', '\u{202e}']) || s.contains("<canvas>"), "{s:?}");
        assert!(!s.contains("&amp;") && !s.contains("&ndash;"), "{s:?}");
        assert_eq!(s.trim(), s.as_str());
    }
    assert!(!g.title.is_empty() && g.title.chars().count() <= 120);
    assert!(!g.categories.is_empty() && g.categories.len() <= 3);
    assert!(g.categories.iter().all(|c| !matches!(c.slug(), "girls" | "boys")));
    assert!(serde_json::from_str::<serde_json::Value>(&g.raw).is_ok());
}

#[test]
fn gamepix_feed() {
    let (games, rejected, info) = normalize(Source::GamePix, "gamepix-p1.json");
    assert!(rejected.is_empty(), "{rejected:?}");
    assert_eq!(games.len(), 12);
    assert!(info.next_hint.as_deref().unwrap().contains("page=2"));
    assert!(info.truncated.is_none());
    let g = &games[0];
    assert_eq!((g.source_id.as_str(), g.title.as_str()), ("737HCH", "Prism Match 3D"));
    assert_eq!(g.slug_hint.as_deref(), Some("prism-match-3d"));
    assert_eq!(g.embed_kind, EmbedKind::Iframe);
    assert_eq!(g.embed_url, "https://play.gamepix.com/prism-match-3d/embed?sid={gamepix_sid}");
    assert_eq!(
        g.thumbnail_url.as_deref(),
        Some("https://img.gamepix.com/games/prism-match-3d/cover/prism-match-3d.png?w=320")
    );
    assert_eq!(g.thumbnails[0].w, Some(320));
    assert_eq!(g.thumbnails[1].kind, ThumbKind::Icon);
    assert_eq!(g.categories, [Category::Puzzle]);
    assert_eq!(g.source_categories, ["match-3"]);
    assert_eq!(g.orientation, Some(Orientation::Any));
    assert_eq!(g.published_at, Some(1_762_950_892_000)); // Wed, 12 Nov 2025 12:34:52 GMT
    assert!((g.quality.unwrap() - 0.983_929_32).abs() < 1e-9);
    assert_eq!((g.source_rank, g.mobile, g.developer.as_deref()), (Some(1), None, None));
    assert_eq!(g.attribution, "via GamePix");
    for g in &games {
        assert_clean(g);
    }
}

#[test]
fn gamepix_paging_signals() {
    let cfg = config(&[Source::GamePix]);
    let a = sources::adapter(Source::GamePix, &cfg).unwrap();
    let p1 = a.first(T0);
    let i1 = a.parse(&p1, &fixture("gamepix-chess-p1.json")).unwrap().info;
    let p2 = a.next(&p1, &i1, T0).expect("page 2");
    assert_eq!(p2.number, 2);
    let i2 = a.parse(&p2, &fixture("gamepix-chess-p2.json")).unwrap().info;
    let p3 = a.next(&p2, &i2, T0).expect("page 3");
    let i3 = a.parse(&p3, &fixture("gamepix-chess-p3.json")).unwrap().info;
    assert_eq!(i3.item_count, 5);
    assert!(i3.truncated.is_none());
    assert!(a.next(&p3, &i3, T0).is_none(), "page 3 is the last");
    // Page 3's body served for page 1: the feed claims 3 pages but ended at 1 → truncated.
    let wrong = a.parse(&p1, &fixture("gamepix-chess-p3.json")).unwrap().info;
    assert!(wrong.truncated.unwrap().contains("last_page_url says 3"));
}

#[test]
fn gamedistribution_feed() {
    let (games, rejected, _) = normalize(Source::GameDistribution, "gamedistribution-p1.json");
    assert!(rejected.is_empty(), "{rejected:?}");
    assert_eq!(games.len(), 10);
    let g = &games[0];
    assert_eq!(g.source_id, "569b64ffae3b4021ac9dda1fd78cd4e0");
    assert_eq!(g.title, "Flower Sort Adventure");
    assert!(g.description.starts_with("Step into a colorful world"), "leading newline trimmed");
    assert!(g.instructions.contains("\n- Match three identical flowers"), "{}", g.instructions);
    assert_eq!(
        g.embed_url,
        "https://html5.gamedistribution.com/569b64ffae3b4021ac9dda1fd78cd4e0/?gd_sdk_referrer_url={page_url}"
    );
    assert_eq!(
        g.thumbnail_url.as_deref(),
        Some("https://img.gamedistribution.com/569b64ffae3b4021ac9dda1fd78cd4e0-512x384.jpg"),
        "512x384 preferred"
    );
    assert_eq!(g.thumbnails.len(), 3);
    assert_eq!(g.tags, ["flowers", "sorting", "match3"]);
    assert_eq!(g.flags, ["kids_friendly", "no_blood"]);
    assert_eq!(g.categories, [Category::Puzzle]);
    assert_eq!((g.width, g.height, g.mobile), (Some(800), Some(600), Some(false)));
    assert_eq!(g.orientation, Some(Orientation::Landscape));
    // A portrait game (1080x1920).
    let p = games.iter().find(|g| g.source_id == "4b341fd24881401294b101216e152521").unwrap();
    assert_eq!(p.orientation, Some(Orientation::Portrait));
    // ".IO" + "Strategy" → multiplayer, io, strategy
    let io = games.iter().find(|g| g.source_id == "c1aa94c36da649ba94e237c62f144001").unwrap();
    assert_eq!(io.categories, [Category::Multiplayer, Category::Strategy, Category::Io]);
    for g in &games {
        assert_clean(g);
        assert_eq!(g.developer, None);
    }
    let (end, _, info) = normalize(Source::GameDistribution, "gamedistribution-end.json");
    assert!(end.is_empty());
    assert_eq!(info.item_count, 0);
}

#[test]
fn playgama_catalogue() {
    let (games, rejected, info) = normalize(Source::Playgama, "playgama-p1.json");
    assert!(rejected.is_empty(), "{rejected:?}");
    assert_eq!(games.len(), 10);
    assert_eq!(info.reported_total, Some(2865));
    let g = &games[0];
    assert_eq!((g.source_id.as_str(), g.title.as_str()), ("97426", "Piece of Cake: Merge & Bake"));
    assert_eq!(g.slug_hint.as_deref(), Some("piece-of-cake-merge--bake"));
    assert_eq!(g.embed_url, "https://playgama.com/export/game/piece-of-cake-merge--bake?clid={playgama_clid}");
    assert_eq!(g.source_url.as_deref(), Some("https://playgama.com/game/piece-of-cake-merge--bake"));
    assert_eq!(g.categories[0], Category::Puzzle);
    assert_eq!((g.mobile, g.orientation), (Some(true), Some(Orientation::Landscape)));
    assert!(g.description.contains("\n\nControls:"), "paragraphs kept");
    assert_eq!(g.quality, Some(1.0));
    assert!(g.thumbnail_url.as_deref().unwrap().starts_with("https://static.playgama.com/"));
    // A game embedded from its developer's own host.
    let ext = games.iter().find(|g| g.source_id == "44").unwrap();
    assert_eq!(ext.embed_url, "https://deadlydescent.net/export?clid={playgama_clid}");
    // Brand knock-off → ip_risk.
    let pvz = games.iter().find(|g| g.source_id == "119616").unwrap();
    assert_eq!(pvz.ip_risk_term.as_deref(), Some("plants vs zombies"));
    // Gendered genres are dropped from the stored labels and never become categories.
    let tb = games.iter().find(|g| g.source_id == "90498").unwrap();
    assert!(!tb.source_categories.iter().any(|c| c == "girls"));
    assert_eq!(tb.categories, [Category::Casual]);
    for g in &games {
        assert_clean(g);
    }
}

#[test]
fn gamemonetize_feed() {
    let (games, rejected, _) = normalize(Source::GameMonetize, "gamemonetize-p1.json");
    assert!(rejected.is_empty(), "{rejected:?}");
    assert_eq!(games.len(), 10);
    let g = &games[0];
    assert_eq!(g.source_id, "jfquw19x7ayem6ybhl5ixivz2fkhxu31", "the URL hash, not the endpoint-specific id");
    assert_eq!(g.title, "Police Department 3D");
    assert!(g.description.contains("budget – become"), "&ndash; decoded: {}", g.description);
    assert_eq!(g.embed_url, "https://html5.gamemonetize.co/jfquw19x7ayem6ybhl5ixivz2fkhxu31/");
    assert!(!g.tags.iter().any(|t| t.contains("free-games") || t == "h5" || t == "mobile" || t == "webgl"));
    assert!(g.tags.contains(&"police".to_owned()));
    assert_eq!(g.thumbnails[0].w, Some(512));
    let drift = games.iter().find(|g| g.title.starts_with("Drift City")).unwrap();
    assert_eq!(drift.title, "Drift City Car Driving Games", "whitespace collapsed");
    assert_eq!(drift.categories[0], Category::Racing);
    let girls = games.iter().find(|g| g.title == "Strike a Pose").unwrap();
    assert_eq!(girls.categories[0], Category::Casual, "Girls → casual (research table), label not exposed");
    assert!(!girls.tags.iter().any(|t| t == "girl"));
    for g in &games {
        assert_clean(g);
    }
}

#[test]
fn famobi_feed() {
    let (games, rejected, info) = normalize(Source::Famobi, "famobi.json");
    assert!(rejected.is_empty(), "{rejected:?}");
    assert_eq!((games.len(), info.reported_total), (10, Some(649)));
    let g = &games[0];
    assert_eq!((g.source_id.as_str(), g.title.as_str()), ("gun-spin", "Gun Spin"));
    assert_eq!(g.embed_url, "https://play.famobi.com/gun-spin/{famobi_affiliate}");
    assert_eq!(g.published_at, Some(gnome_catalog::date::days_from_civil(2026, 10, 28) * gnome_catalog::date::DAY_MS));
    assert_eq!((g.mobile, g.orientation), (Some(true), Some(Orientation::Any)));
    assert_eq!(g.thumbnails[0].w, Some(320));
    let tycoon = games.iter().find(|g| g.source_id == "hero-making-tycoon").unwrap();
    assert_eq!(tycoon.categories, [Category::Action, Category::Simulation, Category::Idle]);
    for g in &games {
        assert_clean(g);
    }
}

#[test]
fn itch_feed_is_link_out() {
    let (games, rejected, info) = normalize(Source::ItchIo, "itch-free-web.xml");
    assert!(rejected.is_empty(), "{rejected:?}");
    assert_eq!((games.len(), info.item_count), (36, 36));
    let g = games.iter().find(|g| g.title == "Season Shift").unwrap();
    assert_eq!(g.source_id, "emlise.itch.io/seasonshift");
    assert_eq!((g.embed_kind, g.playable()), (EmbedKind::Link, false));
    assert_eq!(g.source_url.as_deref(), Some("https://emlise.itch.io/seasonshift"));
    assert_eq!(g.developer.as_deref(), Some("emlise"));
    assert_eq!(g.developer_url.as_deref(), Some("https://emlise.itch.io"));
    assert_eq!(g.description, "Shift the world");
    assert_eq!(g.source_categories, ["Puzzle"]);
    assert_eq!(g.categories[0], Category::Puzzle);
    assert_eq!(g.attribution, "by emlise on itch.io");
    assert!(g.published_at.is_some() && g.source_updated_at.is_some());
    for g in &games {
        assert_clean(g);
        assert!(!g.playable());
    }
}

#[test]
fn js13k_feeds_are_link_out() {
    for (file, n) in [("js13k-2012.xml", 62), ("js13k-2026.xml", 317)] {
        let (games, rejected, _) = normalize(Source::Js13k, file);
        assert!(rejected.is_empty(), "{file}: {rejected:?}");
        assert_eq!(games.len(), n, "{file}");
        for g in &games {
            assert_clean(g);
            assert_eq!(g.embed_kind, EmbedKind::Link);
            assert!(g.source_url.as_deref().unwrap().starts_with("https://js13kgames.com/"));
            assert!(g.thumbnail_url.as_deref().unwrap().starts_with("https://play.js13kgames.com/"));
        }
    }
    let (games, _, _) = normalize(Source::Js13k, "js13k-2026.xml");
    let g = &games[0];
    assert_eq!((g.source_id.as_str(), g.title.as_str()), ("oh-no-my-rainbow", "Oh No My Rainbow!"));
    assert_eq!(g.developer.as_deref(), Some("Emre Guneyler"));
    assert_eq!(g.attribution, "by Emre Guneyler · js13kGames 2026");
    assert_eq!(g.tags, ["js13k-2026"]);
    let k = games.iter().find(|g| g.source_id == "unicorns-sitter").unwrap();
    assert_eq!(k.developer.as_deref(), Some("Kapıkulu"), "non-ASCII author kept");
}

#[test]
fn oss_manifest_entries() {
    let cfg = config(&[Source::Oss]);
    let m = sources::oss::load_manifest(&cfg.oss).unwrap();
    let enabled: Vec<_> = m.games.iter().filter(|e| e.importable(&cfg.oss)).collect();
    // WAVE-C D5: every enabled entry carries the review of its pinned commit; the reviews left 5 of 11.
    assert_eq!(enabled.len(), 5);
    for e in m.games.iter().filter(|e| e.enabled) {
        assert!(!e.local, "the built-in manifest has no local entry");
        let reviewed = e.reviewed.as_deref().unwrap_or("");
        assert!(
            reviewed.len() > 12 && reviewed.as_bytes()[4] == b'-' && reviewed.contains(": "),
            "{}: {reviewed:?}",
            e.slug
        );
        assert!(e.servable(), "{}", e.slug);
    }
    for slug in ["particle-clicker", "javascript-chess", "a-blast"] {
        let e = m.games.iter().find(|e| e.slug == slug).unwrap();
        assert!(!e.enabled && e.notes.as_deref().unwrap().contains("no third-party loads"), "{slug}");
    }
    assert!(m.games.iter().find(|e| e.slug == "bullethell").unwrap().isolated);
    let ctx = ItemCtx { rank: 1, reported_total: None, config: &cfg };
    let g = sources::oss::normalize_entry(enabled[0], &ctx).unwrap();
    assert_eq!((g.source_id.as_str(), g.title.as_str()), ("2048", "2048"));
    assert_eq!(g.embed_kind, EmbedKind::Selfhost);
    assert_eq!(g.embed_url, "/oss/2048/index.html");
    assert_eq!(g.thumbnail_url.as_deref(), Some("/oss/2048/meta/apple-touch-icon.png"));
    assert_eq!(g.license.as_deref(), Some("MIT"));
    assert_eq!(g.attribution, "MIT · Copyright (c) 2014 Gabriele Cirulli");
    assert_eq!(g.source_url.as_deref(), Some("https://github.com/gabrielecirulli/2048"));
    assert_eq!(g.developer_url.as_deref(), Some("https://github.com/gabrielecirulli"));
    for e in &enabled {
        let g = sources::oss::normalize_entry(e, &ctx).unwrap();
        assert_clean(&g);
        assert!(g.ip_risk_term.is_none(), "{} matched the blocklist", g.title);
        // Round trip through the stored raw record.
        assert_eq!(sources::oss::normalize_raw(&g.raw, &ctx).unwrap(), g);
    }
    // With builds required, nothing is importable from an empty directory.
    let mut strict = cfg.oss.clone();
    strict.require_builds = true;
    strict.builds_dir = std::env::temp_dir().join("gnome-catalog-no-builds-here");
    assert!(m.games.iter().all(|e| !e.importable(&strict)));
}

#[test]
fn renormalizing_raw_records_is_stable() {
    // What reapply_rules relies on: normalize(raw) is a pure function of the stored raw record.
    for (source, file) in [
        (Source::GamePix, "gamepix-p1.json"),
        (Source::GameDistribution, "gamedistribution-p1.json"),
        (Source::GameMonetize, "gamemonetize-p1.json"),
        (Source::Famobi, "famobi.json"),
        (Source::ItchIo, "itch-free-web.xml"),
    ] {
        let cfg = config(&[source]);
        let (games, _, _) = normalize(source, file);
        for g in games {
            let ctx = ItemCtx { rank: g.source_rank.unwrap_or(1), reported_total: None, config: &cfg };
            let again = sources::renormalize(source, &g.raw, &ctx).unwrap();
            assert_eq!(again.hashes(), g.hashes(), "{source} {}", g.source_id);
        }
    }
    let _ = fixture_str("gamepix-badsid.json");
}
