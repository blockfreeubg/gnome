//! Errors returned by [`SafeClient`](crate::SafeClient).

use std::fmt;
use std::net::IpAddr;

use crate::ip_policy::IpClass;

/// Why a fetch failed. HTTP error statuses (4xx/5xx) are *not* errors: they come back as a
/// [`Response`](crate::Response).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The [`SafeClientConfig`](crate::SafeClientConfig) is invalid (returned by [`SafeClient::new`](crate::SafeClient::new)).
    Config(String),
    /// The URL (or a redirect `Location`) could not be parsed, has no host, or carries credentials.
    InvalidUrl(String),
    /// The request itself is malformed (bad header name/value, forbidden header).
    InvalidRequest(String),
    /// The scheme is not allowed (`https` always is; `http` only with [`Request::allow_http`](crate::Request::allow_http)).
    SchemeNotAllowed(String),
    /// The port is not in the client's port allowlist.
    PortNotAllowed(u16),
    /// The host is not in the client's host allowlist.
    HostNotAllowed(String),
    /// The destination address is refused by the [`IpPolicy`](crate::IpPolicy): an IP literal in the URL, or every
    /// address the host name resolved to.
    Blocked {
        /// Host as written in the URL.
        host: String,
        /// The refused address.
        ip: IpAddr,
        /// Its class.
        class: IpClass,
    },
    /// More redirects than the client allows.
    TooManyRedirects(usize),
    /// The connect timeout or the request's total time budget (all hops plus the body) ran out.
    Timeout,
    /// The (decoded) body is larger than the request's limit; reading stopped at the limit.
    BodyTooLarge {
        /// The limit in bytes.
        limit: u64,
    },
    /// DNS, connection, TLS or HTTP protocol failure.
    Network(String),
}

impl Error {
    /// Whether the destination was refused by policy (scheme, port, host allowlist or IP policy). Retrying the
    /// same URL cannot succeed.
    pub fn is_policy(&self) -> bool {
        matches!(
            self,
            Self::SchemeNotAllowed(_) | Self::PortNotAllowed(_) | Self::HostNotAllowed(_) | Self::Blocked { .. }
        )
    }

    /// Whether retrying later may help (timeouts and network errors).
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Timeout | Self::Network(_))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(e) => write!(f, "invalid client configuration: {e}"),
            Self::InvalidUrl(e) => write!(f, "invalid URL: {e}"),
            Self::InvalidRequest(e) => write!(f, "invalid request: {e}"),
            Self::SchemeNotAllowed(s) => write!(f, "scheme not allowed: {s}"),
            Self::PortNotAllowed(p) => write!(f, "port not allowed: {p}"),
            Self::HostNotAllowed(h) => write!(f, "host not allowed: {h}"),
            Self::Blocked { host, ip, class } => write!(f, "destination blocked: {host} ({ip} is {class})"),
            Self::TooManyRedirects(n) => write!(f, "too many redirects (limit {n})"),
            Self::Timeout => f.write_str("request timed out"),
            Self::BodyTooLarge { limit } => write!(f, "response body larger than {limit} bytes"),
            Self::Network(e) => write!(f, "network error: {e}"),
        }
    }
}

impl std::error::Error for Error {}
