//! Minimal RSS 2.0 item reader (itch.io browse feeds, js13kGames yearly feeds).
//!
//! Each `<item>` becomes an ordered list of `(path, value)` pairs, where `path` is the element's local name
//! relative to the item (`title`, `platforms/html`) and attributes are recorded as `element@attr`
//! (`content@url` for `<media:content url="…"/>`). Text and CDATA are concatenated; entity and character
//! references are resolved. The item is also available as a JSON object, which is what the catalog stores as the
//! raw record.

use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};

/// One RSS item.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RssItem {
    /// `(path, value)` pairs in document order.
    pub fields: Vec<(String, String)>,
}

impl RssItem {
    /// First value recorded for `path`.
    pub fn get(&self, path: &str) -> Option<&str> {
        self.fields.iter().find(|(k, _)| k == path).map(|(_, v)| v.as_str())
    }

    /// The item as a JSON object (first value per path wins).
    pub fn to_json(&self) -> String {
        let mut map = serde_json::Map::new();
        for (k, v) in &self.fields {
            map.entry(k.clone()).or_insert_with(|| serde_json::Value::String(v.clone()));
        }
        serde_json::Value::Object(map).to_string()
    }

    /// Rebuild from the stored JSON object.
    pub fn from_json(raw: &str) -> Option<RssItem> {
        let v: serde_json::Map<String, serde_json::Value> = serde_json::from_str(raw).ok()?;
        Some(RssItem { fields: v.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_owned()))).collect() })
    }
}

/// Maximum items read from one feed document (defensive bound).
const MAX_ITEMS: usize = 2000;

/// Parse every `<item>` of an RSS document.
pub fn parse_items(xml: &str) -> Result<Vec<RssItem>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut items = Vec::new();
    let mut current: Option<RssItem> = None;
    // Element path inside the current item.
    let mut path: Vec<String> = Vec::new();
    let mut text = String::new();
    loop {
        let event = reader.read_event().map_err(|e| format!("XML error at byte {}: {e}", reader.buffer_position()))?;
        match event {
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_owned();
                if current.is_none() {
                    if name == "item" {
                        current = Some(RssItem::default());
                        path.clear();
                        text.clear();
                    }
                    continue;
                }
                if let Some(item) = current.as_mut() {
                    path.push(name);
                    record_attributes(item, &path, &e);
                    text.clear();
                }
            }
            Event::Empty(e) => {
                if let Some(item) = current.as_mut() {
                    let mut p = path.clone();
                    p.push(e.local_name().as_ref().to_owned());
                    record_attributes(item, &p, &e);
                }
            }
            Event::Text(t) => {
                if current.is_some() && !path.is_empty() {
                    text.push_str(&t.xml10_content());
                }
            }
            Event::CData(c) => {
                if current.is_some() && !path.is_empty() {
                    text.push_str(&c.into_inner());
                }
            }
            Event::GeneralRef(r) => {
                if current.is_some() && !path.is_empty() {
                    match r.resolve_char_ref() {
                        Ok(Some(c)) => text.push(c),
                        _ => match &*r {
                            "amp" => text.push('&'),
                            "lt" => text.push('<'),
                            "gt" => text.push('>'),
                            "quot" => text.push('"'),
                            "apos" => text.push('\''),
                            // HTML entities in RSS without a DTD: keep them for the text cleaner to decode.
                            other => {
                                text.push('&');
                                text.push_str(other);
                                text.push(';');
                            }
                        },
                    }
                }
            }
            Event::End(e) => {
                let name = e.local_name().as_ref().to_owned();
                let Some(item) = current.as_mut() else { continue };
                if path.is_empty() {
                    if name == "item" {
                        items.push(current.take().unwrap_or_default());
                        if items.len() >= MAX_ITEMS {
                            break;
                        }
                    }
                    continue;
                }
                let key = path.join("/");
                let value = std::mem::take(&mut text);
                if !value.trim().is_empty() {
                    item.fields.push((key, value.trim().to_owned()));
                }
                path.pop();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(items)
}

fn record_attributes(item: &mut RssItem, path: &[String], e: &quick_xml::events::BytesStart<'_>) {
    let element = path.join("/");
    for attr in e.attributes().flatten() {
        let key = attr.key.local_name().as_ref().to_owned();
        if let Ok(v) = attr.normalized_value(XmlVersion::Implicit1_0) {
            item.fields.push((format!("{element}@{key}"), v.into_owned()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_items_cdata_refs_and_attributes() {
        let xml = r#"<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>x</title>
            <item><title>Dash &amp; Slash &#233; &nbsp;</title><description><![CDATA[<img src="a.png">By Ann]]></description>
            <media:content url="https://play.js13kgames.com/a/.c.png" medium="image" />
            <platforms><html>yes</html></platforms></item>
            <item><title>Second</title></item></channel></rss>"#;
        let items = parse_items(xml).unwrap();
        assert_eq!(items.len(), 2);
        let a = &items[0];
        assert_eq!(a.get("title"), Some("Dash & Slash é &nbsp;"));
        assert_eq!(a.get("description"), Some("<img src=\"a.png\">By Ann"));
        assert_eq!(a.get("content@url"), Some("https://play.js13kgames.com/a/.c.png"));
        assert_eq!(a.get("platforms/html"), Some("yes"));
        let back = RssItem::from_json(&a.to_json()).unwrap();
        assert_eq!(back.get("title"), a.get("title"));
        assert!(parse_items("<rss><item><title>x</item></rss>").is_err());
    }
}
