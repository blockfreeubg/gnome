//! # gnome-net
//!
//! The SSRF-safe outbound HTTP client and destination IP policy for GNOME's server-side fetches (filter lists,
//! catalog feeds, thumbnails, VPN relay metadata).
//!
//! * [`IpPolicy`] / [`classify`]: which addresses may be reached. The classes mirror HolyWisp's egress policy so
//!   proxied browsing and server-side fetches refuse the same destinations (loopback, RFC 1918, CGNAT,
//!   link-local incl. cloud metadata, ULA, multicast, broadcast, documentation, benchmarking, reserved; IPv4
//!   embedded in IPv6 is unwrapped).
//! * [`SafeClient`]: HTTP client (reqwest + rustls/ring + webpki roots, gzip/brotli) that resolves names itself,
//!   filters the answers through the policy and connects only to the vetted addresses; enforces a scheme
//!   allowlist (https; http opt-in per request), port allowlist, optional host allowlist, at most 5 redirects
//!   (every hop re-validated), connect and total timeouts, and a decoded-body limit enforced while streaming.
//! * [`Validators`] / [`SafeClient::fetch_conditional`]: conditional GET (`ETag` / `Last-Modified` → 304).
//!
//! ```no_run
//! # async fn demo() -> Result<(), gnome_net::Error> {
//! use gnome_net::{Conditional, Request, SafeClient, SafeClientConfig, Validators};
//!
//! let client = SafeClient::new(SafeClientConfig::default().source_url("https://example.org/gnome"))?;
//! let cached = Validators::default();
//! match client.fetch_conditional(Request::get("https://easylist.to/easylist/easylist.txt").max_body_bytes(8 << 20), &cached).await? {
//!     Conditional::NotModified { .. } => {}
//!     Conditional::Modified { response, validators } => {
//!         let _text = response.body();
//!         let _store = validators;
//!     }
//! }
//! # Ok(()) }
//! ```
//!
//! See `crates/net/README.md` for how gnome-server wires this into `gnome_catalog::Fetcher`.

#![warn(missing_docs)]

mod client;
mod error;
pub mod ip_policy;
pub mod resolver;

pub use crate::client::{
    Conditional, DEFAULT_CONNECT_TIMEOUT, DEFAULT_MAX_BODY_BYTES, DEFAULT_PORTS, DEFAULT_TIMEOUT, MAX_REDIRECTS,
    Request, Response, SafeClient, SafeClientConfig, VERSION, Validators,
};
pub use crate::error::Error;
pub use crate::ip_policy::{IpClass, IpPolicy, classify};
pub use crate::resolver::{BlockedAddress, Resolver, StaticResolver, SystemResolver};
pub use bytes::Bytes;
pub use http::{HeaderMap, Method, StatusCode};
pub use url::Url;
