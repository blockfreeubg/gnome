# gnome-net

SSRF-safe outbound HTTP client and destination IP policy for GNOME's server-side fetches: filter lists, catalog
feeds, thumbnails and VPN relay metadata. Proxied browsing goes through HolyWisp instead. Both use the same address
policy, so a destination that HolyWisp refuses is also refused here.

## Public API

| Item | Purpose |
| --- | --- |
| `SafeClient::new(SafeClientConfig)` | Builds a client. It is cheap to clone and every clone shares one connection pool. |
| `SafeClient::fetch(Request) -> Result<Response, Error>` | Runs one request, follows redirects and returns the whole decoded body (size-limited). Every HTTP status, including 304 and 5xx, comes back as `Ok`. |
| `SafeClient::fetch_conditional(Request, &Validators) -> Result<Conditional, Error>` | Conditional GET. Returns `NotModified { validators }` or `Modified { response, validators }`. |
| `Request::{get, post, new}` + `.header() .body() .allow_http() .max_body_bytes() .timeout() .conditional()` | Builds a request. |
| `Response::{status, headers, header, header_pairs, url, redirects, body, into_body, validators, is_not_modified}` | Reads the result. |
| `IpPolicy`, `classify`, `ip_policy::{classify_v4, classify_v6, embedded_ipv4}` | The address policy, usable on its own (for example to validate an operator-supplied upstream). |
| `Resolver`, `SystemResolver`, `StaticResolver` | Pluggable name resolution. Answers are always filtered by the policy, so a resolver cannot widen what the client may reach. |
| `Error` (`is_policy()`, `is_retryable()`) | Failure reasons: `Config`, `InvalidUrl`, `InvalidRequest`, `SchemeNotAllowed`, `PortNotAllowed`, `HostNotAllowed`, `Blocked { host, ip, class }`, `TooManyRedirects`, `Timeout`, `BodyTooLarge { limit }`, `Network`. |

`cargo doc -p gnome-net --open` renders the full rustdoc.

### `SafeClientConfig` (builder methods; defaults in brackets)

| Method | Meaning |
| --- | --- |
| `ip_policy(IpPolicy)` [`strict()`] | Destination address classes. `allow_loopback`, `allow_private` and `allow_link_local` mirror HolyWisp's flags. Production code leaves them off; the tests use `allow_loopback` to reach their local server. |
| `allowed_ports([..])` [`80, 443`] | Port allowlist, applied to every hop. |
| `allowed_hosts([..])` [none] | Optional host allowlist. `example.com` matches that host exactly; `*.example.com` matches its subdomains but not the apex. IDNA is normalised. Applied to every hop. Use it for thumbnails, with the list derived from the enabled catalog sources. |
| `max_redirects(n)` [5, max 5] | `0` returns 3xx responses without following them. |
| `connect_timeout(d)` [10 s] | Time limit for TCP connect plus TLS handshake. |
| `timeout(d)` [30 s] | Total time budget per request: all hops plus the body. `Request::timeout` overrides it. |
| `max_body_bytes(n)` [16 MiB] | Limit on the decoded body. `Request::max_body_bytes` overrides it. |
| `source_url(url)` [none] | `User-Agent: GNOME/<version> (+<url>)`. Without a URL it is `GNOME/<version>`. |
| `resolver(Arc<dyn Resolver>)` [system] | Name resolver. Its answers are filtered by the policy. |

## Guarantees (checked on every redirect hop)

1. **Scheme.** `https` is always allowed. `http` is allowed only when `Request::allow_http(true)` is set. Any other
   scheme (`file:`, `ftp:`, `data:`, ...) fails with `SchemeNotAllowed`.
2. **URL shape.** URLs with credentials (`user:pw@`) are refused. The port must be on the port allowlist and the host
   on the host allowlist, if one is configured.
3. **IP literals.** An IP-literal host is classified by `IpPolicy`. WHATWG parsing normalises forms such as
   `2130706433`, `0x7f.1`, `127.1` and `[::ffff:7f00:1]` first, so these are caught too.
4. **Host names.** Names are resolved by gnome-net itself through reqwest's resolver hook. Every refused address is
   dropped before the connector sees the list, so the client connects only to vetted addresses. There is no
   second lookup that a rebinding DNS server could answer differently. A mixed answer such as `[10.0.0.1, 1.2.3.4]`
   uses only `1.2.3.4`. If nothing survives, the request fails with `Blocked`.
5. **Redirects.** gnome-net follows redirects itself (reqwest's redirect policy is `none`), at most 5 of them, and
   re-checks each hop from step 1. A 303, or a 301/302 after `POST`, becomes `GET` without a body.
   `Authorization` and `Cookie` are dropped on cross-origin hops.
6. **No proxies.** Environment proxy variables are ignored (`no_proxy()`), because a proxy would resolve names
   outside the policy.
7. **Body limit.** gzip and brotli bodies are decoded (`Accept-Encoding: gzip, br`) and counted while they stream.
   The request fails with `BodyTooLarge` as soon as the decoded size passes the limit, or immediately if
   `Content-Length` already exceeds it. Compression bombs and endless streams are never buffered.
8. **Timeouts.** There is a connect timeout and a total deadline. The total deadline covers every hop and the body,
   so a server that drips bytes cannot hold a task forever.
9. **Forbidden headers.** Callers may not set `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`,
   `Keep-Alive`, `Upgrade`, `TE`, `Trailer`, `Proxy-Authorization` or `Proxy-Connection`.

Dependency versions and features come from the root `[workspace.dependencies]` (reqwest without default features,
`rustls-no-provider` + `gzip` + `brotli`; rustls with `ring`). TLS uses rustls 0.23 with the *ring* provider and the Mozilla roots from `webpki-roots`. This is the same crypto
stack as the rest of the workspace: no OpenSSL, no aws-lc. Only HTTP/1.1 is enabled.

## IP policy

The policy mirrors HolyWisp `src/common/net.c` (see `docs/research/holywisp.md` §5.6). The rustdoc of
`gnome_net::ip_policy` has the full table. In summary, gnome-net refuses:

- loopback: `127/8`, `::1`
- unspecified: `0/8`, `::`
- RFC 1918
- CGNAT: `100.64/10`
- link-local, including cloud metadata `169.254.169.254`: `169.254/16`, `fe80::/10`
- ULA: `fc00::/7`
- multicast
- broadcast
- documentation ranges
- benchmarking: `198.18/15`, `2001:2::/48`
- reserved: `240/4`, `192.0.0/24`, `fec0::/10`

Addresses that embed IPv4 are unwrapped as follows:

- IPv4-mapped `::ffff:a.b.c.d` gets the class of its IPv4 address.
- IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16` and Teredo `2001::/32` (bit-inverted client
  address) get the embedded class if it is not public. If the embedded address is public, they count as
  `Reserved`, as in HolyWisp.

gnome-net is stricter than HolyWisp in a few places. It also refuses:

- `192.88.99/24`
- `100::/64`
- `64:ff9b:1::/48`
- `3fff::/20`
- `5f00::/16`
- the rest of `2001::/23`
- all IPv6 outside `2000::/3`

On an IPv6-only host behind DNS64, IPv4-only sites resolve into `64:ff9b::/96` and are refused. HolyWisp has the
same caveat.

## Using it

### Filter lists (conditional GET, size limit)

```rust
let client = SafeClient::new(SafeClientConfig::default().source_url(cfg.source_url.clone()))?;
let cached = Validators { etag: row.etag, last_modified: row.last_modified };
match client
    .fetch_conditional(Request::get(&list.url).max_body_bytes(24 << 20).timeout(Duration::from_secs(60)), &cached)
    .await?
{
    Conditional::NotModified { validators } => { /* bump fetched_at, store validators */ }
    Conditional::Modified { response, validators } if response.status().is_success() => {
        /* sha256(response.body()) vs stored sha256: upstream ETags are weak (content-blocking.md §5.1) */
    }
    Conditional::Modified { response, .. } => { /* record HTTP error response.status() */ }
}
```

### `gnome_catalog::Fetcher` (Wave C, in gnome-server)

The adapter is a direct field mapping. This exact code was compiled and run against a local server in a scratch
crate that depends on both crates:

```rust
struct NetFetcher(gnome_net::SafeClient);

impl gnome_catalog::Fetcher for NetFetcher {
    fn fetch(&self, r: FetchRequest) -> BoxFuture<'_, Result<FetchResponse, FetchError>> {
        Box::pin(async move {
            let method = match r.method {
                gnome_catalog::Method::Get => gnome_net::Method::GET,
                gnome_catalog::Method::Post => gnome_net::Method::POST,
            };
            let mut req = gnome_net::Request::new(method, r.url)
                .max_body_bytes(r.max_body_bytes as u64)
                .timeout(r.timeout);
            for (k, v) in r.headers {
                req = req.header(k, v);
            }
            if let Some(body) = r.body {
                req = req.body(body);
            }
            match self.0.fetch(req).await {
                Ok(resp) => Ok(FetchResponse {
                    status: resp.status().as_u16(),
                    headers: resp.header_pairs(),
                    body: resp.into_body().into(),
                }),
                Err(gnome_net::Error::Timeout) => Err(FetchError::Timeout),
                Err(gnome_net::Error::BodyTooLarge { .. }) => Err(FetchError::BodyTooLarge { limit: r.max_body_bytes }),
                Err(e) if e.is_retryable() => Err(FetchError::Network(e.to_string())),
                // Policy refusals and malformed URLs/headers are not retryable.
                Err(e) => Err(FetchError::Blocked(e.to_string())),
            }
        })
    }
}
```

Catalog feed URLs are `https`, so the adapter does not set `allow_http`. The importers set their own `User-Agent`
header, which replaces the client default.

## Tests

```sh
CARGO_TARGET_DIR=/home/duderucool/.cache/gnome-targets/net cargo test -p gnome-net
CARGO_TARGET_DIR=/home/duderucool/.cache/gnome-targets/net cargo clippy -p gnome-net --all-targets -- -D warnings
```

- **Unit tests** cover the exhaustive IPv4/IPv6 classification table (mapped, compatible, NAT64, 6to4 and Teredo
  forms, `0.0.0.0`, `::`), the policy flags, resolver filtering, host patterns, config validation and forbidden
  headers.
- **`tests/client.rs`** runs against throwaway HTTP/1.1 servers on `127.0.0.1`, kernel-assigned ephemeral ports. It covers:
  - `localhost` (system resolver) refused without any connection being made
  - names that resolve to private, CGNAT, ULA, link-local, NAT64 or `0.0.0.0` addresses refused
  - IP-literal forms refused (decimal, octal, hex, percent-encoded, full-width digits, trailing dot, mapped,
    compatible and Teredo IPv6, cloud metadata addresses)
  - a decoy test proving refused addresses are never dialled
  - redirects to private or metadata destinations, a disallowed port, a disallowed host or `file:` refused
  - redirect chains followed, plus the method and credential rules
  - the 5-redirect cap
  - `Content-Length` over the limit refused early
  - a chunked stream aborted mid-stream (the server sees the connection drop)
  - gzip and brotli bombs stopped; gzip and brotli decoded correctly
  - total timeout during headers and during the body
  - connect timeout against a listener whose accept queue is full (Linux drops the SYN, as a filtering firewall
    would)
  - the 304 path, by ETag and by Last-Modified
  - the User-Agent
  - one real `https://example.com` fetch, skipped when `GNOME_NET_OFFLINE=1`
