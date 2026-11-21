//! Cross-source deduplication (research §9.3).
//!
//! Key = normalized title (folded to lowercase, alphanumerics only, trailing ` online`/` html5`/` 2d` dropped),
//! plus the normalized developer when the record has one. Distributor feeds do not expose developers, so their
//! games collide on title alone; itch.io / js13k / OSS records only collide with records of the same developer.
//! That keeps "2048" by Gabriele Cirulli (OSS) apart from the many unrelated "2048" games in distributor feeds.
//!
//! Within a group, the most preferred *visible* listing (source preference order, then source quality, then id)
//! is canonical; listings of other sources point at it via `canonical_id` and stay in the database as fallbacks:
//! when the preferred listing is hidden, broken or its source is disabled, the next one takes over automatically.

use crate::source::Source;

/// Default preference order (research §9.3, then self-hosted before link-outs).
pub const DEFAULT_ORDER: [Source; 8] = [
    Source::Playgama,
    Source::GamePix,
    Source::GameDistribution,
    Source::GameMonetize,
    Source::Famobi,
    Source::Oss,
    Source::ItchIo,
    Source::Js13k,
];

const DROP_SUFFIXES: &[&str] = &["online", "html5", "2d"];

/// Normalized title used for duplicate detection.
pub fn title_key(title: &str) -> String {
    let folded = crate::slug::fold(title);
    let mut words: Vec<String> =
        folded.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_owned).collect();
    while words.len() > 1 && words.last().is_some_and(|w| DROP_SUFFIXES.contains(&w.as_str())) {
        words.pop();
    }
    words.concat()
}

/// The dedup key stored in `games.dedup_key`.
pub fn dedup_key(title: &str, developer: Option<&str>) -> String {
    let t = title_key(title);
    match developer.map(title_key).filter(|d| !d.is_empty()) {
        Some(d) => format!("{t}|{d}"),
        None => t,
    }
}

/// Position of `source` in `order` (unknown sources sort last).
pub fn preference(order: &[Source], source: Source) -> usize {
    order.iter().position(|s| *s == source).unwrap_or(order.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert_eq!(title_key("Mahjong Classic"), "mahjongclassic");
        assert_eq!(title_key("MAHJONG classic Online"), "mahjongclassic");
        assert_eq!(title_key("Mahjong-Classic HTML5 2D"), "mahjongclassic");
        assert_eq!(title_key("Online"), "online");
        assert_eq!(title_key("Pokémon"), "pokemon");
        assert_eq!(dedup_key("2048", Some("Gabriele Cirulli")), "2048|gabrielecirulli");
        assert_eq!(dedup_key("2048", None), "2048");
        assert_eq!(dedup_key("2048", Some("  ")), "2048");
        assert!(preference(&DEFAULT_ORDER, Source::Playgama) < preference(&DEFAULT_ORDER, Source::GamePix));
    }
}
