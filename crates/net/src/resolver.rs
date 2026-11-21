//! Name resolution with the IP policy applied to every answer.
//!
//! [`SafeClient`](crate::SafeClient) hands reqwest a resolver that runs a [`Resolver`] (the system resolver by
//! default) and drops every address the [`IpPolicy`] refuses *before* reqwest sees it. The connector therefore only
//! ever dials vetted addresses: there is no second lookup an attacker could answer differently (DNS rebinding), and
//! a mixed answer (`10.0.0.1` + a public address) connects only to the public address. If nothing survives, the
//! lookup fails with [`BlockedAddress`].

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;

use crate::ip_policy::{IpClass, IpPolicy};

/// A boxed, sendable future.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Resolves a host name to IP addresses. The results are always filtered through the client's [`IpPolicy`]
/// afterwards, so an implementation cannot widen what the client may connect to.
pub trait Resolver: Send + Sync + 'static {
    /// Resolve `host` (a domain name, never an IP literal) to its addresses.
    fn resolve<'a>(&'a self, host: &'a str) -> BoxFuture<'a, io::Result<Vec<IpAddr>>>;
}

/// The operating system resolver (`getaddrinfo` on Tokio's blocking pool).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> BoxFuture<'a, io::Result<Vec<IpAddr>>> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, 0)).await?.map(|a| a.ip()).collect()) })
    }
}

/// A fixed name → addresses table (tests, or pinning a host to known addresses). Unknown names fail with
/// [`io::ErrorKind::NotFound`]. Names are matched case-insensitively, ignoring a trailing dot.
#[derive(Debug, Clone, Default)]
pub struct StaticResolver {
    map: HashMap<String, Vec<IpAddr>>,
}

impl StaticResolver {
    /// An empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Map `host` to `addrs` (replacing any earlier entry).
    #[must_use]
    pub fn with(mut self, host: &str, addrs: impl IntoIterator<Item = IpAddr>) -> Self {
        self.map.insert(normalize(host), addrs.into_iter().collect());
        self
    }
}

impl Resolver for StaticResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> BoxFuture<'a, io::Result<Vec<IpAddr>>> {
        let res = self
            .map
            .get(&normalize(host))
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{host}: no such host")));
        Box::pin(async move { res })
    }
}

fn normalize(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// Every address a host resolved to was refused by the IP policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockedAddress {
    /// The host name that was looked up.
    pub host: String,
    /// The first refused address.
    pub ip: IpAddr,
    /// Its class.
    pub class: IpClass,
}

impl fmt::Display for BlockedAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} resolves only to disallowed addresses ({} is {})", self.host, self.ip, self.class)
    }
}

impl std::error::Error for BlockedAddress {}

/// Apply `policy` to a lookup result: keep allowed addresses (deduplicated, order preserved).
pub(crate) fn filter(host: &str, ips: Vec<IpAddr>, policy: &IpPolicy) -> Result<Vec<IpAddr>, FilterError> {
    let mut allowed: Vec<IpAddr> = Vec::with_capacity(ips.len());
    let mut first_denied = None;
    for ip in ips {
        match policy.check(ip) {
            Ok(()) if !allowed.contains(&ip) => allowed.push(ip),
            Ok(()) => {}
            Err(class) => {
                tracing::debug!(%host, %ip, %class, "gnome-net: dropped disallowed address");
                first_denied.get_or_insert((ip, class));
            }
        }
    }
    match (allowed.is_empty(), first_denied) {
        (false, _) => Ok(allowed),
        (true, Some((ip, class))) => Err(FilterError::Blocked(BlockedAddress { host: host.to_owned(), ip, class })),
        (true, None) => Err(FilterError::Empty),
    }
}

#[derive(Debug)]
pub(crate) enum FilterError {
    Blocked(BlockedAddress),
    Empty,
}

/// The adapter reqwest calls for every connection (including every redirect hop, which `SafeClient` issues as a
/// separate request).
pub(crate) struct PolicyResolver {
    pub(crate) inner: Arc<dyn Resolver>,
    pub(crate) policy: IpPolicy,
}

impl reqwest::dns::Resolve for PolicyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let inner = Arc::clone(&self.inner);
        let policy = self.policy;
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let ips = inner.resolve(&host).await?;
            match filter(&host, ips, &policy) {
                Ok(ips) => {
                    let addrs: reqwest::dns::Addrs = Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)));
                    Ok(addrs)
                }
                Err(FilterError::Blocked(b)) => {
                    tracing::info!(host = %b.host, ip = %b.ip, class = %b.class, "gnome-net: blocked destination");
                    Err(Box::new(b) as Box<dyn std::error::Error + Send + Sync>)
                }
                Err(FilterError::Empty) => {
                    Err(Box::new(io::Error::new(io::ErrorKind::NotFound, format!("{host}: no addresses"))) as _)
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ips(v: &[&str]) -> Vec<IpAddr> {
        v.iter().map(|s| s.parse().unwrap()).collect()
    }

    #[test]
    fn filter_keeps_only_allowed_and_dedups() {
        let p = IpPolicy::strict();
        let got = filter("h", ips(&["10.0.0.1", "1.1.1.1", "127.0.0.1", "1.1.1.1", "2606:4700::1"]), &p).unwrap();
        assert_eq!(got, ips(&["1.1.1.1", "2606:4700::1"]));
    }

    #[test]
    fn filter_reports_first_refused() {
        match filter("h", ips(&["169.254.169.254", "127.0.0.1"]), &IpPolicy::strict()) {
            Err(FilterError::Blocked(b)) => {
                assert_eq!(b.ip, "169.254.169.254".parse::<IpAddr>().unwrap());
                assert_eq!(b.class, IpClass::LinkLocal);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(filter("h", vec![], &IpPolicy::strict()), Err(FilterError::Empty)));
    }

    #[tokio::test]
    async fn static_resolver() {
        let r = StaticResolver::new().with("Example.TEST", ips(&["1.2.3.4"]));
        assert_eq!(r.resolve("example.test.").await.unwrap(), ips(&["1.2.3.4"]));
        assert_eq!(r.resolve("other.test").await.unwrap_err().kind(), io::ErrorKind::NotFound);
    }
}
