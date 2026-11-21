//! URL slugs: ASCII, lowercase, stable once assigned, unique across the catalog.
//!
//! A game's slug is chosen when it is first imported (from the source's own slug when it has one, else the title)
//! and never changes afterwards, even if the title does, so links and favorites keep working. Collisions get `-2`,
//! `-3`, ... in import order, then a suffix derived from the record's source id (see `store::unique_slug`).

/// Maximum length of a slug base (a stored slug may also carry a collision suffix, see [`MAX_STORED_SLUG`]).
pub const MAX_SLUG: usize = 80;
/// Maximum length of a stored slug (the schema's `CHECK (length(slug) BETWEEN 1 AND 96)`): a base plus the longest
/// collision suffix the store generates.
pub const MAX_STORED_SLUG: usize = 96;

/// Slugs that would collide with fixed API/route segments (`/api/games/sections`, `/games/oss/...`).
pub const RESERVED: &[&str] = &[
    "admin",
    "api",
    "by-ids",
    "categories",
    "category",
    "featured",
    "new",
    "oss",
    "play",
    "popular",
    "random",
    "search",
    "sections",
    "tag",
    "tags",
    "thumb",
    "trending",
];

/// ASCII transliteration of common Latin letters (enough for slugs and fuzzy keys; other scripts are dropped).
pub fn transliterate(c: char) -> Option<&'static str> {
    Some(match c {
        'À'..='Å' | 'à'..='å' | 'Ā' | 'ā' | 'Ă' | 'ă' | 'Ą' | 'ą' => "a",
        'Æ' | 'æ' => "ae",
        'Ç' | 'ç' | 'Ć' | 'ć' | 'Ĉ' | 'ĉ' | 'Ċ' | 'ċ' | 'Č' | 'č' => "c",
        'Ð' | 'ð' | 'Ď' | 'ď' | 'Đ' | 'đ' => "d",
        'È'..='Ë' | 'è'..='ë' | 'Ē' | 'ē' | 'Ĕ' | 'ĕ' | 'Ė' | 'ė' | 'Ę' | 'ę' | 'Ě' | 'ě' => "e",
        'Ĝ' | 'ĝ' | 'Ğ' | 'ğ' | 'Ġ' | 'ġ' | 'Ģ' | 'ģ' => "g",
        'Ĥ' | 'ĥ' | 'Ħ' | 'ħ' => "h",
        'Ì'..='Ï' | 'ì'..='ï' | 'Ĩ' | 'ĩ' | 'Ī' | 'ī' | 'Ĭ' | 'ĭ' | 'Į' | 'į' | 'İ' | 'ı' => "i",
        'Ĵ' | 'ĵ' => "j",
        'Ķ' | 'ķ' => "k",
        'Ĺ' | 'ĺ' | 'Ļ' | 'ļ' | 'Ľ' | 'ľ' | 'Ŀ' | 'ŀ' | 'Ł' | 'ł' => "l",
        'Ñ' | 'ñ' | 'Ń' | 'ń' | 'Ņ' | 'ņ' | 'Ň' | 'ň' => "n",
        'Ò'..='Ö' | 'Ø' | 'ò'..='ö' | 'ø' | 'Ō' | 'ō' | 'Ŏ' | 'ŏ' | 'Ő' | 'ő' => "o",
        'Œ' | 'œ' => "oe",
        'Ŕ' | 'ŕ' | 'Ŗ' | 'ŗ' | 'Ř' | 'ř' => "r",
        'Ś' | 'ś' | 'Ŝ' | 'ŝ' | 'Ş' | 'ş' | 'Š' | 'š' => "s",
        'ß' => "ss",
        'Ţ' | 'ţ' | 'Ť' | 'ť' | 'Ŧ' | 'ŧ' => "t",
        'Þ' | 'þ' => "th",
        'Ù'..='Ü' | 'ù'..='ü' | 'Ũ' | 'ũ' | 'Ū' | 'ū' | 'Ŭ' | 'ŭ' | 'Ů' | 'ů' | 'Ű' | 'ű' | 'Ų' | 'ų' => {
            "u"
        }
        'Ŵ' | 'ŵ' => "w",
        'Ý' | 'ý' | 'ÿ' | 'Ÿ' | 'Ŷ' | 'ŷ' => "y",
        'Ź' | 'ź' | 'Ż' | 'ż' | 'Ž' | 'ž' => "z",
        _ => return None,
    })
}

/// Lowercase ASCII-folded form of `s` (unmapped non-ASCII letters and digits are kept as they are).
pub fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match transliterate(c) {
            Some(t) => out.push_str(t),
            None => out.extend(c.to_lowercase()),
        }
    }
    out
}

/// Turn arbitrary text into a slug: `[a-z0-9-]`, no leading/trailing/double hyphens, at most [`MAX_SLUG`] chars
/// (cut at a hyphen when possible). Returns an empty string when nothing ASCII-alphanumeric is left.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut hyphen = false;
    for c in fold(s).chars() {
        if c.is_ascii_alphanumeric() {
            if hyphen && !out.is_empty() {
                out.push('-');
            }
            hyphen = false;
            out.push(c);
        } else if c == '\'' || c == '’' {
            // "Baldi's" -> "baldis"
        } else {
            hyphen = true;
        }
    }
    if out.len() > MAX_SLUG {
        let cut = &out[..MAX_SLUG];
        let cut = match cut.rfind('-') {
            Some(p) if p >= MAX_SLUG / 2 => &cut[..p],
            _ => cut,
        };
        out = cut.trim_end_matches('-').to_owned();
    }
    out
}

/// Whether `s` is a well-formed slug (what the server should accept in `/api/games/:slug` before querying).
pub fn is_valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_STORED_SLUG
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
}

/// The slug base for a new record: the source's slug hint, else the title, else `<source>-<id>`; reserved words
/// get a `-game` suffix.
pub fn base_slug(hint: Option<&str>, title: &str, source_id_fallback: &str) -> String {
    let mut s = hint.map(slugify).filter(|s| !s.is_empty()).unwrap_or_default();
    if s.is_empty() {
        s = slugify(title);
    }
    if s.is_empty() {
        s = slugify(source_id_fallback);
    }
    if s.is_empty() {
        s = "game".to_owned();
    }
    if RESERVED.contains(&s.as_str()) {
        s.push_str("-game");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_is_ascii_and_tidy() {
        assert_eq!(slugify("Piece of Cake: Merge & Bake"), "piece-of-cake-merge-bake");
        assert_eq!(slugify("piece-of-cake-merge--bake"), "piece-of-cake-merge-bake");
        assert_eq!(slugify("  Pokémon™ Ünïcödé ßtraße  "), "pokemon-unicode-sstrasse");
        assert_eq!(slugify("Baldi's Basics"), "baldis-basics");
        assert_eq!(slugify("Slither.io"), "slither-io");
        assert_eq!(slugify("忍者"), "");
        assert_eq!(slugify("---"), "");
        let long = slugify(&"verylongword ".repeat(20));
        assert!(long.len() <= MAX_SLUG && !long.ends_with('-') && is_valid_slug(&long), "{long}");
    }

    #[test]
    fn base_slug_fallbacks_and_reserved() {
        assert_eq!(base_slug(Some("prism-match-3d"), "Prism Match 3D", "737HCH"), "prism-match-3d");
        assert_eq!(base_slug(None, "忍者", "737HCH"), "737hch");
        assert_eq!(base_slug(None, "", ""), "game");
        assert_eq!(base_slug(Some("sections"), "Sections", "x"), "sections-game");
        assert_eq!(base_slug(None, "Tags", "x"), "tags-game");
    }

    #[test]
    fn slug_validation() {
        assert!(is_valid_slug("abc-2"));
        assert!(is_valid_slug(&format!("{}-0a356be9", "a".repeat(MAX_SLUG))), "hashed collision suffix");
        assert!(!is_valid_slug(&"a".repeat(MAX_STORED_SLUG + 1)));
        for bad in ["", "-a", "a-", "a--b", "A", "a b", "a/b", "ä"] {
            assert!(!is_valid_slug(bad), "{bad}");
        }
    }
}
