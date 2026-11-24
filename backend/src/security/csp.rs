//! Content-Security-Policy values.
//!
//! **This is the one place to tune the shell policy** (e.g. after end-to-end engine testing). It applies to HTML
//! documents served from `GNOME_STATIC_DIR` (the SPA shell); proxied pages are produced by the engines' service
//! worker and are not affected. Inline `<script>` blocks in served HTML files are allowed automatically: the static
//! index computes their `'sha256-…'` hashes at startup ([`inline_script_hashes`]). Inline event-handler attributes
//! (`onclick=…`) are *not* allowed. `GNOME_CSP` selects enforcing, report-only or off ([`headers_for`]).
//!
//! The proxy origin (ARCHITECTURE §4.6) gets the policies of [`ProxyPolicies`], none of them permissive: engine-host
//! documents get the verified engine-host policy ([`engine_host_csp`], `frame-ancestors <app origin(s)>`: the engine
//! host relies on it to know its parent is GNOME) and the operator's `GNOME_PROXY_CSP` as a second policy; the bare-mux
//! worker gets [`bare_mux_worker_csp`]; other scripts the proxied-document policy; everything else `default-src
//! 'none'`. `GNOME_ALLOW_CUSTOM_WISP` adds `ws: wss:` to the engine host and the worker, and nothing else changes
//! them (no URL parameter is read). The proxy role never sends `X-Frame-Options`.

use http::HeaderValue;

use super::crypto::{b64_std, sha256};
use crate::config::CspMode;
use crate::origins::ProxySetup;

/// Directives of the shell policy, in order. `script-src` additionally receives per-file inline-script hashes;
/// `connect-src` and `frame-src` are completed from the origin setup by [`shell_policy`].
pub const SHELL_DIRECTIVES: &[(&str, &[&str])] = &[
    ("default-src", &["'self'"]),
    // 'wasm-unsafe-eval': the libcurl/epoxy Wisp transports and Scramjet's rewriter are WebAssembly.
    ("script-src", &["'self'", "'wasm-unsafe-eval'"]),
    // blob: workers are used by the transports (bare-mux shared worker / wasm workers).
    ("worker-src", &["'self'", "blob:"]),
    // Single-origin mode adds ws:/wss: (the engines run here and may use the user's own Wisp servers); with a proxy
    // origin the app itself opens no WebSockets.
    ("connect-src", &["'self'"]),
    // The engine host (its origin with a proxy origin; 'self' otherwise) and the game wrapper `/play-frame/<slug>`
    // ('self', WAVE-C D2/D4). The engine iframe's own navigations are checked against this list, and escaped proxied
    // code can navigate it (ENGINE-PROTOCOL §1.1), so nothing else may be on it: no game-embed host (each game is
    // framed through its wrapper, whose own policy names that one embed origin) and no other app page can render
    // framed (the shell sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`; the wrapper runs no script and
    // frames only its game). `blob:`: Firefox checks the engine host's own blob download (`<a download>` of a page,
    // "Save link as") against this list as a navigation of the engine iframe, and refused it, so nothing was saved; a
    // blob: URL belongs to the origin that made it, so only proxy-origin blobs, which keep their creator's strict
    // policy, can load there (no new route).
    ("frame-src", &["blob:"]),
    ("img-src", &["'self'", "data:", "blob:", "https:"]),
    ("style-src", &["'self'", "'unsafe-inline'"]),
    ("font-src", &["'self'"]),
    ("manifest-src", &["'self'"]),
    ("object-src", &["'none'"]),
    ("base-uri", &["'self'"]),
    ("form-action", &["'self'"]),
    // Nothing frames the SPA shell (WAVE-C D4).
    ("frame-ancestors", &["'none'"]),
];

/// Policy sent on non-HTML app responses: only forbids cross-origin framing.
pub const FRAME_ANCESTORS_ONLY: &str = "frame-ancestors 'self'";

/// What shell HTML gets as its enforced policy in report-only and off modes (non-HTML app answers keep
/// [`FRAME_ANCESTORS_ONLY`]).
pub const SHELL_FRAME_ANCESTORS_ONLY: &str = "frame-ancestors 'none'";

/// Policy of answers produced outside the security-headers middleware (hyper's own error answers, a panic caught
/// outside the middleware; `server::ConnIo`, `router`): nothing runs or loads, and no browser renders it in a frame,
/// so it is never a permissive realm on the proxy origin.
pub const NOTHING_RUNS_UNFRAMED: &str =
    "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/// Render the shell policy for the origin setup, with extra `script-src` sources.
pub fn shell_policy(proxy: &ProxySetup, script_hashes: &[String]) -> String {
    let mut out = String::with_capacity(768);
    for (name, sources) in SHELL_DIRECTIVES {
        if !out.is_empty() {
            out.push_str("; ");
        }
        out.push_str(name);
        let extra: Vec<&str> = match *name {
            "script-src" => script_hashes.iter().map(String::as_str).collect(),
            "connect-src" if !proxy.isolated() => vec!["ws:", "wss:"],
            "frame-src" => std::iter::once("'self'").chain(proxy.origin()).collect(),
            "img-src" => proxy.origin().into_iter().collect(),
            _ => Vec::new(),
        };
        for s in sources.iter().copied().chain(extra) {
            out.push(' ');
            out.push_str(s);
        }
    }
    out
}

/// The CSP header values for one HTML document under the configured mode.
#[derive(Debug, Clone)]
pub struct CspHeaders {
    /// `Content-Security-Policy`.
    pub enforce: HeaderValue,
    /// `Content-Security-Policy-Report-Only` (report-only mode).
    pub report_only: Option<HeaderValue>,
}

pub fn headers_for(mode: CspMode, proxy: &ProxySetup, script_hashes: &[String]) -> CspHeaders {
    let policy = || header(&shell_policy(proxy, script_hashes));
    let frame_only = HeaderValue::from_static(SHELL_FRAME_ANCESTORS_ONLY);
    match mode {
        CspMode::On => CspHeaders { enforce: policy(), report_only: None },
        CspMode::ReportOnly => CspHeaders { enforce: frame_only, report_only: Some(policy()) },
        CspMode::Off => CspHeaders { enforce: frame_only, report_only: None },
    }
}

fn header(policy: &str) -> HeaderValue {
    HeaderValue::from_str(policy).expect("CSP is ASCII")
}

/// The game wrapper's only style (`games::frames::WRAPPER_STYLE`), allowed by its hash.
pub const WRAPPER_STYLE: &str = "html,body{margin:0;height:100%;overflow:hidden;background:#000}iframe{display:block;width:100%;height:100%;border:0}";

/// `'sha256-…'` of [`WRAPPER_STYLE`].
pub fn wrapper_style_hash() -> &'static str {
    static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HASH.get_or_init(|| format!("'sha256-{}'", b64_std(&sha256(WRAPPER_STYLE.as_bytes()))))
}

/// Policy of a game wrapper document (WAVE-C D2), rendered per request by `games::frames`:
/// `default-src 'none'; frame-src <frame_source>; style-src '<WRAPPER_STYLE hash>'; base-uri 'none';
/// form-action 'none'; frame-ancestors 'self'`. `frame_source` is `https://<host>[:port]` for a network or developer
/// embed, `<proxy origin>/oss/<slug>/` for an OSS game; callers pass only values `FramePolicy::allows` accepted.
pub fn wrapper_csp(frame_source: &str) -> String {
    format!(
        "default-src 'none'; frame-src {frame_source}; style-src {}; base-uri 'none'; form-action 'none'; \
         frame-ancestors 'self'",
        wrapper_style_hash()
    )
}

/// Policy of open-source game documents under `/oss/` (WAVE-C D5): `PROXIED_DOCUMENT_CSP` without `blob:` in
/// `connect-src` (`connect-src 'self'`), then `frame-ancestors <app origins>`; for an `isolated = true` entry
/// `; sandbox allow-scripts` is added (`allow-pointer-lock` too when the entry declares `pointer_lock = true`): an
/// opaque origin with no access to the proxy realm.
pub fn oss_document_csp(app_origins: &[&str], isolated: bool, pointer_lock: bool) -> String {
    let mut out = format!(
        "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; \
         form-action 'self'; frame-ancestors {}",
        app_origins.join(" ")
    );
    if isolated {
        out.push_str("; sandbox allow-scripts");
        if pointer_lock {
            out.push_str(" allow-pointer-lock");
        }
    }
    out
}

/// `Permissions-Policy` of app-origin HTML (WAVE-C D3). Every name is one Chromium recognizes (e2e games-player P12:
/// Chromium logs "Unrecognized feature: 'bluetooth'", so Web Bluetooth, which needs a user-chosen device anyway, is
/// not named); fullscreen, autoplay, gamepad, clipboard-write and the motion sensors are left to iframe `allow`.
pub const PERMISSIONS_POLICY: &str = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), \
    hid=(), midi=(), display-capture=(), screen-wake-lock=(), idle-detection=(), \
    publickey-credentials-get=(), publickey-credentials-create=(), otp-credentials=(), identity-credentials-get=(), \
    xr-spatial-tracking=(), local-fonts=(), window-management=()";

/// `Cross-Origin-Opener-Policy` of app-origin HTML (WAVE-C D3).
pub const OPENER_POLICY: &str = "same-origin";

/// The app origins as the proxy-origin policies take them: empty in single-origin mode (the app is `'self'` there).
fn policy_app_origins(proxy: &ProxySetup) -> Vec<&str> {
    if proxy.isolated() { proxy.app_origins().iter().map(String::as_str).collect() } else { Vec::new() }
}

/// `frame-ancestors` sources for proxy-origin content other than the engine host: `'self'` (the engine host frames
/// its tabs) and the app origin(s) (`proxyFrameAncestors` of proxy-origin.ts without the directive name).
fn ancestors(app_origins: &[&str]) -> String {
    std::iter::once("'self'").chain(app_origins.iter().copied()).collect::<Vec<_>>().join(" ")
}

// ── Proxy-origin policies (ARCHITECTURE §4.6; the contract: frontend/src/shared/proxy-origin.ts) ─────────────────
//
// Escaped proxied code can open ANY same-origin URL in a hidden frame (or as a worker) and run `fetch`, `WebSocket`
// or `new Image()` from that realm, which obeys the CSP of that response, not the proxied page's. So every response
// of the proxy role carries a policy at least as strict as `PROXIED_DOCUMENT_CSP` ("no permissive realm"), and no URL
// parameter changes any of them. The strings below are mirrored byte for byte from proxy-origin.ts; the unit tests
// compare them with `backend/tests/fixtures/proxy-origin-csp.json`, which is generated by running the TypeScript
// functions (`tests/e2e/engine/suites/backend-proxy.mjs` re-checks it, and the live headers, against the contract).

/// `PROXIED_DOCUMENT_CSP` of proxy-origin.ts: what the engines put on proxied documents and workers. `blob:` in
/// `connect-src`: Ultraviolet's service worker (`/sw.js` runs under [`proxy_script_csp`]) fetches the blob: URLs a page
/// makes; a blob: URL resolves from the proxy origin's own blob store, so nothing leaves the browser.
pub const PROXIED_DOCUMENT_CSP: &str = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' blob:; form-action 'self'";

/// `ENGINE_HOST_CSP_DIRECTIVES` of proxy-origin.ts: the engine-host directives after `frame-ancestors` (`blob:` in
/// `connect-src`: Scramjet's controller fetches a page's blob: URLs in the engine host).
pub const ENGINE_HOST_CSP_DIRECTIVES: &str = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:; form-action 'self'";

/// `CUSTOM_WISP_CONNECT_SOURCES` of proxy-origin.ts: what `GNOME_ALLOW_CUSTOM_WISP=true` adds to `connect-src` of
/// the engine host and the bare-mux worker (and nothing else).
pub const CUSTOM_WISP_CONNECT_SOURCES: &str = "ws: wss:";

/// `engineHostCsp(appOrigins, {customWisp})` of proxy-origin.ts, byte for byte.
pub fn engine_host_csp(app_origins: &[&str], custom_wisp: bool) -> String {
    let ancestors = if app_origins.is_empty() { "'none'".to_string() } else { app_origins.join(" ") };
    let extra = if custom_wisp { format!(" {CUSTOM_WISP_CONNECT_SOURCES}") } else { String::new() };
    let directives = ENGINE_HOST_CSP_DIRECTIVES.replacen(
        "connect-src 'self' data: blob:",
        &format!("connect-src 'self' data: blob:{extra}"),
        1,
    );
    format!("frame-ancestors {ancestors}; {directives}")
}

/// `bareMuxWorkerCsp({customWisp})` of proxy-origin.ts, byte for byte.
pub fn bare_mux_worker_csp(custom_wisp: bool) -> String {
    if custom_wisp { format!("connect-src 'self' {CUSTOM_WISP_CONNECT_SOURCES}") } else { "connect-src 'self'".into() }
}

/// URL path of the bare-mux SharedWorker (`VENDOR.bareMuxWorker`), which gets [`bare_mux_worker_csp`].
pub const BARE_MUX_WORKER_PATH: &str = "/vendor/bare-mux/worker.js";

/// `proxyScriptCsp(appOrigins)` of proxy-origin.ts, byte for byte: [`PROXIED_DOCUMENT_CSP`] plus `frame-ancestors
/// 'self' <app origins>` (`app_origins` empty in single-origin mode). The opt-in never changes it.
pub fn proxy_script_csp(app_origins: &[&str]) -> String {
    format!("{PROXIED_DOCUMENT_CSP}; frame-ancestors {}", ancestors(app_origins))
}

/// `bareMuxWorkerScriptCsp(appOrigins, {customWisp})` of proxy-origin.ts, byte for byte: [`proxy_script_csp`], whose
/// `connect-src` also gets [`CUSTOM_WISP_CONNECT_SOURCES`] with `custom_wisp` (a response's policies are all enforced,
/// so the opt-in must be in both of the worker's policies to take effect).
pub fn bare_mux_worker_script_csp(app_origins: &[&str], custom_wisp: bool) -> String {
    let policy = proxy_script_csp(app_origins);
    if custom_wisp {
        policy.replacen(
            "connect-src 'self' blob:",
            &format!("connect-src 'self' blob: {CUSTOM_WISP_CONNECT_SOURCES}"),
            1,
        )
    } else {
        policy
    }
}

/// `proxyInertCsp(appOrigins)` of proxy-origin.ts, byte for byte: nothing runs, loads, submits or re-bases.
pub fn proxy_inert_csp(app_origins: &[&str]) -> String {
    format!("default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors {}", ancestors(app_origins))
}

/// The policies of every proxy-role response, computed once from the origin setup and `GNOME_ALLOW_CUSTOM_WISP`.
#[derive(Debug, Clone)]
pub struct ProxyPolicies {
    /// Engine-host documents (`/engine/` and the HTML files under it): [`engine_host_csp`] with the app origins
    /// (`'self'` in single-origin mode).
    pub engine_host: HeaderValue,
    /// `/vendor/bare-mux/worker.js`: [`bare_mux_worker_csp`].
    pub bare_mux_worker: HeaderValue,
    /// The second policy of `/vendor/bare-mux/worker.js` ([`bare_mux_worker_script_csp`]): `connect-src` alone leaves
    /// the worker (and the worker URL opened as a document) free to load scripts, images and frames from any host, so
    /// it also gets the script policy, whose `connect-src` carries `ws: wss:` under the custom-Wisp opt-in like the
    /// first policy (otherwise this one would block the custom servers the opt-in allows).
    pub bare_mux_worker_script: HeaderValue,
    /// Every other script (`/sw.js`, `/assets/*.js`, `/vendor/**/*.js`, `/engine/*.js`; [`proxy_script_csp`]): it may
    /// run as a worker (or be registered as one by escaped code), so it gets no more than a proxied document. The
    /// opt-in never changes it.
    pub script: HeaderValue,
    /// Everything where nothing runs (JSON, the 404s, `/api/health`, `/api/filters*`, wasm, styles, images, text,
    /// other HTML; [`proxy_inert_csp`]): `default-src 'none'`, no forms, no `<base>`.
    pub none: HeaderValue,
    /// The compiled-in "engine host not built" page: like `none`, plus its inline styles.
    pub styled: HeaderValue,
    /// The engine-prefix `503` page ([`engine_retry_policy`]).
    pub retry: HeaderValue,
}

impl ProxyPolicies {
    /// `retry_hashes`: the inline-script hashes of the engine-prefix `503` page.
    pub fn new(proxy: &ProxySetup, custom_wisp: bool, retry_hashes: &[String]) -> Self {
        let apps = policy_app_origins(proxy);
        let engine_ancestors: Vec<&str> = if proxy.isolated() { apps.clone() } else { vec!["'self'"] };
        let framed = ancestors(&apps);
        Self {
            engine_host: header(&engine_host_csp(&engine_ancestors, custom_wisp)),
            bare_mux_worker: header(&bare_mux_worker_csp(custom_wisp)),
            bare_mux_worker_script: header(&bare_mux_worker_script_csp(&apps, custom_wisp)),
            script: header(&proxy_script_csp(&apps)),
            none: header(&proxy_inert_csp(&apps)),
            styled: header(&format!(
                "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors \
                 {framed}"
            )),
            retry: engine_retry_policy(proxy, retry_hashes),
        }
    }
}

/// `GNOME_PROXY_CSP` as the **second** policy of engine-host documents (a second `Content-Security-Policy` header,
/// so it can only restrict the built-in one). When it has a `script-src` without `'unsafe-inline'`, the document's
/// inline-script hashes are added to it (as for the shell).
pub fn operator_engine_policy(extra: &str, script_hashes: &[String]) -> HeaderValue {
    let mut policy = String::with_capacity(extra.len() + 64);
    for directive in extra.split(';').map(str::trim).filter(|d| !d.is_empty()) {
        if !policy.is_empty() {
            policy.push_str("; ");
        }
        policy.push_str(directive);
        let mut words = directive.split_ascii_whitespace();
        let is_script_src = words.next().is_some_and(|n| n.eq_ignore_ascii_case("script-src"));
        if is_script_src && !words.any(|w| w.eq_ignore_ascii_case("'unsafe-inline'")) {
            for h in script_hashes {
                policy.push(' ');
                policy.push_str(h);
            }
        }
    }
    header(&policy)
}

/// Policy of the server's own "proxy engine not ready" page (static_files' engine retry page): exactly its own
/// inline script (by hash), inline styles, and registering `/sw.js` (the exact URL when the proxy origin is known,
/// `'self'` in single-origin mode, where the server cannot tell the origin when it starts); nothing else loads or
/// connects. The engine host frames it in a tab, so its ancestors are the engine host (`'self'`) and the app.
pub fn engine_retry_policy(proxy: &ProxySetup, script_hashes: &[String]) -> HeaderValue {
    let worker = match proxy.origin() {
        Some(origin) => format!("{origin}/sw.js"),
        None => "'self'".into(),
    };
    header(&format!(
        "default-src 'none'; script-src {}; worker-src {worker}; style-src 'unsafe-inline'; base-uri 'none'; \
         form-action 'none'; frame-ancestors {}",
        script_hashes.join(" "),
        ancestors(&policy_app_origins(proxy))
    ))
}

/// `'sha256-<base64>'` sources for every inline `<script>` (one without a `src` attribute) in `html`, hashed the way
/// browsers do (over the element's text after HTML newline normalization).
pub fn inline_script_hashes(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase(); // byte offsets are identical to `html`
    let bytes = lower.as_bytes();
    let mut hashes = Vec::new();
    let mut pos = 0;
    while let Some(found) = lower[pos..].find("<script") {
        let after_name = pos + found + "<script".len();
        if !matches!(bytes.get(after_name), Some(b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')) {
            pos = after_name;
            continue;
        }
        let Some(tag_len) = find_tag_end(&bytes[after_name..]) else { break };
        let attrs = &lower[after_name..after_name + tag_len];
        let content_start = after_name + tag_len + 1;
        let Some(close) = lower[content_start..].find("</script") else { break };
        let content_end = content_start + close;
        if !has_attribute(attrs, "src") {
            let text = html[content_start..content_end].replace("\r\n", "\n").replace('\r', "\n");
            let h = format!("'sha256-{}'", b64_std(&sha256(text.as_bytes())));
            if !hashes.contains(&h) {
                hashes.push(h);
            }
        }
        pos = content_end + "</script".len();
    }
    hashes
}

/// Index of the `>` closing a start tag, skipping quoted attribute values.
fn find_tag_end(b: &[u8]) -> Option<usize> {
    let mut quote = None;
    for (i, &c) in b.iter().enumerate() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                b'"' | b'\'' => quote = Some(c),
                b'>' => return Some(i),
                _ => {}
            },
        }
    }
    None
}

/// Whether a (lowercased) start-tag attribute string contains attribute `name`.
fn has_attribute(attrs: &str, name: &str) -> bool {
    let b = attrs.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        if &attrs[start..i] == name {
            return true;
        }
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                i += 1;
            } else {
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
            }
        }
        if i == start {
            i += 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_origins() -> ProxySetup {
        let (mut p, mut w) = (Vec::new(), Vec::new());
        let s = ProxySetup::resolve(
            Some("https://p.gnome.example.com"),
            None,
            &["https://gnome.example.com".to_string()],
            "0.0.0.0:8080".parse().unwrap(),
            &mut p,
            &mut w,
        );
        assert!(p.is_empty() && w.is_empty(), "{p:?} {w:?}");
        s
    }

    #[test]
    fn policy_contains_required_directives() {
        let p = shell_policy(&ProxySetup::single_origin(), &[]);
        for needle in [
            "default-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "worker-src 'self' blob:",
            "connect-src 'self' ws: wss:",
            "frame-src blob: 'self';",
            "img-src 'self' data: blob: https:;",
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ] {
            assert!(p.contains(needle), "missing {needle} in {p}");
        }
        assert!(!p.contains(" 'unsafe-eval'"), "plain JS eval must stay forbidden");
        assert!(!p.contains("script-src 'self' 'unsafe-inline'"), "inline scripts are allowed by hash only");
        assert!(!p.contains("gamedistribution") && !p.contains("itch.io"), "no game-embed host in the shell: {p}");
        let with = shell_policy(&ProxySetup::single_origin(), &["'sha256-abc'".into()]);
        assert!(with.contains("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc'"));
    }

    #[test]
    fn isolated_shell_frames_only_the_proxy_origin_and_opens_no_websockets() {
        let p = shell_policy(&two_origins(), &[]);
        // Only the engine host: escaped code can navigate the engine iframe to anything this list allows.
        assert!(p.contains("; frame-src blob: 'self' https://p.gnome.example.com;"), "{p}");
        // OSS thumbnails come from the proxy origin (plain HTTP in development).
        assert!(p.contains("; img-src 'self' data: blob: https: https://p.gnome.example.com;"), "{p}");
        assert!(p.ends_with("; frame-ancestors 'none'"), "{p}");
        assert!(p.contains("connect-src 'self';"), "{p}");
        assert!(!p.contains("ws:"), "{p}");
    }

    /// The fixture is generated by running the TypeScript contract (frontend/src/shared/proxy-origin.ts).
    const FIXTURE: &str = include_str!("../../tests/fixtures/proxy-origin-csp.json");

    #[test]
    fn policies_match_the_typescript_contract() {
        let f: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(f["PROXIED_DOCUMENT_CSP"], PROXIED_DOCUMENT_CSP);
        assert_eq!(f["ENGINE_HOST_CSP_DIRECTIVES"], ENGINE_HOST_CSP_DIRECTIVES);
        assert_eq!(f["CUSTOM_WISP_CONNECT_SOURCES"], CUSTOM_WISP_CONNECT_SOURCES);
        assert_eq!(f["bareMuxWorkerPath"], BARE_MUX_WORKER_PATH);
        let cases = f["engineHostCsp"].as_array().unwrap();
        assert!(cases.len() >= 8, "{cases:?}");
        for case in cases {
            let origins: Vec<&str> =
                case["appOrigins"].as_array().unwrap().iter().map(|o| o.as_str().unwrap()).collect();
            let custom = case["customWisp"].as_bool().unwrap();
            assert_eq!(engine_host_csp(&origins, custom), case["csp"].as_str().unwrap(), "{case}");
        }
        for case in f["bareMuxWorkerCsp"].as_array().unwrap() {
            assert_eq!(bare_mux_worker_csp(case["customWisp"].as_bool().unwrap()), case["csp"].as_str().unwrap());
        }
        let origins_of = |case: &serde_json::Value| -> Vec<String> {
            case["appOrigins"].as_array().unwrap().iter().map(|o| o.as_str().unwrap().to_string()).collect()
        };
        for (key, min) in [("proxyScriptCsp", 3), ("bareMuxWorkerScriptCsp", 6), ("proxyInertCsp", 3)] {
            let cases = f[key].as_array().unwrap_or_else(|| panic!("{key} missing: regenerate the fixture"));
            assert!(cases.len() >= min, "{key}: {cases:?}");
            for case in cases {
                let origins = origins_of(case);
                let o: Vec<&str> = origins.iter().map(String::as_str).collect();
                let custom = case["customWisp"].as_bool().unwrap_or(false);
                let got = match key {
                    "proxyScriptCsp" => proxy_script_csp(&o),
                    "bareMuxWorkerScriptCsp" => bare_mux_worker_script_csp(&o, custom),
                    _ => proxy_inert_csp(&o),
                };
                assert_eq!(got, case["csp"].as_str().unwrap(), "{key} {case}");
            }
        }
    }

    /// The setup gnome-server resolves for the fixture's app origins: single-origin for none, else two-origin with a
    /// proxy origin of the same scheme.
    fn setup_for(app_origins: &[String]) -> ProxySetup {
        if app_origins.is_empty() {
            return ProxySetup::single_origin();
        }
        let proxy =
            if app_origins[0].starts_with("https:") { "https://p.gnome.example.com" } else { "http://127.0.0.1:8081" };
        let (mut p, mut w) = (Vec::new(), Vec::new());
        let s = ProxySetup::resolve(Some(proxy), None, app_origins, "127.0.0.1:8080".parse().unwrap(), &mut p, &mut w);
        assert!(p.is_empty(), "{p:?}");
        assert!(s.isolated());
        s
    }

    /// What the server really sends ([`ProxyPolicies`]) equals the TypeScript contract's functions for every fixture
    /// case, so proxy-origin.ts and gnome-server cannot drift apart silently.
    #[test]
    fn proxy_policies_match_the_typescript_contract() {
        let f: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let case_for = |key: &str, origins: &[String], custom: Option<bool>| -> String {
            let cases = f[key].as_array().unwrap_or_else(|| panic!("{key} missing: regenerate the fixture"));
            let c = cases
                .iter()
                .find(|c| {
                    let o: Vec<&str> =
                        c["appOrigins"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
                    o == origins.iter().map(String::as_str).collect::<Vec<_>>()
                        && custom.is_none_or(|w| c["customWisp"].as_bool() == Some(w))
                })
                .unwrap_or_else(|| panic!("no {key} case for {origins:?} {custom:?}"));
            c["csp"].as_str().unwrap().to_string()
        };
        let mut checked = 0;
        for case in f["proxyInertCsp"].as_array().unwrap() {
            let origins: Vec<String> =
                case["appOrigins"].as_array().unwrap().iter().map(|o| o.as_str().unwrap().to_string()).collect();
            let setup = setup_for(&origins);
            // In single-origin mode the server frames the engine host from 'self' (the app is the same origin).
            let engine_origins = if origins.is_empty() { vec!["'self'".to_string()] } else { origins.clone() };
            for custom in [false, true] {
                let p = ProxyPolicies::new(&setup, custom, &[]);
                assert_eq!(p.engine_host, case_for("engineHostCsp", &engine_origins, Some(custom)), "{origins:?}");
                let worker: Vec<_> = f["bareMuxWorkerCsp"].as_array().unwrap().iter().collect();
                let worker = worker.iter().find(|c| c["customWisp"].as_bool() == Some(custom)).unwrap();
                assert_eq!(p.bare_mux_worker, worker["csp"].as_str().unwrap());
                assert_eq!(p.bare_mux_worker_script, case_for("bareMuxWorkerScriptCsp", &origins, Some(custom)));
                assert_eq!(p.script, case_for("proxyScriptCsp", &origins, None), "{origins:?}");
                assert_eq!(p.none, case_for("proxyInertCsp", &origins, None), "{origins:?}");
                checked += 1;
            }
        }
        assert!(checked >= 6, "{checked}");
    }

    /// The constants are also read straight from the TypeScript source when the repository has it, so a contract
    /// change without a regenerated fixture fails here.
    #[test]
    fn fixture_constants_are_the_typescript_literals() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../frontend/src/shared/proxy-origin.ts");
        let Ok(ts) = std::fs::read_to_string(path) else { return };
        for (name, value) in [
            ("PROXIED_DOCUMENT_CSP", PROXIED_DOCUMENT_CSP),
            ("ENGINE_HOST_CSP_DIRECTIVES", ENGINE_HOST_CSP_DIRECTIVES),
            ("CUSTOM_WISP_CONNECT_SOURCES", CUSTOM_WISP_CONNECT_SOURCES),
        ] {
            let decl = format!("export const {name} =");
            let at = ts.find(&decl).unwrap_or_else(|| panic!("{name} not in proxy-origin.ts"));
            let rest = &ts[at + decl.len()..];
            let rest = rest.trim_start();
            let quote = rest.chars().next().unwrap();
            let literal = rest[1..].split(quote).next().unwrap();
            assert_eq!(literal, value, "{name}");
        }
        assert!(ts.contains(&format!("bareMuxWorker: '{BARE_MUX_WORKER_PATH}'")), "VENDOR.bareMuxWorker");
    }

    #[test]
    fn proxy_origin_policies() {
        let iso = two_origins();
        let p = ProxyPolicies::new(&iso, false, &["'sha256-r'".into()]);
        assert_eq!(
            p.engine_host,
            "frame-ancestors https://gnome.example.com; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' \
             'wasm-unsafe-eval'; connect-src 'self' data: blob:; form-action 'self'"
        );
        assert_eq!(p.bare_mux_worker, "connect-src 'self'");
        assert_eq!(p.script, format!("{PROXIED_DOCUMENT_CSP}; frame-ancestors 'self' https://gnome.example.com"));
        assert_eq!(
            p.bare_mux_worker_script, p.script,
            "without the opt-in the worker's second policy is the script one"
        );
        assert_eq!(
            p.none,
            "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self' https://gnome.example.com"
        );
        assert!(p.styled.to_str().unwrap().starts_with("default-src 'none'; style-src 'unsafe-inline';"));
        assert_eq!(
            p.retry,
            "default-src 'none'; script-src 'sha256-r'; worker-src https://p.gnome.example.com/sw.js; style-src \
             'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://gnome.example.com"
        );
        let custom = ProxyPolicies::new(&iso, true, &[]);
        assert!(custom.engine_host.to_str().unwrap().contains("connect-src 'self' data: blob: ws: wss:; form-action"));
        assert_eq!(custom.bare_mux_worker, "connect-src 'self' ws: wss:");
        // Both of the worker's policies are enforced: the opt-in must widen the second one too, and only connect-src.
        assert_eq!(
            custom.bare_mux_worker_script,
            "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' blob: \
             ws: wss:; form-action 'self'; frame-ancestors 'self' https://gnome.example.com"
        );
        assert_eq!(custom.script, p.script, "the opt-in changes only the engine host and the worker");
        assert_eq!(custom.none, p.none);
        assert_eq!(custom.retry, ProxyPolicies::new(&iso, false, &[]).retry);

        let single = ProxySetup::single_origin();
        let s = ProxyPolicies::new(&single, false, &[]);
        assert!(s.engine_host.to_str().unwrap().starts_with("frame-ancestors 'self'; default-src 'self' data:"));
        assert!(s.none.to_str().unwrap().ends_with("frame-ancestors 'self'"));
        assert!(s.retry.to_str().unwrap().contains("worker-src 'self';"), "{:?}", s.retry);

        // Every policy but the two that run the engines restricts connect-src to 'self' or 'none'.
        for v in [&p.script, &p.none, &p.styled, &p.retry] {
            let v = v.to_str().unwrap();
            assert!(v.contains("connect-src 'self'") || v.starts_with("default-src 'none'"), "{v}");
            assert!(!v.contains("ws:") && !v.contains("https:;"), "{v}");
        }
    }

    #[test]
    fn operator_policy_is_separate_and_gets_hashes() {
        let tuned =
            operator_engine_policy("script-src 'self' 'wasm-unsafe-eval'; object-src 'none'", &["'sha256-x'".into()]);
        assert_eq!(tuned, "script-src 'self' 'wasm-unsafe-eval' 'sha256-x'; object-src 'none'");
        let unsafe_inline = operator_engine_policy("script-src 'self' 'unsafe-inline'", &["'h'".into()]);
        assert_eq!(unsafe_inline, "script-src 'self' 'unsafe-inline'");
        assert_eq!(operator_engine_policy("img-src 'self'", &["'h'".into()]), "img-src 'self'");
    }

    #[test]
    fn hashes_only_inline_scripts() {
        let html = "<html><head>\r\n<script>let a = 1;\r\n</script>\
                    <script type=\"module\" src=\"/assets/app.js\"></script>\
                    <SCRIPT data-src=\"x\">b()</SCRIPT><scripted>no</scripted>\
                    <script src=/x.js></script><script>let a = 1;\n</script></head></html>";
        let hashes = inline_script_hashes(html);
        // "let a = 1;\n" (CRLF normalized; duplicate collapsed) and "b()".
        assert_eq!(hashes.len(), 2, "{hashes:?}");
        let expected = format!("'sha256-{}'", b64_std(&sha256(b"let a = 1;\n")));
        assert_eq!(hashes[0], expected);
        assert_eq!(hashes[1], format!("'sha256-{}'", b64_std(&sha256(b"b()"))));
    }

    #[test]
    fn modes() {
        let single = ProxySetup::single_origin();
        let on = headers_for(CspMode::On, &single, &[]);
        assert!(on.enforce.to_str().unwrap().contains("script-src"));
        assert!(on.report_only.is_none());
        let ro = headers_for(CspMode::ReportOnly, &single, &[]);
        assert_eq!(ro.enforce, SHELL_FRAME_ANCESTORS_ONLY);
        assert!(ro.report_only.unwrap().to_str().unwrap().contains("script-src"));
        let off = headers_for(CspMode::Off, &single, &[]);
        assert_eq!(off.enforce, SHELL_FRAME_ANCESTORS_ONLY);
    }

    #[test]
    fn wrapper_and_oss_policies() {
        let w = wrapper_csp("https://html5.gamepix.com");
        let hash = format!("'sha256-{}'", b64_std(&sha256(WRAPPER_STYLE.as_bytes())));
        assert_eq!(
            w,
            format!(
                "default-src 'none'; frame-src https://html5.gamepix.com; style-src {hash}; base-uri 'none'; \
                 form-action 'none'; frame-ancestors 'self'"
            )
        );
        let app = ["https://gnome.example.com"];
        let doc = oss_document_csp(&app, false, false);
        assert_eq!(
            doc,
            "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; \
             form-action 'self'; frame-ancestors https://gnome.example.com"
        );
        assert!(!doc.contains("'self' https://gnome"), "a proxied page must not frame an OSS game");
        assert!(oss_document_csp(&app, true, false).ends_with("; sandbox allow-scripts"));
        assert!(oss_document_csp(&app, true, true).ends_with("; sandbox allow-scripts allow-pointer-lock"));
        assert!(!oss_document_csp(&app, false, true).contains("sandbox"));
        for name in ["camera=()", "geolocation=()", "payment=()", "usb=()"] {
            assert!(PERMISSIONS_POLICY.contains(name));
        }
        // Names Chromium does not recognize log a console error on every app page (e2e games-player P12).
        assert!(!PERMISSIONS_POLICY.contains("bluetooth"));
        for left_to_allow in ["fullscreen", "autoplay", "gamepad", "clipboard-write", "accelerometer", "gyroscope"] {
            assert!(!PERMISSIONS_POLICY.contains(left_to_allow), "{left_to_allow}");
        }
    }
}
