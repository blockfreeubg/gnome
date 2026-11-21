//! On-disk storage of mirrored lists and their metadata.
//!
//! Every stored version is content-addressed: `$GNOME_DATA_DIR/filters/<id>.<sha256>.<ext>` plus precompressed
//! `<id>.<sha256>.<ext>.br` and `.gz`; the per-list metadata in the `kv` table (`filters:<id>`) names the current
//! version. A file therefore never changes under a name that is in use, and a body read from a version's file always
//! matches that version's ETag. A replacement writes the new version's files (each one to a temporary file in the
//! same directory, fsynced, renamed, then the directory fsynced), then the metadata, and only then removes the
//! previous version. A request that already opened the previous version keeps reading it; one that finds it gone
//! looks the list up again (this process's index, or the metadata another process such as
//! `gnome-server filters refresh` wrote). After a crash the startup check ([`verify`]) either finds the version the
//! metadata names or the list is fetched again. Files of other versions and temporary files are removed at startup
//! once they are [`STALE_AGE`] old (a younger one may belong to a write in progress in another process).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::Digest as _;

use crate::db::{Db, DbError};
use crate::security::crypto::hex;

/// Brotli quality / window for precompression (the lists are compressed once per upstream change, served often).
pub const BROTLI_QUALITY: u32 = 10;
pub const BROTLI_LGWIN: u32 = 22;
/// Age from which the startup check removes files of versions the metadata does not name, and temporary files.
pub const STALE_AGE: Duration = Duration::from_secs(600);

/// Metadata of one list, stored as JSON in `kv` under `filters:<id>`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Meta {
    /// Lowercase hex SHA-256 of the stored (flattened) body; `None` until the first successful fetch.
    pub sha256: Option<String>,
    pub size: u64,
    pub size_br: u64,
    pub size_gzip: u64,
    /// `! Version:` of the stored body.
    pub version: Option<String>,
    /// `! Expires:` of the stored body in seconds (unclamped), if it has one.
    pub expires_s: Option<u64>,
    /// Upstream validators of `source` (only sent back to that URL).
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    /// URL the stored body came from (the primary or a mirror).
    pub source: Option<String>,
    /// `!#include` files flattened into the body (conditional GETs are skipped when > 0: an included file can change
    /// while the main file does not).
    pub includes: u32,
    /// Last successful check (200 or 304), Unix ms.
    pub fetched_at: Option<i64>,
    /// When the content last changed, Unix ms.
    pub updated_at: Option<i64>,
    /// When the refresh job checks the list next, Unix ms.
    pub next_check_at: i64,
    pub last_error: Option<String>,
    pub last_error_at: Option<i64>,
    /// Consecutive failed checks.
    pub failures: u32,
}

/// One stored representation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    pub path: PathBuf,
    pub len: u64,
}

/// The three stored representations of a list body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Files {
    pub identity: Variant,
    pub br: Variant,
    pub gzip: Variant,
}

pub fn kv_key(id: &str) -> String {
    format!("filters:{id}")
}

/// The plain file of version `sha` of a list.
pub fn identity_path(dir: &Path, id: &str, sha: &str, ext: &str) -> PathBuf {
    dir.join(format!("{id}.{sha}.{ext}"))
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Plain, brotli and gzip file of version `sha` of a list.
fn version_paths(dir: &Path, id: &str, sha: &str, ext: &str) -> [PathBuf; 3] {
    let identity = identity_path(dir, id, sha, ext);
    let br = with_suffix(&identity, ".br");
    let gz = with_suffix(&identity, ".gz");
    [identity, br, gz]
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&sha2::Sha256::digest(data))
}

/// Brotli and gzip encodings of `data` (CPU-heavy: call on the blocking pool).
pub fn compress(data: &[u8]) -> (Vec<u8>, Vec<u8>, Duration) {
    let started = Instant::now();
    let mut br = Vec::with_capacity(data.len() / 4);
    {
        let mut w = brotli::CompressorWriter::new(&mut br, 64 * 1024, BROTLI_QUALITY, BROTLI_LGWIN);
        w.write_all(data).expect("writing to a Vec cannot fail");
        // Dropping the writer finishes the stream.
    }
    let mut gz = flate2::write::GzEncoder::new(Vec::with_capacity(data.len() / 3), flate2::Compression::best());
    gz.write_all(data).expect("writing to a Vec cannot fail");
    let gz = gz.finish().expect("writing to a Vec cannot fail");
    (br, gz, started.elapsed())
}

fn fsync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// Write `data` to `path` atomically; returns the stored variant.
fn replace_file(path: &Path, data: &[u8]) -> io::Result<Variant> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("list");
    let tmp = dir.join(format!(".{name}.tmp-{}", hex(&crate::security::crypto::random_bytes::<6>())));
    let result = (|| {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        let len = f.metadata()?.len();
        fs::rename(&tmp, path)?;
        Ok(Variant { path: path.to_path_buf(), len })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Store version `sha` of a list (the SHA-256 of `body`) with its precompressed variants (blocking). Writing a version
/// that is already stored replaces its files with identical content.
pub fn write(dir: &Path, id: &str, sha: &str, ext: &str, body: &[u8], br: &[u8], gz: &[u8]) -> io::Result<Files> {
    fs::create_dir_all(dir)?;
    let [identity, br_path, gz_path] = version_paths(dir, id, sha, ext);
    let br = replace_file(&br_path, br)?;
    let gzip = replace_file(&gz_path, gz)?;
    let identity = replace_file(&identity, body)?;
    fsync_dir(dir)?;
    Ok(Files { identity, br, gzip })
}

fn stat_variant(path: PathBuf) -> io::Result<Variant> {
    let m = fs::metadata(&path)?;
    Ok(Variant { len: m.len(), path })
}

/// Check the stored files of the version `meta` names at startup (blocking). Missing or stale compressed variants
/// are rebuilt from the plain file; a plain file that is missing or does not match the recorded SHA-256 means the
/// list is unavailable (and due for a fetch). Returns the files and possibly corrected sizes.
pub fn verify(dir: &Path, id: &str, ext: &str, meta: &Meta) -> Option<(Files, u64, u64)> {
    let sha = meta.sha256.as_deref()?;
    let [identity, br_path, gz_path] = version_paths(dir, id, sha, ext);
    let mut body = Vec::with_capacity(usize::try_from(meta.size).unwrap_or(0));
    if let Err(e) = File::open(&identity).and_then(|mut f| f.read_to_end(&mut body)) {
        tracing::warn!(list = id, error = %e, "stored filter list cannot be read; it will be fetched again");
        return None;
    }
    if body.len() as u64 != meta.size || sha256_hex(&body) != sha {
        tracing::warn!(list = id, "stored filter list does not match its metadata; it will be fetched again");
        return None;
    }
    let sizes_ok = |p: &Path, len: u64| fs::metadata(p).is_ok_and(|m| m.len() == len && len > 0);
    if sizes_ok(&br_path, meta.size_br) && sizes_ok(&gz_path, meta.size_gzip) {
        let files = Files {
            identity: stat_variant(identity).ok()?,
            br: stat_variant(br_path).ok()?,
            gzip: stat_variant(gz_path).ok()?,
        };
        return Some((files, meta.size_br, meta.size_gzip));
    }
    tracing::info!(list = id, "rebuilding precompressed variants of a stored filter list");
    let (br, gz, _) = compress(&body);
    match write(dir, id, sha, ext, &body, &br, &gz) {
        Ok(files) => Some((files, br.len() as u64, gz.len() as u64)),
        Err(e) => {
            tracing::warn!(list = id, error = %e, "cannot rewrite stored filter list");
            None
        }
    }
}

/// The files of the version `meta` names, by size only (no hashing: names are content-addressed). Used when the
/// version this process knew is gone because another process replaced it.
pub fn stat_files(dir: &Path, id: &str, ext: &str, meta: &Meta) -> Option<Files> {
    let sha = meta.sha256.as_deref()?;
    let [identity, br, gz] = version_paths(dir, id, sha, ext);
    let stat = |path: PathBuf, len: u64| stat_variant(path).ok().filter(|v| v.len == len);
    Some(Files { identity: stat(identity, meta.size)?, br: stat(br, meta.size_br)?, gzip: stat(gz, meta.size_gzip)? })
}

/// Remove the files of version `sha` of a list (blocking; missing files are ignored).
pub fn remove_version(dir: &Path, id: &str, sha: &str, ext: &str) {
    for p in version_paths(dir, id, sha, ext) {
        let _ = fs::remove_file(p);
    }
}

/// Which version of list `id` a file name in the directory stores: `Some(Some(sha))` for `<id>.<sha>.<ext>[.br|.gz]`,
/// `Some(None)` for the older unversioned layout `<id>.<ext>[.br|.gz]`, `None` for any other file (another list's,
/// a temporary file). Unambiguous although ids may contain dots: ids are at most 64 characters, so `<id>.<sha>` is
/// never itself an id.
fn version_of<'a>(name: &'a str, id: &str, ext: &str) -> Option<Option<&'a str>> {
    let rest = name.strip_prefix(id)?.strip_prefix('.')?;
    let base = rest.strip_suffix(".br").or_else(|| rest.strip_suffix(".gz")).unwrap_or(rest);
    if base == ext {
        return Some(None);
    }
    let sha = base.strip_suffix(ext)?.strip_suffix('.')?;
    (sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(Some(sha))
}

fn old_enough(entry: &fs::DirEntry, min_age: Duration) -> bool {
    min_age.is_zero()
        || entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age >= min_age))
}

/// Remove the files of list `id` that do not belong to version `keep` (every file of the list with `None`) and are at
/// least `min_age` old (blocking).
pub fn remove_other_versions(dir: &Path, id: &str, ext: &str, keep: Option<&str>, min_age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(version) = name.to_str().and_then(|n| version_of(n, id, ext)) else { continue };
        if (version.is_none() || version != keep) && old_enough(&e, min_age) {
            tracing::debug!(list = id, file = %e.path().display(), "removing a filter-list file of another version");
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Remove temporary files left by interrupted writes that are at least `min_age` old (blocking).
pub fn clean_temp_files(dir: &Path, min_age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') && name.contains(".tmp-") && old_enough(&e, min_age) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// All stored metadata rows (`filters:*`).
pub async fn load_all(db: &Db) -> Result<Vec<(String, Meta)>, DbError> {
    db.read(|c| -> Result<Vec<(String, Meta)>, DbError> {
        let mut stmt = c.prepare_cached("SELECT key, value FROM kv WHERE key >= 'filters:' AND key < 'filters;'")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (key, value) = row?;
            let id = key.trim_start_matches("filters:").to_string();
            match serde_json::from_str::<Meta>(&value) {
                Ok(m) => out.push((id, m)),
                Err(e) => tracing::warn!(list = %id, error = %e, "ignoring unreadable filter-list metadata"),
            }
        }
        Ok(out)
    })
    .await
}

/// One metadata row.
pub async fn load_one(db: &Db, id: &str) -> Result<Option<Meta>, DbError> {
    let key = kv_key(id);
    db.read(move |c| -> Result<Option<Meta>, DbError> {
        let value: Option<String> = c
            .prepare_cached("SELECT value FROM kv WHERE key = ?1")?
            .query_row([&key], |r| r.get(0))
            .map(Some)
            .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
        Ok(value.and_then(|v| serde_json::from_str(&v).ok()))
    })
    .await
}

/// Write one metadata row.
pub async fn save(db: &Db, id: &str, meta: &Meta) -> Result<(), DbError> {
    let key = kv_key(id);
    let value = serde_json::to_string(meta).expect("metadata serializes");
    let now = crate::util::now_ms();
    db.write(move |c| -> Result<(), DbError> {
        c.prepare_cached(
            "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )?
        .execute(rusqlite::params![key, value, now])?;
        Ok(())
    })
    .await
}

/// Overwrite an existing metadata row only while it still records version `expected` (compare-and-set on its
/// `sha256`), so a correction made at startup never replaces a version another process stored in the meantime.
/// Returns whether the row was written.
pub async fn save_if_version(db: &Db, id: &str, meta: &Meta, expected: Option<&str>) -> Result<bool, DbError> {
    let key = kv_key(id);
    let value = serde_json::to_string(meta).expect("metadata serializes");
    let expected = expected.map(str::to_owned);
    let now = crate::util::now_ms();
    db.write(move |c| -> Result<bool, DbError> {
        let n = c
            .prepare_cached(
                "UPDATE kv SET value = ?2, updated_at = ?3 WHERE key = ?1 AND json_extract(value, '$.sha256') IS ?4",
            )?
            .execute(rusqlite::params![key, value, now, expected])?;
        Ok(n > 0)
    })
    .await
}

/// Delete a metadata row (list removed from the registry).
pub async fn delete(db: &Db, id: &str) -> Result<(), DbError> {
    let key = kv_key(id);
    db.write(move |c| -> Result<(), DbError> {
        c.prepare_cached("DELETE FROM kv WHERE key = ?1")?.execute([key])?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    /// Make `path` look `age` old.
    fn age(path: &Path, age: Duration) {
        File::options().write(true).open(path).unwrap().set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn write_verify_and_repair() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("filters");
        let body = "! Title: t\n||ads.example^\n".repeat(200);
        let sha = sha256_hex(body.as_bytes());
        let (br, gz, _) = compress(body.as_bytes());
        let files = write(&d, "x", &sha, "txt", body.as_bytes(), &br, &gz).unwrap();
        assert_eq!(files.identity.path, d.join(format!("x.{sha}.txt")));
        assert_eq!(files.br.path, d.join(format!("x.{sha}.txt.br")));
        assert_eq!(fs::read(&files.identity.path).unwrap(), body.as_bytes());
        assert_eq!(files.br.len, br.len() as u64);
        let mut decoded = Vec::new();
        brotli::BrotliDecompress(&mut fs::File::open(&files.br.path).unwrap(), &mut decoded).unwrap();
        assert_eq!(decoded, body.as_bytes());
        let mut gunzip = String::new();
        flate2::read::GzDecoder::new(fs::File::open(&files.gzip.path).unwrap()).read_to_string(&mut gunzip).unwrap();
        assert_eq!(gunzip, body);

        let meta = Meta {
            sha256: Some(sha.clone()),
            size: body.len() as u64,
            size_br: br.len() as u64,
            size_gzip: gz.len() as u64,
            ..Meta::default()
        };
        assert_eq!(verify(&d, "x", "txt", &meta).unwrap().0, files);
        assert_eq!(stat_files(&d, "x", "txt", &meta).unwrap(), files);

        // Missing compressed variant: rebuilt.
        fs::remove_file(&files.gzip.path).unwrap();
        assert!(stat_files(&d, "x", "txt", &meta).is_none());
        let (repaired, _, gz_len) = verify(&d, "x", "txt", &meta).unwrap();
        assert!(repaired.gzip.path.is_file() && gz_len > 0);

        // A second version lives next to the first; removing the first leaves the second intact.
        let body2 = "||other.example^\n";
        let sha2 = sha256_hex(body2.as_bytes());
        let (br2, gz2, _) = compress(body2.as_bytes());
        let files2 = write(&d, "x", &sha2, "txt", body2.as_bytes(), &br2, &gz2).unwrap();
        assert_eq!(fs::read(&files.identity.path).unwrap(), body.as_bytes(), "the old version is untouched");
        remove_version(&d, "x", &sha, "txt");
        assert!(!files.identity.path.exists() && !files.br.path.exists() && !files.gzip.path.exists());
        assert_eq!(fs::read(&files2.identity.path).unwrap(), body2.as_bytes());

        // Plain file missing or no longer matching the metadata: unavailable.
        assert!(verify(&d, "x", "txt", &meta).is_none());
        let mut tampered = meta.clone();
        tampered.sha256 = Some(sha2.clone());
        fs::write(&files2.identity.path, b"||tampered^\n").unwrap();
        assert!(verify(&d, "x", "txt", &tampered).is_none());
        assert!(verify(&d, "x", "txt", &Meta::default()).is_none());
    }

    #[test]
    fn file_names_map_to_versions() {
        let sha = "0b0a50a9dbf263c650e7a901a9f66523c1ee96b73f9d026791b9ea03cfc7a43d";
        assert_eq!(version_of(&format!("easylist.{sha}.txt"), "easylist", "txt"), Some(Some(sha)));
        assert_eq!(version_of(&format!("easylist.{sha}.txt.br"), "easylist", "txt"), Some(Some(sha)));
        assert_eq!(version_of(&format!("easylist.{sha}.txt.gz"), "easylist", "txt"), Some(Some(sha)));
        assert_eq!(version_of("easylist.txt", "easylist", "txt"), Some(None));
        assert_eq!(version_of("easylist.txt.br", "easylist", "txt"), Some(None));
        for other in [
            format!("easylist-cookies.{sha}.txt"),
            format!("easylist.{sha}.json"),
            format!(".easylist.{sha}.txt.tmp-0123456789ab"),
            format!("easylist.{}.txt", &sha[..63]),
            format!("easylist.{}.txt", sha.to_uppercase()),
            "easylist.txt.zst".into(),
            "easylist".into(),
        ] {
            assert_eq!(version_of(&other, "easylist", "txt"), None, "{other}");
        }
        // Ids may contain dots: `a.b`'s files never count as `a`'s.
        assert_eq!(version_of(&format!("a.b.{sha}.txt"), "a", "txt"), None);
        assert_eq!(version_of(&format!("a.b.{sha}.txt"), "a.b", "txt"), Some(Some(sha)));
        assert_eq!(version_of("a.txt.txt", "a", "txt"), None);
    }

    #[test]
    fn stale_files_are_removed_only_when_old() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let (keep, old) = ("a".repeat(64), "b".repeat(64));
        let names = [
            format!("x.{keep}.txt"),
            format!("x.{keep}.txt.br"),
            format!("x.{old}.txt"),
            format!("x.{old}.txt.gz"),
            "x.txt".to_string(),
            format!("y.{old}.txt"),
            format!(".x.{old}.txt.tmp-0123456789ab"),
        ];
        for n in &names {
            fs::write(d.join(n), b"x").unwrap();
        }
        // Fresh files may belong to a write in progress in another process: kept.
        remove_other_versions(d, "x", "txt", Some(&keep), STALE_AGE);
        clean_temp_files(d, STALE_AGE);
        assert_eq!(fs::read_dir(d).unwrap().count(), names.len());
        for n in &names {
            age(&d.join(n), STALE_AGE + Duration::from_secs(60));
        }
        remove_other_versions(d, "x", "txt", Some(&keep), STALE_AGE);
        clean_temp_files(d, STALE_AGE);
        let mut left: Vec<String> =
            fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, [format!("x.{keep}.txt"), format!("x.{keep}.txt.br"), format!("y.{old}.txt")]);
        // A list removed from the registry: everything goes, whatever its age.
        fs::write(d.join("x.txt.gz"), b"x").unwrap();
        remove_other_versions(d, "x", "txt", None, Duration::ZERO);
        let left: Vec<String> =
            fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(left, [format!("y.{old}.txt")]);
    }
}
