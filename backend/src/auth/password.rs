//! Password hashing (Argon2id, t=2, p=1, m=`GNOME_ARGON2_MEMORY_KIB`) and credential validation.
//!
//! Hashing runs on the blocking pool behind a semaphore so a burst of logins cannot exhaust a 1 GB Raspberry Pi
//! (each hash allocates `m` KiB). Unknown usernames are verified against a dummy hash so response timing does not
//! reveal which accounts exist. Hashes created with older parameters are upgraded on the next successful login.

use argon2::password_hash::phc::PasswordHash;
use argon2::{Algorithm, Argon2, Params, PasswordHasher as _, PasswordVerifier as _, Version};
use std::sync::Arc;

use tokio::sync::{OnceCell, Semaphore};

use crate::security::crypto::random_bytes;

pub const USERNAME_MIN: usize = 3;
pub const USERNAME_MAX: usize = 32;
pub const PASSWORD_MIN: usize = 10;
pub const PASSWORD_MAX: usize = 256;
const T_COST: u32 = 2;
const P_COST: u32 = 1;

/// `3–32` characters of `[a-zA-Z0-9_.-]`.
pub fn validate_username(name: &str) -> Result<(), &'static str> {
    let len = name.chars().count();
    if !(USERNAME_MIN..=USERNAME_MAX).contains(&len) {
        return Err("must be 3–32 characters");
    }
    if !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')) {
        return Err("may only contain letters, digits, '_', '.' and '-'");
    }
    Ok(())
}

/// `10–256` characters (Unicode scalar values), not only whitespace, no NUL.
pub fn validate_password(password: &str) -> Result<(), &'static str> {
    let len = password.chars().count();
    if len < PASSWORD_MIN {
        return Err("must be at least 10 characters");
    }
    if len > PASSWORD_MAX {
        return Err("must be at most 256 characters");
    }
    if password.trim().is_empty() {
        return Err("must not be only whitespace");
    }
    if password.contains('\0') {
        return Err("must not contain NUL characters");
    }
    Ok(())
}

/// Result of verifying a password.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verification {
    pub ok: bool,
    /// The stored hash uses different parameters than the current configuration.
    pub needs_rehash: bool,
}

#[derive(Debug)]
pub struct HashError(String);

impl std::fmt::Display for HashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "password hashing failed: {}", self.0)
    }
}

impl std::error::Error for HashError {}

impl From<HashError> for crate::error::ApiError {
    fn from(e: HashError) -> Self {
        Self::internal_from(e)
    }
}

/// Password hashing service (cheap to clone).
#[derive(Clone)]
pub struct Passwords {
    inner: Arc<Inner>,
}

struct Inner {
    params: Params,
    permits: Semaphore,
    dummy: OnceCell<String>,
}

impl std::fmt::Debug for Passwords {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Passwords").field("m_cost_kib", &self.inner.params.m_cost()).finish()
    }
}

impl Inner {
    fn argon2(&self) -> Argon2<'static> {
        Argon2::new(Algorithm::Argon2id, Version::V0x13, self.params.clone())
    }

    fn hash(&self, password: &str) -> Result<String, HashError> {
        let salt = random_bytes::<16>();
        self.argon2()
            .hash_password_with_salt(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| HashError(e.to_string()))
    }

    fn verify(&self, password: &str, phc: &str) -> Result<Verification, HashError> {
        let parsed = PasswordHash::new(phc).map_err(|e| HashError(format!("stored hash is not a PHC string: {e}")))?;
        let ok = self.argon2().verify_password(password.as_bytes(), &parsed).is_ok();
        let needs_rehash = parsed.algorithm.as_str() != "argon2id"
            || Params::try_from(&parsed).map_or(true, |p| {
                p.m_cost() != self.params.m_cost()
                    || p.t_cost() != self.params.t_cost()
                    || p.p_cost() != self.params.p_cost()
            });
        Ok(Verification { ok, needs_rehash })
    }
}

impl Passwords {
    pub fn new(memory_kib: u32) -> Result<Self, HashError> {
        let params = Params::new(memory_kib, T_COST, P_COST, None).map_err(|e| HashError(e.to_string()))?;
        let cpus = std::thread::available_parallelism().map_or(1, usize::from);
        Ok(Self {
            inner: Arc::new(Inner { params, permits: Semaphore::new((cpus / 2).clamp(1, 4)), dummy: OnceCell::new() }),
        })
    }

    /// Hash synchronously (CLI and tests).
    pub fn hash_blocking(&self, password: &str) -> Result<String, HashError> {
        self.inner.hash(password)
    }

    /// Hash on the blocking pool.
    pub async fn hash(&self, password: String) -> Result<String, HashError> {
        self.run(move |p| p.hash(&password)).await
    }

    /// Verify on the blocking pool.
    pub async fn verify(&self, password: String, phc: String) -> Result<Verification, HashError> {
        self.run(move |p| p.verify(&password, &phc)).await
    }

    /// Spend the same effort as a real verification (unknown username), always failing.
    pub async fn verify_dummy(&self, password: String) -> Result<(), HashError> {
        let dummy = self
            .inner
            .dummy
            .get_or_try_init(|| async { self.run(|p| p.hash("gnome-dummy-password")).await })
            .await?
            .clone();
        self.verify(password, dummy).await.map(drop)
    }

    async fn run<T, F>(&self, f: F) -> Result<T, HashError>
    where
        F: FnOnce(&Inner) -> Result<T, HashError> + Send + 'static,
        T: Send + 'static,
    {
        let _permit = self.inner.permits.acquire().await.map_err(|e| HashError(e.to_string()))?;
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || f(&inner)).await.map_err(|e| HashError(e.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_rules() {
        assert!(validate_username("gnome_fan.42-x").is_ok());
        for bad in ["ab", "a".repeat(33).as_str(), "has space", "émile", "semi;colon", ""] {
            assert!(validate_username(bad).is_err(), "{bad:?}");
        }
        assert!(validate_username(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn password_rules() {
        assert!(validate_password("correct horse").is_ok());
        assert!(validate_password("short").is_err());
        assert!(validate_password("          ").is_err());
        assert!(validate_password(&"x".repeat(257)).is_err());
        assert!(validate_password(&"é".repeat(10)).is_ok(), "counts characters, not bytes");
        assert!(validate_password("abcdefghij\0").is_err());
    }

    #[tokio::test]
    async fn hash_verify_and_rehash_detection() {
        let p = Passwords::new(1024).unwrap();
        let phc = p.hash("correct horse battery".into()).await.unwrap();
        assert!(phc.starts_with("$argon2id$v=19$m=1024,t=2,p=1$"), "{phc}");
        let v = p.verify("correct horse battery".into(), phc.clone()).await.unwrap();
        assert_eq!(v, Verification { ok: true, needs_rehash: false });
        let v = p.verify("wrong horse battery".into(), phc.clone()).await.unwrap();
        assert!(!v.ok);
        let stronger = Passwords::new(2048).unwrap();
        let v = stronger.verify("correct horse battery".into(), phc).await.unwrap();
        assert_eq!(v, Verification { ok: true, needs_rehash: true });
        stronger.verify_dummy("anything at all".into()).await.unwrap();
        assert!(p.verify("x".into(), "not-a-phc".into()).await.is_err());
    }
}
