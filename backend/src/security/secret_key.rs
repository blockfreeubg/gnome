//! The server's master secret: `GNOME_SECRET_KEY` (base64, >= 32 bytes) or, when unset, a key generated once into
//! `$GNOME_DATA_DIR/secret.key` with 0600 permissions. Purpose-specific subkeys are derived with HMAC so a key used
//! for one thing (anonymous session tokens) can never be confused with another.

use std::fmt;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};

use super::crypto::{b64_std, hex, hmac_sha256, random_bytes};
use crate::config::Config;

/// Minimum key length in bytes.
pub const MIN_KEY_LEN: usize = 32;

/// The master key. `Debug` never prints it.
#[derive(Clone)]
pub struct SecretKey {
    master: Vec<u8>,
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretKey(<redacted>)")
    }
}

impl SecretKey {
    pub fn from_bytes(master: Vec<u8>) -> Result<Self, String> {
        if master.len() < MIN_KEY_LEN {
            return Err(format!("secret key must be at least {MIN_KEY_LEN} bytes (got {})", master.len()));
        }
        Ok(Self { master })
    }

    /// A 32-byte subkey for `purpose` (e.g. `"anon-session"`). Stable for a given master key.
    pub fn derive(&self, purpose: &str) -> [u8; 32] {
        hmac_sha256(&self.master, &[b"gnome-server/v1/", purpose.as_bytes()])
    }
}

/// Decode a base64 key (standard or URL-safe alphabet, padded or not) and check its length.
pub fn decode_key(text: &str) -> Result<Vec<u8>, String> {
    let t = text.trim();
    let bytes = STANDARD
        .decode(t)
        .or_else(|_| STANDARD_NO_PAD.decode(t))
        .or_else(|_| URL_SAFE.decode(t))
        .or_else(|_| URL_SAFE_NO_PAD.decode(t))
        .map_err(|_| "must be base64 (e.g. generated with `openssl rand -base64 32`)".to_string())?;
    if bytes.len() < MIN_KEY_LEN {
        return Err(format!("must decode to at least {MIN_KEY_LEN} bytes (got {})", bytes.len()));
    }
    Ok(bytes)
}

/// Where the key will come from (for `config check`, which must not create files).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeySource {
    Configured,
    File(PathBuf),
    WillGenerate(PathBuf),
}

pub fn key_source(config: &Config) -> KeySource {
    if config.secret_key.is_some() {
        return KeySource::Configured;
    }
    let path = config.secret_key_path();
    if path.exists() { KeySource::File(path) } else { KeySource::WillGenerate(path) }
}

/// Load the configured key, or read/generate `$GNOME_DATA_DIR/secret.key`. The data dir must already exist.
pub fn load_or_create(config: &Config) -> Result<SecretKey, String> {
    if let Some(configured) = &config.secret_key {
        return SecretKey::from_bytes(decode_key(configured.expose()).map_err(|e| format!("GNOME_SECRET_KEY: {e}"))?);
    }
    load_or_create_file(&config.secret_key_path())
}

fn load_or_create_file(path: &Path) -> Result<SecretKey, String> {
    if let Some(key) = read_key_file(path)? {
        return Ok(key);
    }
    let key = random_bytes::<32>();
    let mut text = b64_std(&key);
    text.push('\n');
    // Write a private temporary file, then link it into place: the key file appears complete or not at all, and
    // when two processes start at once exactly one key wins (`hard_link` fails if the target exists).
    let tmp = path.with_file_name(format!(".secret.key.{}.tmp", hex(&random_bytes::<6>())));
    let created = write_private(&tmp, text.as_bytes()).and_then(|()| std::fs::hard_link(&tmp, path));
    let _ = std::fs::remove_file(&tmp);
    match created {
        Ok(()) => {
            tracing::info!(path = %path.display(), "generated a new secret key");
            SecretKey::from_bytes(key.to_vec())
        }
        // Lost a race with another process creating it: use theirs.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            read_key_file(path)?.ok_or_else(|| format!("{} disappeared while starting", path.display()))
        }
        // Filesystems without hard links (e.g. FAT): exclusive create + write in place.
        Err(_) => match write_private(path, text.as_bytes()) {
            Ok(()) => {
                tracing::info!(path = %path.display(), "generated a new secret key");
                SecretKey::from_bytes(key.to_vec())
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                read_key_file(path)?.ok_or_else(|| format!("{} disappeared while starting", path.display()))
            }
            Err(e) => Err(format!("cannot create {}: {e}", path.display())),
        },
    }
}

/// Create `path` (must not exist) with mode 0600, write `data` and flush it to disk.
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    file.write_all(data).and_then(|()| file.sync_all())
}

fn read_key_file(path: &Path) -> Result<Option<SecretKey>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if let Ok(meta) = std::fs::metadata(path) {
            let mode = meta.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                tracing::warn!(path = %path.display(), mode = format!("{mode:o}"), "secret key file is accessible by other users; restricting to 0600");
                if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
                    tracing::warn!(error = %e, "could not chmod the secret key file");
                }
            }
        }
    }
    let bytes = decode_key(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    SecretKey::from_bytes(bytes).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_accepts_common_encodings() {
        let raw = [7u8; 32];
        assert_eq!(decode_key(&STANDARD.encode(raw)).unwrap(), raw);
        assert_eq!(decode_key(&URL_SAFE_NO_PAD.encode(raw)).unwrap(), raw);
        assert!(decode_key(&STANDARD.encode([1u8; 16])).is_err());
        assert!(decode_key("%%%").is_err());
    }

    #[test]
    fn concurrent_starts_agree_on_one_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.key");
        let keys: Vec<[u8; 32]> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8).map(|_| s.spawn(|| load_or_create_file(&path).unwrap().derive("x"))).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(keys.windows(2).all(|w| w[0] == w[1]), "every process ends up with the same key");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("secret.key")], "temporary files are removed");
    }

    #[test]
    fn corrupt_key_file_is_an_error_not_a_new_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.key");
        std::fs::write(&path, "not a key").unwrap();
        let err = load_or_create_file(&path).unwrap_err();
        assert!(err.contains("secret.key") && err.contains("base64"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a key", "never overwritten");
    }

    #[test]
    fn generated_file_is_private_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.key");
        let a = load_or_create_file(&path).unwrap();
        let b = load_or_create_file(&path).unwrap();
        assert_eq!(a.derive("x"), b.derive("x"));
        assert_ne!(a.derive("x"), a.derive("y"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(!format!("{a:?}").contains(&b64_std(&a.master)));
    }
}
