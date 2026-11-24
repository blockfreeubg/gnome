//! The catalog's feed and thumbnail fetcher over gnome-net's SSRF-safe client (WAVE-C §4.1).
//!
//! The crate never opens sockets: it hands [`gnome_catalog::FetchRequest`]s to a [`gnome_catalog::Fetcher`]. This
//! one sends them through [`gnome_net::SafeClient`] (strict IP policy, no proxies, every redirect re-validated) with a
//! host allow-list: the feed hosts of the enabled sources, or the thumbnail hosts of their policy.

use std::time::Duration;

use gnome_catalog::{BoxFuture, FetchError, FetchRequest, FetchResponse, Fetcher, Method, Source, ThumbPolicy};
use gnome_net::{Request, SafeClient, SafeClientConfig};

/// Connect timeout of catalog requests.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// [`Fetcher`] over a [`SafeClient`].
#[derive(Clone)]
pub struct CatalogFetcher {
    client: SafeClient,
}

impl std::fmt::Debug for CatalogFetcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CatalogFetcher").finish_non_exhaustive()
    }
}

fn base(source_url: Option<&str>) -> SafeClientConfig {
    let mut cfg = SafeClientConfig::default().connect_timeout(CONNECT_TIMEOUT);
    if let Some(url) = source_url {
        cfg = cfg.source_url(url.to_string());
    }
    cfg
}

impl CatalogFetcher {
    /// Host allow-list = the feed hosts of `sources` ([`Source::feed_hosts`]).
    pub fn for_feeds(sources: &[Source], source_url: Option<&str>) -> Result<Self, String> {
        let hosts: Vec<&str> = sources.iter().flat_map(|s| s.feed_hosts().iter().copied()).collect();
        let client =
            SafeClient::new(base(source_url).allowed_hosts(hosts)).map_err(|e| format!("catalog feed client: {e}"))?;
        Ok(Self { client })
    }

    /// Host allow-list = [`ThumbPolicy::hosts`]; at most one redirect.
    pub fn for_thumbnails(policy: &ThumbPolicy, source_url: Option<&str>) -> Result<Self, String> {
        let hosts: Vec<String> = policy.hosts().iter().map(|h| h.to_string()).collect();
        let client = SafeClient::new(base(source_url).allowed_hosts(hosts).max_redirects(1))
            .map_err(|e| format!("thumbnail client: {e}"))?;
        Ok(Self { client })
    }

    /// Any client (tests: `allow_loopback` + a `StaticResolver`).
    pub fn new(client: SafeClient) -> Self {
        Self { client }
    }
}

/// gnome-net's error → the crate's.
pub fn map_error(e: &gnome_net::Error) -> FetchError {
    match e {
        gnome_net::Error::Timeout => FetchError::Timeout,
        gnome_net::Error::BodyTooLarge { limit } => {
            FetchError::BodyTooLarge { limit: usize::try_from(*limit).unwrap_or(usize::MAX) }
        }
        e if e.is_policy() => FetchError::Blocked(e.to_string()),
        e => FetchError::Network(e.to_string()),
    }
}

impl Fetcher for CatalogFetcher {
    /// Sends method, URL, headers and body as given; `max_body_bytes` and `timeout` from the request; every HTTP
    /// status is `Ok`.
    fn fetch(&self, request: FetchRequest) -> BoxFuture<'_, Result<FetchResponse, FetchError>> {
        Box::pin(async move {
            let method = match request.method {
                Method::Get => gnome_net::Method::GET,
                Method::Post => gnome_net::Method::POST,
            };
            let mut req = Request::new(method, request.url)
                .max_body_bytes(request.max_body_bytes as u64)
                .timeout(request.timeout);
            for (name, value) in request.headers {
                req = req.header(name, value);
            }
            if let Some(body) = request.body {
                req = req.body(body);
            }
            let res = self.client.fetch(req).await.map_err(|e| map_error(&e))?;
            Ok(FetchResponse { status: res.status().as_u16(), headers: res.header_pairs(), body: res.body().to_vec() })
        })
    }
}
