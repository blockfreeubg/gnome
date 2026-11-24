//! `gnome-server catalog …` through the real binary (WAVE-C §4.6, D19): replayed captures, never the network.

use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_gnome-server");
const CAPTURES: [&str; 7] = [
    "gamepix-chess-p1.json",
    "gamepix-chess-p2.json",
    "gamepix-chess-p3.json",
    "gamedistribution-p1.json",
    "gamedistribution-end.json",
    "playgama-p1.json",
    "itch-free-web.xml",
];

fn run(args: &[&str], dir: &Path) -> Output {
    let vars = [
        ("GNOME_DATA_DIR", dir.join("data").display().to_string()),
        ("GNOME_STATIC_DIR", dir.join("static").display().to_string()),
        ("GNOME_LOG", "warn".to_string()),
        ("GNOME_PROXY_ORIGIN", "https://p.gnome.example".to_string()),
        ("GNOME_PUBLIC_ORIGINS", "https://gnome.example".to_string()),
        ("GNOME_CATALOG_SOURCES", "gamepix,gamedistribution,playgama,itchio,js13k".to_string()),
        ("GNOME_GD_PUBLISHER_ID", "0123456789abcdef0123456789abcdef".to_string()),
        ("GNOME_PLAYGAMA_CLID", "test-clid".to_string()),
        ("GNOME_CATALOG_REFRESH_HOURS", "0".to_string()),
        ("GNOME_OSS_FETCH", "manual".to_string()),
    ];
    Command::new(BIN)
        .args(args)
        .env_clear()
        .envs(vars.iter().map(|(k, v)| (*k, v.as_str())))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap()
}

/// The index of WAVE-C §4.6 next to copies of the captures.
fn replay_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/catalog/tests/fixtures");
    let caps = dir.path().join("captures");
    std::fs::create_dir_all(&caps).unwrap();
    for f in CAPTURES.iter().chain(&["js13k-2026.xml"]) {
        std::fs::copy(src.join(f), caps.join(f)).unwrap();
    }
    let index = serde_json::json!({
        "version": 1,
        "note": "Unmodified captures from crates/catalog/tests/fixtures (2026-11-10).",
        "now": "2026-11-10T12:00:00Z",
        "config": {
            "gamepix": { "per_page": 12, "category": "chess" },
            "gamedistribution": { "per_page": 10 },
            "playgama": { "per_page": 10 },
            "itchio": { "max_pages": 1 },
            "js13k": { "first_year": 2026 }
        },
        "sources": {
            "gamepix": [
                { "url_contains": ["/v2/json?", "&page=1&category=chess"], "status": 200, "file": "captures/gamepix-chess-p1.json" },
                { "url_contains": ["/v2/json?", "&page=2&category=chess"], "status": 200, "file": "captures/gamepix-chess-p2.json" },
                { "url_contains": ["/v2/json?", "&page=3&category=chess"], "status": 200, "file": "captures/gamepix-chess-p3.json" }
            ],
            "gamedistribution": [
                { "url_contains": ["catalog.api.gamedistribution.com", "&page=1&"], "status": 200, "file": "captures/gamedistribution-p1.json" },
                { "url_contains": ["catalog.api.gamedistribution.com", "&page=2&"], "status": 200, "file": "captures/gamedistribution-end.json" }
            ],
            "playgama": [{ "url_contains": ["/catalogue/games"], "status": 201, "file": "captures/playgama-p1.json" }],
            "itchio": [{ "url_contains": ["itch.io/games/free/platform-web.xml?page=1"], "status": 200, "file": "captures/itch-free-web.xml" }],
            "js13k": [{ "url_contains": ["js13kgames.com/2026/games.xml"], "status": 200, "file": "captures/js13k-2026.xml" }]
        }
    });
    std::fs::write(dir.path().join("index.json"), serde_json::to_vec_pretty(&index).unwrap()).unwrap();
    dir
}

fn reports(out: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&out.stdout).lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[test]
fn import_replays_each_source_without_the_network() {
    let replay = replay_dir();
    let index = replay.path().join("index.json").display().to_string();
    let data = tempfile::tempdir().unwrap();
    let started = std::time::Instant::now();
    let out = run(&["catalog", "import", "--replay", &index], data.path());
    let all = reports(&out);
    let by = |s: &str| all.iter().find(|r| r["source"] == s).unwrap_or_else(|| panic!("{s}: {all:?}")).clone();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "Playgama's run fails: {stderr}");
    assert_eq!((by("gamepix")["status"].clone(), by("gamepix")["inserted"].clone()), ("complete".into(), 29.into()));
    assert_eq!(by("gamedistribution")["status"], "complete");
    let pg = by("playgama");
    assert_eq!((pg["status"].as_str(), pg["inserted"].as_u64()), (Some("failed"), Some(10)), "{pg}");
    assert!(pg["error"].as_str().unwrap().contains("no fixture for"), "{pg}");
    assert_eq!(pg["retries"], 0, "an unmatched request is never retried");
    assert_eq!((by("itchio")["status"].as_str(), by("itchio")["inserted"].as_u64()), (Some("complete"), Some(36)));
    let js = by("js13k");
    assert_eq!((js["status"].as_str(), js["inserted"].as_u64()), (Some("complete"), Some(317)), "{js}");
    assert!(started.elapsed() < std::time::Duration::from_secs(60), "spacing and back-off cost no real time");
    // Stats, from the same data directory.
    let stats = run(&["catalog", "stats"], data.path());
    assert_eq!(stats.status.code(), Some(0), "{}", String::from_utf8_lossy(&stats.stderr));
    let s: Value = serde_json::from_slice(&stats.stdout).unwrap();
    assert_eq!(s["by_source"]["gamepix"]["total"], 29);
    // Only one source.
    let one = run(&["catalog", "import", "--source", "gamepix", "--replay", &index], data.path());
    assert_eq!(one.status.code(), Some(0));
    assert_eq!(reports(&one).len(), 1);
}

#[test]
fn bad_sources_and_indexes_are_usage_errors() {
    let data = tempfile::tempdir().unwrap();
    assert_eq!(run(&["catalog", "import", "--source", "nope"], data.path()).status.code(), Some(2));
    assert_eq!(run(&["catalog", "import", "--source", "famobi"], data.path()).status.code(), Some(2), "not enabled");
    let replay = replay_dir();
    let index = replay.path().join("index.json");
    let text = std::fs::read_to_string(&index).unwrap().replace("captures/itch-free-web.xml", "../itch.xml");
    std::fs::write(&index, text).unwrap();
    let out = run(&["catalog", "import", "--replay", &index.display().to_string()], data.path());
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("relative paths inside the index directory"));
    assert_eq!(run(&["catalog", "import", "--replay", "/nonexistent/index.json"], data.path()).status.code(), Some(2));
}
