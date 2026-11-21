//! The filter lists GNOME mirrors: a built-in registry (`docs/research/content-blocking.md` §5.1/§5.2) that the
//! operator can extend or override with `GNOME_FILTER_LISTS_FILE` (TOML).
//!
//! ```toml
//! # Replace fields of a built-in list (unset fields keep the built-in value).
//! [[list]]
//! id = "easylist"
//! url = "https://easylist.to/easylist/easylist.txt"
//! mirrors = ["https://ublockorigin.github.io/uAssetsCDN/thirdparties/easylist.txt"]
//!
//! # Stop offering a built-in list.
//! [[list]]
//! id = "plowe-0"
//! disabled = true
//!
//! # Add a list (id, name, category, url, license and homepage are required).
//! [[list]]
//! id = "my-extra"
//! name = "My extra rules"
//! category = "annoyances"          # ads | privacy | annoyances | cookies | urlparams | security
//! url = "https://lists.example.org/extra.txt"
//! mirrors = []                     # tried in order when the primary fails
//! license = "CC0-1.0"
//! homepage = "https://lists.example.org/"
//! default_enabled = false          # what the frontend enables by default
//! trusted = false                  # may use the scriptlets that need trust (only lists you fully trust)
//! max_mb = 15                      # body limit (1-64 MiB, default 15)
//!
//! # A list read from a local file instead of a URL (`file` and `url` are exclusive; `mirrors` only with `url`;
//! # `homepage` is optional). Also for the built-in `ubo-resources` (it then needs no network).
//! [[list]]
//! id = "my-local"
//! name = "My local rules"
//! category = "ads"
//! file = "/etc/gnome/filters/local.txt"  # absolute, no `..`, not under /proc, /sys or /dev
//! license = "CC0-1.0"
//! ```
//!
//! A file list is read by its own job, `filters.files` (as soon as the server serves, then every 10 minutes, also with
//! `GNOME_FILTERS_REFRESH_HOURS=0`), and by every forced refresh (`gnome-server filters refresh`,
//! `POST /admin/filters/refresh`); refresh.rs: only a regular file outside `/proc`, `/sys` and `/dev` once links are
//! resolved, opened without blocking, read with the list's size limit and a 10 s timeout, then the same checks as a
//! download. A missing file is not a configuration error: the list stays unavailable and its `last_error` says
//! `file-missing`. `/api/filters` never shows the path.
//!
//! Every URL must be `https`. Lists are uBO/ABP filter text; `!#include` lines are flattened at fetch time (same
//! origin and directory only). The one non-ABP entry is `ubo-resources` (format `resources`): uBO's redirect resources
//! and scriptlets as the JSON Ghostery's adblocker library loads, fetched from Ghostery's content-addressed CDN.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Default body limit per list (the largest list the research found, AdGuard Tracking Protection, is 15.1 MB).
pub const DEFAULT_MAX_BYTES: u64 = 15 * 1024 * 1024;
/// Upper bound for `max_mb`.
pub const MAX_MAX_MB: u64 = 64;
/// At most this many lists (each is a periodic upstream fetch and a file set on disk).
pub const MAX_LISTS: usize = 64;
/// At most this many mirrors per list.
pub const MAX_MIRRORS: usize = 4;
/// Longest `file` path accepted (bytes, Linux's `PATH_MAX`).
pub const MAX_PATH_BYTES: usize = 4096;
/// Top-level directories a `file` list may never be read from (kernel interfaces and devices, not list files).
pub const FORBIDDEN_DIRS: [&str; 3] = ["proc", "sys", "dev"];

/// What a list is for (API.md `FilterList.category`). The frontend maps categories to its built-in extensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Ads,
    Privacy,
    Annoyances,
    Cookies,
    Urlparams,
    Security,
    /// Only the redirect-resources/scriptlets entry.
    Resources,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ads => "ads",
            Self::Privacy => "privacy",
            Self::Annoyances => "annoyances",
            Self::Cookies => "cookies",
            Self::Urlparams => "urlparams",
            Self::Security => "security",
            Self::Resources => "resources",
        }
    }
}

/// How the upstream is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// uBO/ABP filter text (`text/plain`).
    Abp,
    /// uBO redirect resources + scriptlets as Ghostery JSON (`application/json`). `url` is Ghostery's
    /// `metadata.json` (the newest revision is the SHA-256 of `<rev>/list.txt`, which is verified); mirrors serve the
    /// JSON directly.
    Resources,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Abp => "abp",
            Self::Resources => "resources",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Abp => "text/plain; charset=utf-8",
            Self::Resources => "application/json",
        }
    }

    /// File extension under `$GNOME_DATA_DIR/filters/`.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Abp => "txt",
            Self::Resources => "json",
        }
    }
}

/// One list the service mirrors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListDef {
    pub id: String,
    pub name: String,
    pub category: Category,
    pub format: Format,
    /// Upstream URL (empty for a file list).
    pub url: String,
    pub mirrors: Vec<String>,
    /// Read from this local file instead of `url`/`mirrors` (`GNOME_FILTER_LISTS_FILE` `file = "/abs/path"`;
    /// validated by [`check_file_path`]). Never shown by `/api/filters`.
    pub file: Option<PathBuf>,
    pub license: String,
    pub homepage: String,
    pub default_enabled: bool,
    /// May use the scriptlets that need trust (`trusted-*` and uBO's `requiresTrust` ones, which can run code in the
    /// pages the list names; the client drops them from every other list).
    pub trusted: bool,
    pub max_bytes: u64,
}

impl ListDef {
    /// Whether the list is read from a local file (`file = "/abs/path"`) rather than fetched from `url`.
    pub fn is_file(&self) -> bool {
        self.file.is_some()
    }
}

const UBO_CDN: &str = "https://ublockorigin.github.io/uAssetsCDN/";
const UBO_PAGES: &str = "https://ublockorigin.pages.dev/";
const UBO_JSDELIVR: &str = "https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main/";
const UASSETS_HOME: &str = "https://github.com/uBlockOrigin/uAssets";
const EASYLIST_LICENSE: &str = "GPL-3.0-or-later OR CC-BY-SA-3.0";
const PLOWE_URL: &str =
    "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext";
const PLOWE_LICENSE: &str = "No explicit licence; the author permits combining and republishing it (see homepage)";
const GHOSTERY_RESOURCES: &str = "https://cdn.ghostery.com/adblocker/resources/ublock-resources-json/metadata.json";
const GHOSTERY_RESOURCES_REPO: &str = "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json";

/// A list served from uBO's CDN (`!#include` already inlined) with its two fallback mirrors.
fn ubo_cdn(path: &str) -> (String, Vec<String>) {
    (format!("{UBO_CDN}{path}"), vec![format!("{UBO_PAGES}{path}"), format!("{UBO_JSDELIVR}{path}")])
}

#[allow(clippy::too_many_arguments)]
fn abp(
    id: &str,
    name: &str,
    category: Category,
    (url, mirrors): (String, Vec<String>),
    license: &str,
    homepage: &str,
    default_enabled: bool,
    trusted: bool,
) -> ListDef {
    ListDef {
        id: id.into(),
        name: name.into(),
        category,
        format: Format::Abp,
        url,
        mirrors,
        file: None,
        license: license.into(),
        homepage: homepage.into(),
        default_enabled,
        trusted,
        max_bytes: DEFAULT_MAX_BYTES,
    }
}

/// The built-in registry (research §5.2 "balanced breakage" defaults). Ids are uBO's asset keys.
pub fn builtin() -> Vec<ListDef> {
    use Category::*;
    let easylist_mirror = |name: &str| {
        let (url, mut mirrors) = ubo_cdn(&format!("thirdparties/{name}"));
        mirrors.push(format!("https://easylist.to/easylist/{name}"));
        (url, mirrors)
    };
    vec![
        // Ad blocker (on).
        abp(
            "easylist",
            "EasyList",
            Ads,
            easylist_mirror("easylist.txt"),
            EASYLIST_LICENSE,
            "https://easylist.to/",
            true,
            false,
        ),
        abp(
            "ublock-filters",
            "uBlock filters – Ads",
            Ads,
            ubo_cdn("filters/filters.min.txt"),
            "GPL-3.0",
            UASSETS_HOME,
            true,
            true,
        ),
        abp(
            "ublock-badware",
            "uBlock filters – Badware risks",
            Security,
            ubo_cdn("filters/badware.min.txt"),
            "GPL-3.0",
            UASSETS_HOME,
            true,
            true,
        ),
        abp(
            "ublock-quick-fixes",
            "uBlock filters – Quick fixes",
            Ads,
            ubo_cdn("filters/quick-fixes.min.txt"),
            "GPL-3.0",
            UASSETS_HOME,
            true,
            true,
        ),
        abp(
            "ublock-unbreak",
            "uBlock filters – Unbreak",
            Ads,
            ubo_cdn("filters/unbreak.min.txt"),
            "GPL-3.0",
            UASSETS_HOME,
            true,
            true,
        ),
        abp(
            "plowe-0",
            "Peter Lowe’s Ad and tracking server list",
            Ads,
            (PLOWE_URL.into(), vec![]),
            PLOWE_LICENSE,
            "https://pgl.yoyo.org/adservers/",
            true,
            false,
        ),
        // Tracker blocker (on).
        abp(
            "easyprivacy",
            "EasyPrivacy",
            Privacy,
            easylist_mirror("easyprivacy.txt"),
            EASYLIST_LICENSE,
            "https://easylist.to/",
            true,
            false,
        ),
        abp(
            "ublock-privacy",
            "uBlock filters – Privacy",
            Privacy,
            ubo_cdn("filters/privacy.min.txt"),
            "GPL-3.0",
            UASSETS_HOME,
            true,
            true,
        ),
        // Strip tracking parameters (on).
        abp(
            "adguard-spyware-url",
            "AdGuard/uBO – URL Tracking Protection",
            Urlparams,
            ubo_cdn("filters/privacy-removeparam.txt"),
            "GPL-3.0",
            UASSETS_HOME,
            true,
            true,
        ),
        // Cookie notices and annoyances (off, opt-in).
        abp(
            "fanboy-cookiemonster",
            "EasyList – Cookie Notices",
            Cookies,
            ubo_cdn("thirdparties/easylist-cookies.txt"),
            "CC-BY-3.0 (Fanboy) / EasyList licence",
            "https://easylist.to/",
            false,
            false,
        ),
        abp(
            "ublock-cookies",
            "uBlock filters – Cookie Notices",
            Cookies,
            ubo_cdn("filters/annoyances-cookies.txt"),
            "GPL-3.0",
            UASSETS_HOME,
            false,
            true,
        ),
        abp(
            "ublock-annoyances-others",
            "uBlock filters – Other annoyances",
            Annoyances,
            ubo_cdn("filters/annoyances-others.txt"),
            "GPL-3.0",
            UASSETS_HOME,
            false,
            true,
        ),
        // Redirect resources + scriptlets for `$redirect` and `+js(...)` (research §2.7).
        ListDef {
            id: "ubo-resources".into(),
            name: "uBlock Origin redirect resources and scriptlets".into(),
            category: Resources,
            format: Format::Resources,
            url: GHOSTERY_RESOURCES.into(),
            mirrors: vec![GHOSTERY_RESOURCES_REPO.into()],
            file: None,
            license: "GPL-3.0".into(),
            homepage: "https://github.com/gorhill/uBlock".into(),
            default_enabled: true,
            trusted: true,
            max_bytes: 4 * 1024 * 1024,
        },
    ]
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    #[serde(default)]
    list: Vec<RawList>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawList {
    id: String,
    #[serde(default)]
    disabled: bool,
    name: Option<String>,
    category: Option<String>,
    url: Option<String>,
    mirrors: Option<Vec<String>>,
    file: Option<String>,
    license: Option<String>,
    homepage: Option<String>,
    default_enabled: Option<bool>,
    trusted: Option<bool>,
    max_mb: Option<u64>,
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.'))
}

/// `https` URL without credentials or fragment.
pub fn check_https_url(u: &str) -> Result<(), String> {
    let url = gnome_net::Url::parse(u.trim()).map_err(|e| format!("{u:?} is not a URL ({e})"))?;
    if url.scheme() != "https" {
        return Err(format!("{u:?} must be an https URL"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{u:?} must not contain credentials"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("{u:?} has no host"));
    }
    if url.fragment().is_some() {
        return Err(format!("{u:?} must not contain a #fragment"));
    }
    Ok(())
}

/// A list source (`url`, `mirrors`): a URL that passes [`check_https_url`] and uses the default port, the only
/// `https` port the fetching client allows.
pub fn check_source_url(u: &str) -> Result<(), String> {
    check_https_url(u)?;
    match gnome_net::Url::parse(u.trim()).ok().and_then(|url| url.port()) {
        Some(port) => Err(format!("{u:?} must use the default https port (443), not {port}")),
        None => Ok(()),
    }
}

/// Whether `path` (absolute) lies under one of [`FORBIDDEN_DIRS`] (`/proc`, `/sys`, `/dev`, or one of them itself).
pub fn forbidden_path(path: &Path) -> bool {
    let mut parts = path.components().skip_while(|c| matches!(c, Component::RootDir | Component::CurDir));
    matches!(parts.next(), Some(Component::Normal(first)) if FORBIDDEN_DIRS.iter().any(|d| first == *d))
}

/// A `file` source: an absolute path of at most [`MAX_PATH_BYTES`] bytes without a `..` component or NUL, not under
/// `/proc`, `/sys` or `/dev`. Whether the file exists is checked when it is read (refresh.rs), not here.
pub fn check_file_path(v: &str) -> Result<PathBuf, String> {
    if v.is_empty() {
        return Err("must not be empty".into());
    }
    if v.len() > MAX_PATH_BYTES {
        return Err(format!("must be at most {MAX_PATH_BYTES} bytes"));
    }
    if v.contains('\0') {
        return Err("must not contain NUL".into());
    }
    let path = Path::new(v);
    if !path.is_absolute() {
        return Err(format!("{v:?} must be an absolute path"));
    }
    if path.components().any(|c| c == Component::ParentDir) {
        return Err(format!("{v:?} must not contain a `..` component"));
    }
    if forbidden_path(path) {
        return Err(format!("{v:?} must not be under /proc, /sys or /dev"));
    }
    Ok(path.to_path_buf())
}

fn parse_category(v: &str) -> Result<Category, String> {
    match v.trim().to_ascii_lowercase().as_str() {
        "ads" => Ok(Category::Ads),
        "privacy" => Ok(Category::Privacy),
        "annoyances" => Ok(Category::Annoyances),
        "cookies" => Ok(Category::Cookies),
        "urlparams" => Ok(Category::Urlparams),
        "security" => Ok(Category::Security),
        other => Err(format!("unknown category {other:?} (ads, privacy, annoyances, cookies, urlparams, security)")),
    }
}

/// Read `GNOME_FILTER_LISTS_FILE` and apply it to the built-in registry. All problems are reported together.
pub fn load(path: &Path) -> Result<Vec<ListDef>, Vec<String>> {
    let text = std::fs::read_to_string(path).map_err(|e| vec![format!("cannot read {}: {e}", path.display())])?;
    apply(builtin(), path, &text)
}

/// Apply an override file (`path` is only used in messages) to `base`.
pub fn apply(mut lists: Vec<ListDef>, path: &Path, text: &str) -> Result<Vec<ListDef>, Vec<String>> {
    let raw: RawFile = toml::from_str(text).map_err(|e| vec![format!("{}: {}", path.display(), e.message())])?;
    let mut problems = Vec::new();
    let mut seen = HashSet::new();
    for (i, r) in raw.list.into_iter().enumerate() {
        let at = format!("{}: list #{} ({:?})", path.display(), i + 1, r.id);
        let mut bad = |msg: String| problems.push(format!("{at}: {msg}"));
        if !valid_id(&r.id) {
            bad("id must be 1-64 characters of [a-z0-9._-], starting with a letter or digit".into());
            continue;
        }
        if !seen.insert(r.id.clone()) {
            bad("appears twice".into());
            continue;
        }
        let existing = lists.iter().position(|l| l.id == r.id);
        if r.disabled {
            match existing {
                Some(pos) => {
                    lists.remove(pos);
                }
                None => bad("disabled = true needs the id of a built-in list".into()),
            }
            continue;
        }
        let category = match r.category.as_deref().map(parse_category).transpose() {
            Ok(c) => c,
            Err(e) => {
                bad(format!("category: {e}"));
                None
            }
        };
        if let Some(v) = &r.url
            && let Err(e) = check_source_url(v)
        {
            bad(format!("url: {e}"));
        }
        let file = match r.file.as_deref().map(check_file_path).transpose() {
            Ok(f) => f,
            Err(e) => {
                bad(format!("file: {e}"));
                None
            }
        };
        if r.file.is_some() && r.url.is_some() {
            bad("file and url are exclusive (a list is read from one of them)".into());
        }
        if r.file.is_some() && r.mirrors.is_some() {
            bad("mirrors only go with url, not with file".into());
        }
        if let Some(v) = &r.homepage
            && let Err(e) = check_https_url(v)
        {
            bad(format!("homepage: {e}"));
        }
        if let Some(m) = &r.mirrors {
            if m.len() > MAX_MIRRORS {
                bad(format!("at most {MAX_MIRRORS} mirrors"));
            }
            for u in m {
                if let Err(e) = check_source_url(u) {
                    bad(format!("mirrors: {e}"));
                }
            }
        }
        for (field, value, max) in [("name", &r.name, 80), ("license", &r.license, 160)] {
            if let Some(v) = value {
                if v.trim().is_empty() {
                    bad(format!("{field} must not be empty"));
                } else if v.chars().count() > max || v.chars().any(char::is_control) {
                    bad(format!("{field} must be at most {max} characters without control characters"));
                }
            }
        }
        if let Some(mb) = r.max_mb
            && !(1..=MAX_MAX_MB).contains(&mb)
        {
            bad(format!("max_mb must be 1-{MAX_MAX_MB}"));
        }
        match existing {
            Some(pos) => {
                let l = &mut lists[pos];
                if category.is_some() && l.format == Format::Resources {
                    bad("category of ubo-resources cannot be changed".into());
                }
                if let Some(v) = r.name {
                    l.name = v.trim().into();
                }
                if let Some(c) = category.filter(|_| l.format == Format::Abp) {
                    l.category = c;
                }
                if let Some(v) = r.url {
                    l.url = v.trim().into();
                    l.file = None;
                }
                if let Some(v) = r.mirrors {
                    l.mirrors = v.into_iter().map(|m| m.trim().to_string()).collect();
                }
                if let Some(path) = file {
                    // A file replaces the built-in sources (for `ubo-resources` also its metadata.json lookup).
                    l.file = Some(path);
                    l.url = String::new();
                    l.mirrors = Vec::new();
                }
                if let Some(v) = r.license {
                    l.license = v.trim().into();
                }
                if let Some(v) = r.homepage {
                    l.homepage = v.trim().into();
                }
                if let Some(v) = r.default_enabled {
                    l.default_enabled = v;
                }
                if let Some(v) = r.trusted {
                    l.trusted = v;
                }
                if let Some(mb) = r.max_mb {
                    l.max_bytes = mb * 1024 * 1024;
                }
            }
            None => {
                let mut missing = Vec::new();
                let from_file = r.file.is_some();
                for (field, present) in [
                    ("name", r.name.is_some()),
                    ("category", r.category.is_some()),
                    ("url or file", r.url.is_some() || from_file),
                    ("license", r.license.is_some()),
                    // A file list may have no web page (a homepage is optional there; the listing then shows "").
                    ("homepage", r.homepage.is_some() || from_file),
                ] {
                    if !present {
                        missing.push(field);
                    }
                }
                if !missing.is_empty() {
                    bad(format!("a new list needs {}", missing.join(", ")));
                    continue;
                }
                let Some(category) = category else { continue };
                lists.push(ListDef {
                    id: r.id,
                    name: r.name.unwrap_or_default().trim().into(),
                    category,
                    format: Format::Abp,
                    url: r.url.unwrap_or_default().trim().into(),
                    mirrors: r.mirrors.unwrap_or_default().into_iter().map(|m| m.trim().to_string()).collect(),
                    file,
                    license: r.license.unwrap_or_default().trim().into(),
                    homepage: r.homepage.unwrap_or_default().trim().into(),
                    default_enabled: r.default_enabled.unwrap_or(false),
                    trusted: r.trusted.unwrap_or(false),
                    max_bytes: r.max_mb.map_or(DEFAULT_MAX_BYTES, |mb| mb * 1024 * 1024),
                });
            }
        }
    }
    if lists.len() > MAX_LISTS {
        problems.push(format!("{}: at most {MAX_LISTS} lists are supported", path.display()));
    }
    if problems.is_empty() { Ok(lists) } else { Err(problems) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply_text(text: &str) -> Result<Vec<ListDef>, Vec<String>> {
        apply(builtin(), Path::new("lists.toml"), text)
    }

    #[test]
    fn builtin_registry_is_valid() {
        let lists = builtin();
        let mut ids = HashSet::new();
        for l in &lists {
            assert!(valid_id(&l.id), "{}", l.id);
            assert!(ids.insert(l.id.clone()), "duplicate {}", l.id);
            check_source_url(&l.url).unwrap();
            check_https_url(&l.homepage).unwrap();
            for m in &l.mirrors {
                check_source_url(m).unwrap();
            }
            assert!(l.mirrors.len() <= MAX_MIRRORS);
            assert!(!l.license.is_empty() && !l.name.is_empty());
        }
        // Research §5.2 defaults.
        let on: Vec<&str> = lists.iter().filter(|l| l.default_enabled).map(|l| l.id.as_str()).collect();
        assert_eq!(
            on,
            [
                "easylist",
                "ublock-filters",
                "ublock-badware",
                "ublock-quick-fixes",
                "ublock-unbreak",
                "plowe-0",
                "easyprivacy",
                "ublock-privacy",
                "adguard-spyware-url",
                "ubo-resources"
            ]
        );
        // Never AdGuard Tracking Protection or non-commercial lists.
        assert!(lists.iter().all(|l| !l.url.contains("filters/3.txt") && !l.license.contains("NC")));
        // Trusted scriptlets only from uBO's own lists.
        for l in &lists {
            assert_eq!(
                l.trusted,
                l.id.starts_with("ublock-") || l.id.starts_with("ubo-") || l.id == "adguard-spyware-url"
            );
        }
        assert!(!lists.iter().find(|l| l.id == "fanboy-cookiemonster").unwrap().default_enabled);
    }

    #[test]
    fn overrides_disable_and_add() {
        let lists = apply_text(
            r#"
            [[list]]
            id = "easylist"
            url = "https://easylist.to/easylist/easylist.txt"
            mirrors = []
            max_mb = 20

            [[list]]
            id = "plowe-0"
            disabled = true

            [[list]]
            id = "my-extra"
            name = "Extra"
            category = "annoyances"
            url = "https://lists.example.org/extra.txt"
            license = "CC0-1.0"
            homepage = "https://lists.example.org/"
            default_enabled = true
            "#,
        )
        .unwrap();
        let el = lists.iter().find(|l| l.id == "easylist").unwrap();
        assert_eq!(el.url, "https://easylist.to/easylist/easylist.txt");
        assert!(el.mirrors.is_empty());
        assert_eq!(el.max_bytes, 20 << 20);
        assert_eq!(el.name, "EasyList");
        assert!(lists.iter().all(|l| l.id != "plowe-0"));
        let extra = lists.last().unwrap();
        assert_eq!((extra.id.as_str(), extra.category, extra.format), ("my-extra", Category::Annoyances, Format::Abp));
        assert!(extra.default_enabled && !extra.trusted);
        assert_eq!(extra.max_bytes, DEFAULT_MAX_BYTES);
    }

    #[test]
    fn override_problems_are_reported_together() {
        let errs = apply_text(
            r#"
            [[list]]
            id = "Bad Id"

            [[list]]
            id = "new-one"
            name = "x"

            [[list]]
            id = "easylist"
            url = "http://easylist.to/easylist/easylist.txt"
            mirrors = ["https://user:pw@example.org/x.txt", "https://example.org:8443/x.txt"]
            category = "nope"
            max_mb = 500

            [[list]]
            id = "unknown"
            disabled = true

            [[list]]
            id = "ubo-resources"
            category = "ads"
            "#,
        )
        .unwrap_err();
        let all = errs.join("\n");
        for needle in [
            "id must be",
            "a new list needs category, url or file, license, homepage",
            "must be an https URL",
            "must not contain credentials",
            "must use the default https port (443), not 8443",
            "unknown category",
            "max_mb must be",
            "disabled = true needs",
            "category of ubo-resources",
        ] {
            assert!(all.contains(needle), "missing {needle:?} in:\n{all}");
        }
        assert!(apply_text("[[list]]\nid = \"x\"\nbogus = 1\n").is_err(), "unknown keys are rejected");
        assert!(apply_text("").unwrap() == builtin());
    }

    #[test]
    fn file_lists_are_added_and_replace_builtin_sources() {
        let lists = apply_text(
            r#"
            [[list]]
            id = "local"
            name = "Local rules"
            category = "ads"
            file = "/srv/gnome/lists/local.txt"
            license = "CC0-1.0"
            default_enabled = true
            trusted = true
            max_mb = 16

            [[list]]
            id = "ubo-resources"
            file = "/srv/gnome/lists/ubo-resources.json"

            [[list]]
            id = "easylist"
            file = "/srv/gnome/lists/easylist.txt"
            "#,
        )
        .unwrap();
        let local = lists.iter().find(|l| l.id == "local").unwrap();
        assert_eq!(local.file.as_deref(), Some(Path::new("/srv/gnome/lists/local.txt")));
        assert!(local.is_file() && local.url.is_empty() && local.mirrors.is_empty());
        assert_eq!((local.category, local.format, local.homepage.as_str()), (Category::Ads, Format::Abp, ""));
        assert!(local.default_enabled && local.trusted);
        assert_eq!(local.max_bytes, 16 << 20);
        // The built-in resources entry keeps its format, category and trust; the file replaces CDN and mirror.
        let res = lists.iter().find(|l| l.id == "ubo-resources").unwrap();
        assert_eq!(res.file.as_deref(), Some(Path::new("/srv/gnome/lists/ubo-resources.json")));
        assert!(res.url.is_empty() && res.mirrors.is_empty());
        assert_eq!((res.format, res.category, res.trusted), (Format::Resources, Category::Resources, true));
        let el = lists.iter().find(|l| l.id == "easylist").unwrap();
        assert!(el.is_file() && el.url.is_empty() && el.mirrors.is_empty() && el.name == "EasyList");
        // Every other built-in still fetches from its URL.
        assert!(
            lists
                .iter()
                .filter(|l| !["local", "ubo-resources", "easylist"].contains(&l.id.as_str()))
                .all(|l| !l.is_file())
        );
    }

    #[test]
    fn file_list_problems() {
        let long = format!("/{}", "a".repeat(MAX_PATH_BYTES));
        let errs = apply_text(&format!(
            r#"
            [[list]]
            id = "both"
            name = "x"
            category = "ads"
            license = "x"
            url = "https://lists.example.org/x.txt"
            file = "/srv/x.txt"

            [[list]]
            id = "mirrored-file"
            name = "x"
            category = "ads"
            license = "x"
            file = "/srv/x.txt"
            mirrors = ["https://lists.example.org/x.txt"]

            [[list]]
            id = "relative"
            name = "x"
            category = "ads"
            license = "x"
            file = "lists/x.txt"

            [[list]]
            id = "dotdot"
            name = "x"
            category = "ads"
            license = "x"
            file = "/srv/lists/../../etc/passwd"

            [[list]]
            id = "proc"
            name = "x"
            category = "ads"
            license = "x"
            file = "/proc/self/environ"

            [[list]]
            id = "sys"
            name = "x"
            category = "ads"
            license = "x"
            file = "//sys/kernel/x"

            [[list]]
            id = "dev"
            name = "x"
            category = "ads"
            license = "x"
            file = "/./dev/zero"

            [[list]]
            id = "long"
            name = "x"
            category = "ads"
            license = "x"
            file = "{long}"

            [[list]]
            id = "nul"
            name = "x"
            category = "ads"
            license = "x"
            file = "/srv/x\u0000.txt"

            [[list]]
            id = "nameless"
            category = "ads"
            file = "/srv/x.txt"
            "#
        ))
        .unwrap_err();
        let all = errs.join("\n");
        for needle in [
            "\"both\"): file and url are exclusive",
            "\"mirrored-file\"): mirrors only go with url",
            "\"relative\"): file: \"lists/x.txt\" must be an absolute path",
            "\"dotdot\"): file: \"/srv/lists/../../etc/passwd\" must not contain a `..` component",
            "\"proc\"): file: \"/proc/self/environ\" must not be under /proc, /sys or /dev",
            "\"sys\"): file: \"//sys/kernel/x\" must not be under",
            "\"dev\"): file: \"/./dev/zero\" must not be under",
            "\"long\"): file: must be at most 4096 bytes",
            "\"nul\"): file: must not contain NUL",
            "\"nameless\"): a new list needs name, license",
        ] {
            assert!(all.contains(needle), "missing {needle:?} in:\n{all}");
        }
        // Lookalikes of the forbidden directories are fine; the paths themselves and their children are not.
        for ok in ["/procfs/x.txt", "/srv/proc/x.txt", "/device.txt", "/system/x.txt", "/a/b/./c.txt"] {
            assert!(check_file_path(ok).is_ok(), "{ok}");
        }
        for bad in ["/proc", "/sys/", "/dev/stdin", "/dev/fd/0"] {
            assert!(check_file_path(bad).is_err(), "{bad}");
        }
        assert!(forbidden_path(Path::new("/proc/1/mem")) && !forbidden_path(Path::new("/srv/dev/x")));
    }
}
