//! Request-level security: client identity behind proxies, origin/CSRF checks, security headers + CSP, rate
//! limiting, and the cryptographic helpers shared by sessions.

pub mod client;
pub mod crypto;
pub mod csp;
pub mod csrf;
pub mod headers;
pub mod origin;
pub mod rate_limit;
pub mod secret_key;

pub use client::ClientInfo;
pub use rate_limit::{RateClass, RateLimiter, SessionKey};
