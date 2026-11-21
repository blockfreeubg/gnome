//! Text hygiene for feed-provided strings (research §9.4).
//!
//! Every string that reaches the database goes through [`clean_line`] (titles, names, tags) or [`clean_block`]
//! (descriptions, instructions):
//! 1. Control characters (C0 except line breaks, DEL, C1), bidirectional controls, zero-width and other invisible
//!    characters (Hangul fillers, braille blank, tag characters) are removed; they have no business in a game title
//!    and can be used for spoofing. This happens before every markup pass, so a removed character can never split
//!    a tag name (`<scr\0ipt>`) that would only become a tag afterwards.
//! 2. HTML entities are decoded (`&amp;`, `&#233;`, `&eacute;`, ...) and HTML markup is stripped (`<br>`/`</p>`
//!    become line breaks, `<script>`/`<style>` contents are dropped); then entities are decoded once more, because
//!    some feeds double-escape (`Dash &amp;amp; Slash`), and markup is stripped again, so no tag survives whatever
//!    the escaping depth. Markup = known HTML elements, closing tags, and tags of any name that carry attributes
//!    (`<details ontoggle=…>`); other text in angle brackets (`Press <Space>`, `I <3 it`) is kept.
//! 3. Whitespace is normalized (one line: single spaces; blocks: trimmed lines, at most one blank line) and runs of
//!    combining marks are capped ("Zalgo" text).
//! 4. The result is capped at a character limit (cut at a word boundary with `…` for blocks).
//!
//! Every step is linear in the input, and the input is cut at [`MAX_INPUT_BYTES`] first, so a hostile feed field
//! cannot make cleaning slow. Text that is plain by contract (the operator's OSS manifest) goes through
//! [`clean_plain_line`] / [`clean_plain_block`] instead, which keep `<` and `&` literally.

use std::borrow::Cow;

/// Maximum title length (characters).
pub const MAX_TITLE: usize = 120;
/// Maximum developer / author name length.
pub const MAX_NAME: usize = 100;
/// Maximum description length.
pub const MAX_DESCRIPTION: usize = 5000;
/// Maximum instructions length.
pub const MAX_INSTRUCTIONS: usize = 3000;
/// Maximum tag length.
pub const MAX_TAG: usize = 40;

/// Longest input the cleaners look at (bytes). Longer fields are cut first (at a character boundary); outputs are
/// capped far below this, so only pathological feed fields lose text.
pub const MAX_INPUT_BYTES: usize = 256 * 1024;
/// Combining marks kept in a row ("Zalgo" text stacks dozens; real scripts need at most a few).
const MAX_COMBINING_RUN: usize = 4;

/// Clean a single-line string (title, developer, tag). Returns an empty string when nothing printable is left.
pub fn clean_line(s: &str, max_chars: usize) -> String {
    truncate_chars(&collapse_line(&to_plain(s)), max_chars, false)
}

/// [`clean_line`] for text that is plain by contract (the operator's manifest): `<` and `&` are taken literally.
pub fn clean_plain_line(s: &str, max_chars: usize) -> String {
    truncate_chars(&collapse_line(bounded(s)), max_chars, false)
}

/// Collapse whitespace to single spaces, drop unwanted characters and cap runs of combining marks (no markup
/// handling).
fn collapse_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    let mut combining = 0usize;
    for c in text.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            combining = 0;
            continue;
        }
        if is_unwanted(c) {
            continue;
        }
        if is_combining_mark(c) {
            combining += 1;
            if combining > MAX_COMBINING_RUN {
                continue;
            }
        } else {
            combining = 0;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    out
}

/// Clean a multi-line text (description, instructions): paragraphs are kept, runs of spaces collapse, at most one
/// empty line separates paragraphs.
pub fn clean_block(s: &str, max_chars: usize) -> String {
    block(&to_plain(s), max_chars)
}

/// [`clean_block`] for text that is plain by contract (the operator's manifest): `<` and `&` are taken literally
/// ("a breakout game in a `<canvas>`").
pub fn clean_plain_block(s: &str, max_chars: usize) -> String {
    block(bounded(s), max_chars)
}

fn block(text: &str, max_chars: usize) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(text.len());
    let mut blank_lines = 0usize;
    for line in text.split(['\n', '\u{2028}', '\u{2029}']) {
        let cleaned = collapse_line(line);
        if cleaned.is_empty() {
            blank_lines += 1;
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
            if blank_lines > 0 {
                out.push('\n');
            }
        }
        blank_lines = 0;
        out.push_str(&cleaned);
    }
    truncate_chars(&out, max_chars, true)
}

/// `s` cut to at most [`MAX_INPUT_BYTES`] (at a character boundary).
fn bounded(s: &str) -> &str {
    if s.len() <= MAX_INPUT_BYTES {
        return s;
    }
    let mut cut = MAX_INPUT_BYTES;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}

/// Remove unwanted characters, decode entities, strip markup, then decode and strip once more (see module docs).
fn to_plain(s: &str) -> String {
    let s = remove_unwanted(bounded(s));
    let s = strip_html(&remove_unwanted(&decode_entities(&s)));
    let s = remove_unwanted(&decode_entities(&s)).into_owned();
    if s.contains('<') { strip_html(&s) } else { s }
}

/// `s` without [`is_unwanted`] characters (borrowed when there are none).
fn remove_unwanted(s: &str) -> Cow<'_, str> {
    if s.chars().any(is_unwanted) {
        Cow::Owned(s.chars().filter(|c| !is_unwanted(*c)).collect())
    } else {
        Cow::Borrowed(s)
    }
}

/// Characters removed from every cleaned string (whitespace is handled separately).
fn is_unwanted(c: char) -> bool {
    matches!(c,
        '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'..='\u{9f}'
        // zero-width space/joiners, LRM/RLM, word joiner and invisible operators, BOM, soft hyphen, combining
        // grapheme joiner, Mongolian vowel separator
        | '\u{200b}'..='\u{200f}' | '\u{2060}'..='\u{2064}' | '\u{feff}' | '\u{ad}' | '\u{34f}' | '\u{180e}'
        // bidirectional embeddings, overrides, isolates and the Arabic letter mark
        | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{61c}'
        // "letters" that render blank: Hangul fillers, Khmer invisible vowels, braille blank, musical formatting
        | '\u{115f}' | '\u{1160}' | '\u{3164}' | '\u{ffa0}' | '\u{17b4}' | '\u{17b5}' | '\u{2800}'
        | '\u{1d173}'..='\u{1d17a}'
        // tag characters (invisible), interlinear annotation, object replacement, replacement char
        | '\u{e0000}'..='\u{e007f}' | '\u{fff9}'..='\u{fffc}' | '\u{fffd}')
}

/// Combining marks from the blocks used to stack "Zalgo" text.
fn is_combining_mark(c: char) -> bool {
    matches!(c,
        '\u{300}'..='\u{36f}' | '\u{483}'..='\u{489}' | '\u{1ab0}'..='\u{1aff}' | '\u{1dc0}'..='\u{1dff}'
        | '\u{20d0}'..='\u{20ff}' | '\u{fe20}'..='\u{fe2f}')
}

/// Whether `s` contains characters that [`clean_line`] would remove (used to reject identifiers and URLs).
pub fn has_control_chars(s: &str) -> bool {
    s.chars().any(|c| is_unwanted(c) || (c.is_control() && c != ' '))
}

/// Truncate to `max` characters. Blocks are cut at a word boundary when one is close and get an ellipsis.
pub fn truncate_chars(s: &str, max: usize, ellipsis: bool) -> String {
    if max == usize::MAX || s.chars().count() <= max {
        return s.to_owned();
    }
    let keep = if ellipsis { max.saturating_sub(1) } else { max };
    let cut = s.char_indices().nth(keep).map_or(s.len(), |(i, _)| i);
    let mut head = &s[..cut];
    if ellipsis
        && let Some(sp) = head.rfind(char::is_whitespace)
        && sp >= head.len() * 4 / 5
    {
        head = &head[..sp];
    }
    let mut out = head.trim_end().to_owned();
    if ellipsis {
        out.push('…');
    }
    out
}

/// HTML element names the stripper always removes. Any other name in angle brackets is text (`Press <Space> to
/// jump`) unless the tag carries attributes (`<details ontoggle=…>`) or is a closing tag: that is markup, whatever
/// the name.
const HTML_ELEMENTS: &[&str] = &[
    "a",
    "abbr",
    "acronym",
    "address",
    "applet",
    "area",
    "article",
    "aside",
    "audio",
    "b",
    "base",
    "basefont",
    "bdi",
    "bdo",
    "big",
    "blink",
    "blockquote",
    "body",
    "br",
    "button",
    "canvas",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "details",
    "dialog",
    "div",
    "dl",
    "dt",
    "em",
    "embed",
    "fieldset",
    "figcaption",
    "figure",
    "font",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "i",
    "iframe",
    "img",
    "input",
    "ins",
    "keygen",
    "label",
    "legend",
    "li",
    "link",
    "main",
    "mark",
    "marquee",
    "math",
    "meta",
    "nav",
    "nobr",
    "noembed",
    "noframes",
    "noscript",
    "object",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "picture",
    "pre",
    "s",
    "script",
    "section",
    "select",
    "small",
    "source",
    "span",
    "strike",
    "strong",
    "style",
    "sub",
    "summary",
    "sup",
    "svg",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "tt",
    "u",
    "ul",
    "video",
    "wbr",
    "xmp",
];

/// Block-level elements whose boundaries become line breaks.
const BLOCK_ELEMENTS: &[&str] = &[
    "address",
    "article",
    "blockquote",
    "br",
    "dd",
    "details",
    "dialog",
    "div",
    "dl",
    "dt",
    "fieldset",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tr",
    "ul",
];

/// Elements removed together with their content (scripts, styles, embedded documents, raw-text elements).
const DROP_CONTENT: &[&str] =
    &["script", "style", "noscript", "template", "noembed", "noframes", "xmp", "textarea", "title", "iframe", "object"];

/// Longest tag name the stripper considers (longer names are text).
const MAX_TAG_NAME: usize = 32;
/// How far the stripper looks for the `>` of a tag whose name is not a known element (keeps `<x <x <x …` linear).
const MAX_UNKNOWN_TAG: usize = 512;

/// Remove HTML markup: known elements (see `HTML_ELEMENTS`), closing tags and tags of any name that carry
/// attributes, comments and `<!DOCTYPE>`/`<?…?>` declarations. Block-level boundaries become line breaks;
/// `<script>`, `<style>` and the other `DROP_CONTENT` elements are removed with their contents. Text in angle
/// brackets that is not markup (`<Space>`, `a < b`, `I <3 it`) is kept. An unterminated element with attributes
/// (a feed that cut a description mid-tag) drops the rest of the input. Linear in the input length.
pub fn strip_html(s: &str) -> String {
    if !s.contains('<') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    let mut last = 0usize;
    while let Some(off) = s[i..].find('<') {
        let lt = i + off;
        let rest = &s[lt + 1..];
        // Comments and declarations.
        if let Some(body) = rest.strip_prefix("!--") {
            out.push_str(&s[last..lt]);
            i = body.find("-->").map_or(s.len(), |e| lt + 1 + 3 + e + 3);
            last = i;
            continue;
        }
        if rest.starts_with('!') || rest.starts_with('?') {
            out.push_str(&s[last..lt]);
            i = rest.find('>').map_or(s.len(), |g| lt + 1 + g + 1);
            last = i;
            continue;
        }
        let closing = rest.starts_with('/');
        let name_part = if closing { &rest[1..] } else { rest };
        let name_len = name_part.bytes().take_while(u8::is_ascii_alphanumeric).count();
        let name = name_part[..name_len].to_ascii_lowercase();
        let after_name = name_part[name_len..].chars().next();
        let separated = after_name.is_none_or(|c| c == '>' || c == '/' || c.is_whitespace());
        if name.is_empty() || name_len > MAX_TAG_NAME || !name.as_bytes()[0].is_ascii_alphabetic() || !separated {
            i = lt + 1;
            continue;
        }
        let known = HTML_ELEMENTS.contains(&name.as_str());
        let Some(close) = tag_end(rest, if known { usize::MAX } else { MAX_UNKNOWN_TAG }) else {
            if known && after_name.is_some_and(|c| c.is_whitespace() || c == '/') {
                // Truncated mid-tag: drop the rest.
                out.push_str(&s[last..lt]);
                last = s.len();
                break;
            }
            i = lt + 1;
            continue;
        };
        // An unknown name is markup when it is a closing tag (`</x>`) or carries attributes (`<x a=1>`).
        let attributes = &rest[(usize::from(closing) + name_len).min(close)..close];
        if !known && !closing && !attributes.contains('=') {
            i = lt + 1;
            continue;
        }
        out.push_str(&s[last..lt]);
        i = lt + 1 + close + 1;
        if !closing && DROP_CONTENT.contains(&name.as_str()) {
            i = end_of_element(s, i, &name);
        } else if BLOCK_ELEMENTS.contains(&name.as_str()) {
            out.push('\n');
        } else if matches!(name.as_str(), "img" | "td" | "th") {
            out.push(' ');
        }
        last = i;
    }
    if last < s.len() {
        out.push_str(&s[last..]);
    }
    out
}

/// Index after the end tag `</name …>` of an element whose content starts at `from` (the end of `s` when there is
/// none). The name is compared case-insensitively and must not continue (`</scriptx>` does not end a script).
fn end_of_element(s: &str, from: usize, name: &str) -> usize {
    let bytes = s.as_bytes();
    let mut i = from;
    while let Some(off) = s[i..].find("</") {
        let start = i + off + 2;
        let end = start + name.len();
        if end <= bytes.len()
            && bytes[start..end].eq_ignore_ascii_case(name.as_bytes())
            && bytes.get(end).is_none_or(|b| !b.is_ascii_alphanumeric())
        {
            return s[end..].find('>').map_or(s.len(), |g| end + g + 1);
        }
        i = start;
    }
    s.len()
}

/// Index of the `>` that ends a tag whose text starts at `rest` (quoted attribute values may contain `>`), looking
/// at most `limit` bytes ahead.
fn tag_end(rest: &str, limit: usize) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (i, b) in rest.bytes().enumerate() {
        if i > limit {
            return None;
        }
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'"' || b == b'\'' => quote = Some(b),
            None if b == b'>' => return Some(i),
            None => {}
        }
    }
    None
}

/// Decode HTML character references: named entities from a common subset of HTML5, decimal (`&#233;`) and hex
/// (`&#xE9;`). Unknown or malformed references are left untouched. Code points that are not valid characters, or
/// are NUL, become U+FFFD and are later removed by the cleaners.
pub fn decode_entities(s: &str) -> Cow<'_, str> {
    if !s.contains('&') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        match parse_entity(after) {
            Some((decoded, consumed)) => {
                out.push_str(&decoded);
                rest = &after[consumed..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// Parse the text after `&`. Returns the replacement and the number of bytes consumed (including `;`).
fn parse_entity(after: &str) -> Option<(Cow<'static, str>, usize)> {
    // `;` is ASCII, so its byte index is a char boundary.
    let window = &after.as_bytes()[..after.len().min(34)];
    let semi = window.iter().position(|&b| b == b';')?;
    let name = &after[..semi];
    if let Some(num) = name.strip_prefix('#') {
        let value = if let Some(hex) = num.strip_prefix(['x', 'X']) {
            if hex.is_empty() || hex.len() > 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            u32::from_str_radix(hex, 16).ok()?
        } else {
            if num.is_empty() || num.len() > 7 || !num.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            num.parse::<u32>().ok()?
        };
        let c = match value {
            0 => '\u{fffd}',
            // Windows-1252 code points that HTML maps for compatibility.
            0x80..=0x9f => cp1252(value).unwrap_or('\u{fffd}'),
            v => char::from_u32(v).unwrap_or('\u{fffd}'),
        };
        return Some((Cow::Owned(c.to_string()), semi + 1));
    }
    if name.is_empty() || name.len() > 10 || !name.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let decoded = named_entity(name)?;
    Some((Cow::Borrowed(decoded), semi + 1))
}

fn cp1252(v: u32) -> Option<char> {
    Some(match v {
        0x80 => '€',
        0x82 => '‚',
        0x84 => '„',
        0x85 => '…',
        0x8b => '‹',
        0x91 => '‘',
        0x92 => '’',
        0x93 => '“',
        0x94 => '”',
        0x95 => '•',
        0x96 => '–',
        0x97 => '—',
        0x99 => '™',
        0x9b => '›',
        _ => return None,
    })
}

fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" | "AMP" => "&",
        "lt" | "LT" => "<",
        "gt" | "GT" => ">",
        "quot" | "QUOT" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "ensp" => "\u{2002}",
        "emsp" => "\u{2003}",
        "thinsp" => "\u{2009}",
        "shy" => "\u{ad}",
        "zwj" => "\u{200d}",
        "zwnj" => "\u{200c}",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "lsquo" => "‘",
        "rsquo" => "’",
        "sbquo" => "‚",
        "ldquo" => "“",
        "rdquo" => "”",
        "bdquo" => "„",
        "laquo" => "«",
        "raquo" => "»",
        "lsaquo" => "‹",
        "rsaquo" => "›",
        "bull" => "•",
        "middot" => "·",
        "prime" => "′",
        "Prime" => "″",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "deg" => "°",
        "plusmn" => "±",
        "times" => "×",
        "divide" => "÷",
        "minus" => "−",
        "frac12" => "½",
        "frac14" => "¼",
        "frac34" => "¾",
        "sup1" => "¹",
        "sup2" => "²",
        "sup3" => "³",
        "micro" => "µ",
        "para" => "¶",
        "sect" => "§",
        "cent" => "¢",
        "pound" => "£",
        "euro" => "€",
        "yen" => "¥",
        "curren" => "¤",
        "iexcl" => "¡",
        "iquest" => "¿",
        "ordf" => "ª",
        "ordm" => "º",
        "larr" => "←",
        "rarr" => "→",
        "uarr" => "↑",
        "darr" => "↓",
        "harr" => "↔",
        "hearts" => "♥",
        "spades" => "♠",
        "clubs" => "♣",
        "diams" => "♦",
        "star" => "☆",
        "check" => "✓",
        "infin" => "∞",
        "le" => "≤",
        "ge" => "≥",
        "ne" => "≠",
        "Agrave" => "À",
        "Aacute" => "Á",
        "Acirc" => "Â",
        "Atilde" => "Ã",
        "Auml" => "Ä",
        "Aring" => "Å",
        "AElig" => "Æ",
        "Ccedil" => "Ç",
        "Egrave" => "È",
        "Eacute" => "É",
        "Ecirc" => "Ê",
        "Euml" => "Ë",
        "Igrave" => "Ì",
        "Iacute" => "Í",
        "Icirc" => "Î",
        "Iuml" => "Ï",
        "ETH" => "Ð",
        "Ntilde" => "Ñ",
        "Ograve" => "Ò",
        "Oacute" => "Ó",
        "Ocirc" => "Ô",
        "Otilde" => "Õ",
        "Ouml" => "Ö",
        "Oslash" => "Ø",
        "Ugrave" => "Ù",
        "Uacute" => "Ú",
        "Ucirc" => "Û",
        "Uuml" => "Ü",
        "Yacute" => "Ý",
        "THORN" => "Þ",
        "szlig" => "ß",
        "agrave" => "à",
        "aacute" => "á",
        "acirc" => "â",
        "atilde" => "ã",
        "auml" => "ä",
        "aring" => "å",
        "aelig" => "æ",
        "ccedil" => "ç",
        "egrave" => "è",
        "eacute" => "é",
        "ecirc" => "ê",
        "euml" => "ë",
        "igrave" => "ì",
        "iacute" => "í",
        "icirc" => "î",
        "iuml" => "ï",
        "eth" => "ð",
        "ntilde" => "ñ",
        "ograve" => "ò",
        "oacute" => "ó",
        "ocirc" => "ô",
        "otilde" => "õ",
        "ouml" => "ö",
        "oslash" => "ø",
        "ugrave" => "ù",
        "uacute" => "ú",
        "ucirc" => "û",
        "uuml" => "ü",
        "yacute" => "ý",
        "thorn" => "þ",
        "yuml" => "ÿ",
        "OElig" => "Œ",
        "oelig" => "œ",
        "Scaron" => "Š",
        "scaron" => "š",
        "Yuml" => "Ÿ",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_are_decoded_including_double_escaping() {
        assert_eq!(clean_line("Dash &amp; Slash", 100), "Dash & Slash");
        assert_eq!(clean_line("Dash &amp;amp; Slash", 100), "Dash & Slash");
        assert_eq!(clean_line("Caf&eacute; &#233;&#xE9; &ndash; ok", 100), "Café éé – ok");
        assert_eq!(clean_line("Tom &unknown; &#xZZ; & Jerry &", 100), "Tom &unknown; &#xZZ; & Jerry &");
        assert_eq!(clean_line("&#0;x&#1;y&#150;", 100), "xy–");
        assert_eq!(clean_line("a&nbsp;&nbsp;b", 100), "a b");
    }

    #[test]
    fn html_is_stripped_and_scripts_dropped() {
        assert_eq!(clean_line("<b>Bold</b> move", 100), "Bold move");
        assert_eq!(clean_line("x <script>alert('<b>')</script> y", 100), "x y");
        assert_eq!(clean_line("<STYLE>p{}</style>Hi", 100), "Hi");
        assert_eq!(clean_line("5 < 10 and a<b", 100), "5 < 10 and a<b");
        assert_eq!(
            clean_line("Press <Space> to jump, <- and -> to move", 100),
            "Press <Space> to jump, <- and -> to move"
        );
        assert_eq!(clean_line("<!DOCTYPE html><?xml x?>Hi<SPAN class=x>!</SPAN>", 100), "Hi!");
        assert_eq!(clean_line("&lt;i&gt;escaped&lt;/i&gt; markup", 100), "escaped markup");
        assert_eq!(clean_line("<img src=\"a>b.png\" alt='x'>Season Shift", 100), "Season Shift");
        assert_eq!(clean_line("before<!-- <b>gone</b> -->after", 100), "beforeafter");
        assert_eq!(clean_line("cut <a href=\"x", 100), "cut");
        assert_eq!(clean_block("<p>One</p><p>Two<br>Three</p>\n\n\n\nFour", 100), "One\n\nTwo\nThree\n\nFour");
    }

    #[test]
    fn controls_bidi_and_zero_width_are_removed() {
        assert_eq!(clean_line("Ev\u{202e}il\u{200b} Ga\u{0}me\u{7}\u{feff}", 100), "Evil Game");
        assert!(has_control_chars("abc\u{1}"));
        assert!(has_control_chars("abc\u{202e}"));
        assert!(!has_control_chars("Prism Match 3D – Ünïcode"));
    }

    #[test]
    fn whitespace_is_normalized() {
        assert_eq!(clean_line("  Drift City Car Driving  Games\t\n ", 100), "Drift City Car Driving Games");
        assert_eq!(
            clean_block("  line one  \r\n   line   two \r\r\r\rline three", 100),
            "line one\nline two\n\nline three"
        );
        assert_eq!(clean_block("\n\n\n", 100), "");
    }

    #[test]
    fn caps_respect_char_boundaries() {
        assert_eq!(clean_line("ééééé", 3), "ééé");
        let long = "word ".repeat(100);
        let t = clean_block(&long, 50);
        assert!(t.chars().count() <= 50, "{t}");
        assert!(t.ends_with('…'));
        assert!(!t.contains("wor…"), "cut at a word boundary: {t}");
        assert_eq!(truncate_chars("short", 10, true), "short");
    }
}
