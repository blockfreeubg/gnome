//! The OSS fetch's extraction (WAVE-C D6, §4.7): hostile archives generated in memory, install and replace, the old
//! build kept on failure, and which entries may be fetched at all. The download itself (codeload.github.com through
//! the SafeClient) is only covered by the ignored online test.

use std::io::Write;
use std::path::Path;

use gnome_catalog::sources::oss::{OssEntry, parse_manifest};
use gnome_server::games::oss::{OssBuilds, install};
use tar::{EntryType, Header};

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

fn entry() -> OssEntry {
    parse_manifest(
        r#"[[games]]
slug = "demo"
title = "Demo"
repo = "https://github.com/example/demo"
commit = "0123456789abcdef0123456789abcdef01234567"
license = "MIT"
license_file = "LICENSE"
author = "Example"
entry = "index.html"
build = "static"
categories = ["puzzle"]
enabled = true
reviewed = "2026-11-23: test"
"#,
    )
    .unwrap()
    .games
    .remove(0)
}

/// A tar with raw headers (names written byte for byte, so hostile paths survive), gzip'd.
struct Tar(tar::Builder<Vec<u8>>);

impl Tar {
    fn new() -> Self {
        Self(tar::Builder::new(Vec::new()))
    }

    fn raw(&mut self, kind: EntryType, name: &[u8], data: &[u8]) -> &mut Self {
        let mut h = Header::new_gnu();
        h.as_old_mut().name[..name.len()].copy_from_slice(name);
        h.set_entry_type(kind);
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        self.0.append(&h, data).unwrap();
        self
    }

    fn file(&mut self, name: &str, data: &[u8]) -> &mut Self {
        self.raw(EntryType::Regular, name.as_bytes(), data)
    }

    fn sized(&mut self, kind: EntryType, name: &str, size: u64) -> &mut Self {
        let mut h = Header::new_gnu();
        h.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
        h.set_entry_type(kind);
        h.set_size(size);
        h.set_cksum();
        self.0.append(&h, std::io::repeat(b'a').take_bytes(size)).unwrap();
        self
    }

    fn game(&mut self) -> &mut Self {
        self.raw(EntryType::Directory, b"demo-0123/", b"")
            .file("demo-0123/index.html", b"<!doctype html>")
            .file("demo-0123/LICENSE", b"MIT")
            .file("demo-0123/js/a.js", b"1")
    }

    fn gz(&mut self) -> Vec<u8> {
        let tar = std::mem::replace(&mut self.0, tar::Builder::new(Vec::new())).into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }
}

trait TakeBytes: std::io::Read + Sized {
    fn take_bytes(self, n: u64) -> std::io::Take<Self> {
        std::io::Read::take(self, n)
    }
}
impl<R: std::io::Read> TakeBytes for R {}

const BIG: u64 = 1 << 40;

fn installed(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(base: &Path, p: &Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(p).unwrap().flatten() {
            let path = e.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                out.push(path.strip_prefix(base).unwrap().display().to_string());
            }
        }
    }
    walk(dir, dir, &mut out);
    out.sort();
    out
}

#[test]
fn installs_replaces_and_keeps_the_old_build_on_failure() {
    let dir = tempfile::tempdir().unwrap();
    let e = entry();
    let r = install(dir.path(), &e, COMMIT, &Tar::new().game().raw(EntryType::Symlink, b"demo-0123/l", b"").gz(), BIG)
        .unwrap();
    assert_eq!((r.files, r.skipped_links), (3, 1));
    let build = dir.path().join("demo");
    assert_eq!(installed(&build), [".gnome-oss.json", "LICENSE", "index.html", "js/a.js"]);
    let index: serde_json::Value =
        serde_json::from_slice(&std::fs::read(build.join(".gnome-oss.json")).unwrap()).unwrap();
    assert_eq!(index["commit"], COMMIT);
    assert_eq!(index["files"]["LICENSE"].as_str().unwrap().len(), 64);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(build.join("LICENSE")).unwrap().permissions().mode() & 0o777, 0o644);
    }
    // A new commit replaces the build.
    let other = "fedcba9876543210fedcba9876543210fedcba98";
    let mut t = Tar::new();
    t.game().file("demo-0123/new.txt", b"n");
    install(dir.path(), &e, other, &t.gz(), BIG).unwrap();
    assert!(build.join("new.txt").is_file());
    // A failing archive leaves it in place (and no temporary directory behind).
    let err = install(dir.path(), &e, COMMIT, &Tar::new().file("demo-0123/index.html", b"x").gz(), BIG).unwrap_err();
    assert!(err.contains("no license_file"), "{err}");
    assert!(build.join("new.txt").is_file());
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["demo"], "{names:?}");
}

#[test]
fn hostile_archives_are_refused() {
    let e = entry();
    let refuse = |archive: Vec<u8>, budget: u64, needle: &str| {
        let dir = tempfile::tempdir().unwrap();
        let err = install(dir.path(), &e, COMMIT, &archive, budget).unwrap_err();
        assert!(err.contains(needle), "{err:?} lacks {needle:?}");
        assert!(!dir.path().join("demo").exists());
    };
    refuse(Tar::new().game().sized(EntryType::GNUSparse, "demo-0123/sparse", 0).gz(), BIG, "GNUSparse");
    refuse(Tar::new().game().sized(EntryType::new(b'V'), "demo-0123/vol", 0).gz(), BIG, "refused archive entry type");
    refuse(Tar::new().sized(EntryType::XHeader, "pax", 1 << 20).game().gz(), BIG, "larger than 64 KiB");
    refuse(Tar::new().sized(EntryType::GNULongName, "././@LongLink", 70 << 10).game().gz(), BIG, "larger than 64 KiB");
    // A gzip bomb: the per-build cap stops a regular file, the 129 MiB stream cap anything skipped.
    refuse(Tar::new().game().sized(EntryType::Regular, "demo-0123/bomb", 130 << 20).gz(), BIG, "larger than its cap");
    refuse(Tar::new().game().sized(EntryType::XGlobalHeader, "g", 130 << 20).gz(), BIG, "129 MiB");
    refuse(Tar::new().game().file("other-top/x", b"1").gz(), BIG, "more than one top directory");
    refuse(Tar::new().game().raw(EntryType::Regular, b"demo-0123/../evil", b"1").gz(), BIG, "refused path");
    refuse(Tar::new().raw(EntryType::Regular, b"/etc/evil", b"1").game().gz(), BIG, "refused path");
    refuse(Tar::new().game().file("demo-0123/.git/config", b"1").gz(), BIG, ".git/");
    refuse(Tar::new().game().file("demo-0123/a\\b", b"1").gz(), BIG, "refused path");
    refuse(Tar::new().file("demo-0123/index.html", b"<!doctype html>").gz(), BIG, "no license_file");
    refuse(Tar::new().file("demo-0123/LICENSE", b"MIT").gz(), BIG, "no entry");
    refuse(Tar::new().game().gz(), 4, "larger than its cap");
    // Links and devices are skipped (and counted), not followed or created.
    let dir = tempfile::tempdir().unwrap();
    let mut t = Tar::new();
    t.game().raw(EntryType::Link, b"demo-0123/hard", b"").raw(EntryType::Char, b"demo-0123/dev", b"").raw(
        EntryType::Fifo,
        b"demo-0123/fifo",
        b"",
    );
    let r = install(dir.path(), &e, COMMIT, &t.gz(), BIG).unwrap();
    assert_eq!(r.skipped_links, 3);
    assert!(!dir.path().join("demo/hard").exists() && !dir.path().join("demo/dev").exists());
    // A long PAX path is honoured.
    let long = format!("demo-0123/{}/x.js", "d".repeat(120));
    let record = format!("path={long}\n");
    let len = record.len() + 4;
    let pax = format!("{len} {record}");
    assert_eq!(pax.len(), len);
    let dir = tempfile::tempdir().unwrap();
    let mut t = Tar::new();
    t.game().raw(EntryType::XHeader, b"pax", pax.as_bytes()).file("demo-0123/short-name", b"1");
    install(dir.path(), &e, COMMIT, &t.gz(), BIG).unwrap();
    assert!(dir.path().join("demo").join(&long["demo-0123/".len()..]).is_file());
}

#[test]
fn too_many_entries() {
    let mut t = Tar::new();
    t.game();
    for i in 0..20_000 {
        t.raw(EntryType::Directory, format!("demo-0123/d{i}/").as_bytes(), b"");
    }
    let dir = tempfile::tempdir().unwrap();
    let err = install(dir.path(), &entry(), COMMIT, &t.gz(), BIG).unwrap_err();
    assert!(err.contains("more than 20000 entries"), "{err}");
}

#[test]
fn which_entries_may_be_fetched() {
    let mut config = gnome_catalog::CatalogConfig::default();
    let dir = tempfile::tempdir().unwrap();
    let manifest = dir.path().join("m.toml");
    std::fs::write(
        &manifest,
        r#"[[games]]
slug = "unreviewed"
title = "U"
repo = "https://github.com/example/u"
commit = "0123456789abcdef0123456789abcdef01234567"
license = "MIT"
license_file = "LICENSE"
author = "E"
entry = "index.html"
build = "static"
categories = ["puzzle"]
enabled = true

[[games]]
slug = "unpinned"
title = "P"
repo = "https://github.com/example/p"
license = "MIT"
license_file = "LICENSE"
author = "E"
entry = "index.html"
build = "static"
categories = ["puzzle"]
enabled = true
reviewed = "2026-11-23: test"

[[games]]
slug = "mine"
title = "M"
license = "MIT"
license_file = "LICENSE"
copyright = "Copyright (c) 2026 me"
author = "E"
entry = "index.html"
build = "static"
categories = ["puzzle"]
enabled = true
local = true
"#,
    )
    .unwrap();
    config.oss.manifest = Some(manifest);
    assert_eq!(OssBuilds::fetch_refusal(&config, "unreviewed"), Some("not enabled"));
    assert_eq!(OssBuilds::fetch_refusal(&config, "unpinned"), Some("not pinned to a commit"));
    assert_eq!(OssBuilds::fetch_refusal(&config, "mine"), Some("a local build"));
    assert_eq!(OssBuilds::fetch_refusal(&config, "nope"), Some("unknown entry"));
    // The built-in manifest: every enabled entry is fetchable.
    let builtin = gnome_catalog::CatalogConfig::default();
    for slug in ["2048", "javascript-racer", "javascript-breakout", "bullethell", "clumsy-bird"] {
        assert_eq!(OssBuilds::fetch_refusal(&builtin, slug), None, "{slug}");
    }
    assert_eq!(OssBuilds::fetch_refusal(&builtin, "a-dark-room"), Some("not enabled"));
}

/// The real fetch of every enabled built-in entry at its pinned commit (network; run by hand).
#[tokio::test]
#[ignore = "downloads from codeload.github.com"]
async fn online_fetch_of_every_enabled_entry() {
    let dir = tempfile::tempdir().unwrap();
    let vars: std::collections::HashMap<&str, String> = [
        ("GNOME_DATA_DIR", dir.path().join("d").display().to_string()),
        ("GNOME_PROXY_ORIGIN", "https://p.gnome.example".into()),
        ("GNOME_PUBLIC_ORIGINS", "https://gnome.example".into()),
        ("GNOME_CATALOG_SOURCES", "oss".into()),
    ]
    .into_iter()
    .collect();
    let config = gnome_server::config::Config::from_lookup(|k| vars.get(k).cloned(), None).unwrap();
    let client = gnome_net::SafeClient::new(
        gnome_net::SafeClientConfig::default()
            .allowed_hosts([gnome_server::games::oss::ARCHIVE_HOST])
            .max_body_bytes(gnome_server::games::oss::MAX_ARCHIVE_BYTES),
    )
    .unwrap();
    let builds = OssBuilds::new(&config);
    for slug in builds.due(&config.catalog) {
        let r = builds.fetch(&config.catalog, &slug, &client, &tokio_util::sync::CancellationToken::new()).await;
        assert!(r.is_ok(), "{slug}: {r:?}");
    }
    let scan = builds.rescan(&config.catalog).unwrap();
    assert_eq!(scan.served.len(), 5, "{scan:?}");
}
