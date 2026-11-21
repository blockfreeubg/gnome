//! Sessions and accounts.
//!
//! * Anonymous sessions (`gnome_sid`): stateless HMAC-signed tokens `v1.<exp_s>.<rand>.<hmac>` ([`anon`]).
//! * User sessions (`gnome_auth`): random 32-byte tokens stored as SHA-256, 30-day sliding expiry ([`sessions`]).
//! * Passwords: Argon2id on the blocking pool with bounded concurrency ([`password`]).
//! * Per-username failure backoff ([`backoff`]).
//! * Extractors used by handlers and by other modules (e.g. the Wisp gateway) ([`extract`]).

pub mod anon;
pub mod backoff;
pub mod cookies;
pub mod extract;
pub mod password;
pub mod sessions;
pub mod users;

pub use extract::{CookieSink, CurrentUser, MaybeAnon, MaybeUser, ProxySession, RequireUser, proxy_session};
pub use users::User;
