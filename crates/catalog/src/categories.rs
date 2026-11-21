//! GNOME categories and the mapping from source categories, genres and tags (research §6).
//!
//! Algorithm ([`assign`]), producing at most three categories, primary first:
//! 1. **Primary**: per-source table lookup on the source's own categories ([§6.1]; a few entries map to two
//!    categories, e.g. GamePix `battle-royale` → Action + Multiplayer). Playgama has no primary field: its genres go
//!    through the keyword rules and the first match is the primary.
//! 2. **Optional categories** (`shooter`, `io`, `card`, `educational`, `music`) are added only when the source's own
//!    category/genre says so ("when sources provide them"), never from free-form tags.
//! 3. **Secondary**: the ordered keyword rules ([§6.2]) over source categories + tags (+ genres), in rule priority
//!    order.
//! 4. **Strong title words** (defined here, conservative: e.g. "sudoku", "zombie", ".io") when room is left.
//! 5. Nothing matched → `casual`.
//!
//! Gendered source labels (`Girls`, `Boys`, `games-for-girls`, ...) are never exposed: they are not categories and
//! [`is_gendered`] makes the importers drop them from tags too.

use serde::{Deserialize, Serialize};

use crate::source::Source;

/// A GNOME category. The first 14 are the core set; the last five are used only when a source provides them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    /// `action`
    Action,
    /// `adventure`
    Adventure,
    /// `arcade`
    Arcade,
    /// `racing`
    Racing,
    /// `sports`
    Sports,
    /// `puzzle`
    Puzzle,
    /// `strategy`
    Strategy,
    /// `multiplayer`
    Multiplayer,
    /// `simulation`
    Simulation,
    /// `idle`
    Idle,
    /// `platformer`
    Platformer,
    /// `casual`
    Casual,
    /// `horror`
    Horror,
    /// `sandbox`
    Sandbox,
    /// `shooter` (optional)
    Shooter,
    /// `io` (optional; `.io` games)
    Io,
    /// `card` (optional)
    Card,
    /// `educational` (optional)
    Educational,
    /// `music` (optional)
    Music,
}

impl Category {
    /// The 14 core categories in display order.
    pub const CORE: [Category; 14] = [
        Category::Action,
        Category::Adventure,
        Category::Arcade,
        Category::Racing,
        Category::Sports,
        Category::Puzzle,
        Category::Strategy,
        Category::Multiplayer,
        Category::Simulation,
        Category::Idle,
        Category::Platformer,
        Category::Casual,
        Category::Horror,
        Category::Sandbox,
    ];
    /// Optional categories (shown only when at least one game has them).
    pub const OPTIONAL: [Category; 5] =
        [Category::Shooter, Category::Io, Category::Card, Category::Educational, Category::Music];

    /// All categories in display order.
    pub fn all() -> impl Iterator<Item = Category> {
        Self::CORE.into_iter().chain(Self::OPTIONAL)
    }

    /// URL slug / API value.
    pub const fn slug(self) -> &'static str {
        match self {
            Category::Action => "action",
            Category::Adventure => "adventure",
            Category::Arcade => "arcade",
            Category::Racing => "racing",
            Category::Sports => "sports",
            Category::Puzzle => "puzzle",
            Category::Strategy => "strategy",
            Category::Multiplayer => "multiplayer",
            Category::Simulation => "simulation",
            Category::Idle => "idle",
            Category::Platformer => "platformer",
            Category::Casual => "casual",
            Category::Horror => "horror",
            Category::Sandbox => "sandbox",
            Category::Shooter => "shooter",
            Category::Io => "io",
            Category::Card => "card",
            Category::Educational => "educational",
            Category::Music => "music",
        }
    }

    /// Display name.
    pub const fn name(self) -> &'static str {
        match self {
            Category::Action => "Action",
            Category::Adventure => "Adventure",
            Category::Arcade => "Arcade",
            Category::Racing => "Racing",
            Category::Sports => "Sports",
            Category::Puzzle => "Puzzle",
            Category::Strategy => "Strategy",
            Category::Multiplayer => "Multiplayer",
            Category::Simulation => "Simulation",
            Category::Idle => "Idle",
            Category::Platformer => "Platformer",
            Category::Casual => "Casual",
            Category::Horror => "Horror",
            Category::Sandbox => "Sandbox",
            Category::Shooter => "Shooter",
            Category::Io => ".io",
            Category::Card => "Card",
            Category::Educational => "Educational",
            Category::Music => "Music",
        }
    }

    /// Parse a slug (case-insensitive).
    pub fn from_slug(s: &str) -> Option<Category> {
        let s = s.trim().to_ascii_lowercase();
        Category::all().find(|c| c.slug() == s)
    }

    /// Whether this is one of the 14 core categories.
    pub fn is_core(self) -> bool {
        Self::CORE.contains(&self)
    }
}

/// Normalize a source label into a rule token: lowercase, `_`/whitespace → `-`, collapsed hyphens, trailing
/// `-games`/`-game` dropped (Playgama uses `sandbox-games`, `incremental-games`).
pub fn normalize_token(s: &str) -> String {
    let lower = crate::slug::fold(s.trim());
    let mut out = String::with_capacity(lower.len());
    for c in lower.chars() {
        let c = if c == '_' || c.is_whitespace() { '-' } else { c };
        if c == '-' && (out.is_empty() || out.ends_with('-')) {
            continue;
        }
        out.push(c);
    }
    let mut out = out.trim_end_matches('-').to_owned();
    for suffix in ["-games", "-game"] {
        if out.len() > suffix.len() && out.ends_with(suffix) {
            out.truncate(out.len() - suffix.len());
            break;
        }
    }
    out
}

/// Whether a (normalized) label is a gendered category that must never be shown.
pub fn is_gendered(token: &str) -> bool {
    matches!(
        token,
        "girls" | "girl" | "boys" | "boy" | "games-for-girls" | "games-for-boys" | "for-girls" | "for-boys" | "girly"
    )
}

use Category::*;

/// Primary table lookup (research §6.1). Returns no categories for unknown labels and "(rules)" entries.
fn primary_table(source: Source, t: &str) -> &'static [Category] {
    match source {
        Source::GameDistribution => match t {
            ".io" => &[Multiplayer],
            "action" | "battle" | "shooter" => &[Action],
            "adventure" => &[Adventure],
            "agility" | "arcade" => &[Arcade],
            "art" | "cards" | "casual" | "dress-up" | "educational" | "girls" => &[Casual],
            "basketball" | "football" | "sports" => &[Sports],
            "boardgames" | "strategy" => &[Strategy],
            "bubble-shooter" | "jigsaw" | "mahjong-&-connect" | "mahjong-connect" | "match-3" | "merge" | "puzzle"
            | "quiz" => &[Puzzle],
            "care" | "cooking" | "simulation" => &[Simulation],
            "racing" | "racing-&-driving" | "racing-driving" => &[Racing],
            _ => &[],
        },
        Source::GameMonetize => match t {
            "action" | "shooting" | "stickman" | "fighting" => &[Action],
            ".io" | "2-player" | "multiplayer" => &[Multiplayer],
            "adventure" => &[Adventure],
            "arcade" => &[Arcade],
            "baby-hazel" | "girls" | "hypercasual" => &[Casual],
            "bejeweled" | "puzzle" | "puzzles" => &[Puzzle],
            "clicker" => &[Idle],
            "cooking" => &[Simulation],
            "racing" => &[Racing],
            "soccer" | "sports" => &[Sports],
            _ => &[],
        },
        Source::GamePix => match t {
            "action"
            | "battle"
            | "boxing"
            | "fighting"
            | "first-person-shooter"
            | "gangster"
            | "gun"
            | "knight"
            | "ninja"
            | "shooter"
            | "sniper"
            | "stickman"
            | "sword"
            | "tanks"
            | "war"
            | "wrestling"
            | "naval"
            | "police"
            | "ninja-turtle"
            | "survival" => &[Action],
            "battle-royale" => &[Action, Multiplayer],
            "adventure" | "escape" | "rpg" | "pirates" | "dragons" | "dinosaur" => &[Adventure],
            "arcade" | "classics" | "retro" | "flash" | "ball" | "snake" | "worm" | "spinner" | "tap" | "skill"
            | "runner" | "sharks" | "robots" | "pixel" => &[Arcade],
            "racing" | "car" | "driving" | "drifting" | "bike" | "dirt-bike" | "truck" | "offroad" | "airplane"
            | "helicopter" | "flight" => &[Racing],
            "sports" | "soccer" | "basketball" | "baseball" | "bowling" | "cricket" | "golf" | "hockey" | "pool"
            | "skateboard" | "world-cup" | "archery" | "horse" | "fishing" | "hunting" => &[Sports],
            "puzzle" | "2048" | "block" | "brain" | "bubble-shooter" | "bejeweled" | "jewel" | "jigsaw-puzzles"
            | "mahjong" | "match-3" | "memory" | "math" | "scrabble" | "word" | "trivia" | "tetris"
            | "hidden-object" | "coding" => &[Puzzle],
            "strategy" | "chess" | "checkers" | "board" => &[Strategy],
            "city-building" | "management" => &[Strategy, Simulation],
            "multiplayer" | "io" | "two-player" => &[Multiplayer],
            "mmorpg" => &[Multiplayer, Adventure],
            "simulation" | "farming" | "cooking" | "restaurant" | "surgery" | "hair-salon" | "parking" | "money" => {
                &[Simulation]
            }
            "idle" | "clicker" | "tycoon" => &[Idle],
            "platformer" | "jumping" | "parkour" | "fire-and-water" | "mario" => &[Platformer],
            "casual" | "hyper-casual" | "addictive" | "cool" | "crazy" | "fun" | "family" | "coloring" | "drawing"
            | "dress-up" | "fashion" | "makeup" | "games-for-girls" | "educational" | "card" | "solitaire"
            | "music" | "piano" | "cats" | "animal" | "anime" | "christmas" | "halloween" | "mobile" | "gdevelop"
            | "vibe-coded" => &[Casual],
            "horror" | "scary" | "monster" | "granny" => &[Horror],
            "zombie" => &[Horror, Action],
            "open-world" | "building" | "mining" | "minecraft" => &[Sandbox],
            _ => &[],
        },
        Source::Famobi => match t {
            "action" => &[Action],
            "puzzle" | "quiz" | "match-3" | "mahjong" | "bubble-shooter" => &[Puzzle],
            "arcade" | "skill" | "breakout" => &[Arcade],
            "racing" | "cars" => &[Racing],
            "sports" => &[Sports],
            "management" | "cooking" | "tamagotchi" => &[Simulation],
            "time-management-and-strategy" => &[Strategy],
            "multiplayer" => &[Multiplayer],
            "jump-and-run" => &[Platformer],
            "girls" | "dress-up" | "make-up" | "educational" | "cards" => &[Casual],
            _ => &[],
        },
        Source::ItchIo => match t {
            "action" | "fighting" | "shooter" | "survival" => &[Action],
            "adventure" | "role-playing" | "visual-novel" | "interactive-fiction" => &[Adventure],
            "platformer" => &[Platformer],
            "puzzle" => &[Puzzle],
            "racing" => &[Racing],
            "rhythm" => &[Arcade],
            "simulation" => &[Simulation],
            "sports" => &[Sports],
            "strategy" | "card" => &[Strategy],
            "educational" | "other" => &[Casual],
            _ => &[],
        },
        // js13k entries have no categories; OSS categories are chosen in the manifest.
        Source::Js13k => &[Arcade],
        Source::Playgama | Source::Oss => &[],
    }
}

/// Optional categories, only from a source's own category/genre labels.
fn optional_category(t: &str) -> Option<Category> {
    Some(match t {
        "shooter" | "shooting" | "first-person-shooter" | "third-person-shooter" | "fps" | "sniper" => Shooter,
        ".io" | "io" => Io,
        "cards" | "card" | "card-game" | "solitaire" => Card,
        "educational" | "education" | "math" | "coding" => Educational,
        "music" | "rhythm" | "piano" => Music,
        _ => return None,
    })
}

/// Keyword rules in priority order (research §6.2). Patterns: exact token, `prefix*`, or `*suffix`.
const RULES: &[(Category, &[&str])] = &[
    (
        Multiplayer,
        &[
            "multiplayer",
            "io",
            ".io",
            "2-player",
            "two-player",
            "2players",
            "2-player-*",
            "pvp",
            "1v1",
            "co-op",
            "mmo",
            "mmorpg",
            "online",
            "battle-royale",
            "3-player",
        ],
    ),
    (
        Horror,
        &[
            "horror",
            "scary",
            "survival-horror",
            "psychological-horror",
            "jump-scare",
            "creepy",
            "backrooms",
            "zombie*",
            "slenderman*",
            "granny*",
        ],
    ),
    (Idle, &["idle", "clicker", "incremental", "tycoon", "afk", "*-clicker"]),
    (Platformer, &["platformer", "platform", "jump-and-run", "side-scrolling", "parkour", "obby", "jumping"]),
    (
        Sandbox,
        &[
            "sandbox",
            "open-world",
            "crafting",
            "building",
            "mining",
            "voxel",
            "ragdoll",
            "physics-sandbox",
            "mineblock",
            "city-building",
        ],
    ),
    (
        Racing,
        &[
            "racing",
            "race",
            "driving",
            "drift*",
            "car-racing",
            "kart*",
            "moto*",
            "bike*",
            "rally",
            "drag-racing",
            "offroad",
            "truck",
        ],
    ),
    (
        Sports,
        &[
            "sports",
            "soccer",
            "football",
            "american-football",
            "basketball",
            "baseball",
            "golf",
            "mini-golf",
            "tennis",
            "hockey",
            "pool",
            "billiards",
            "8-ball-pool",
            "bowling",
            "cricket",
            "volleyball",
            "penalty",
            "goalkeeper",
            "skateboarding",
            "snowboarding",
            "ski",
        ],
    ),
    (
        Puzzle,
        &[
            "puzzle",
            "match-3",
            "match3",
            "mahjong*",
            "jigsaw",
            "2048",
            "sudoku",
            "word*",
            "trivia",
            "quiz",
            "brain*",
            "logic",
            "hidden-object",
            "bubble-shooter",
            "sorting",
            "memory",
            "connect",
            "tiles",
            "crossword*",
            "spot-the-difference",
        ],
    ),
    (
        Strategy,
        &[
            "strategy",
            "tower-defense",
            "defense",
            "rts",
            "tactical",
            "turn-based",
            "turnbased",
            "chess",
            "checkers",
            "board",
            "backgammon",
            "card",
        ],
    ),
    (
        Simulation,
        &[
            "simulation",
            "simulator",
            "life-simulation",
            "cooking",
            "farm*",
            "restaurant",
            "management",
            "time-management",
            "surgery",
            "doctor",
            "hospital",
            "pet*",
            "tamagotchi",
            "care",
            "flight",
            "parking",
            "business",
        ],
    ),
    (
        Adventure,
        &[
            "adventure",
            "rpg",
            "action-rpg",
            "escape",
            "point-and-click",
            "story",
            "visual-novel",
            "interactive-fiction",
            "dungeon*",
            "quest*",
            "roguelike*",
        ],
    ),
    (
        Action,
        &[
            "action",
            "shooter",
            "shooting",
            "fps",
            "third-person-shooter",
            "fighting",
            "battle",
            "war",
            "gun",
            "sniper",
            "ninja",
            "sword",
            "stickman",
            "beat-em-up",
            "combat",
        ],
    ),
    (
        Arcade,
        &[
            "arcade",
            "retro",
            "classic",
            "snake",
            "breakout",
            "pinball",
            "runner",
            "endless",
            "skill",
            "agility",
            "flappy*",
            "one-button",
            "reaction",
        ],
    ),
    (
        Casual,
        &[
            "casual",
            "hypercasual",
            "hyper-casual",
            "dress-up",
            "makeup",
            "make-up",
            "coloring",
            "drawing",
            "kids",
            "family",
            "educational",
            "solitaire",
            "art",
            "cozy",
            "relaxing",
        ],
    ),
];

/// "Strong" title words that are applied to titles (not only labels). Conservative on purpose: each word names
/// the genre unambiguously.
const STRONG_TITLE_WORDS: &[(&str, Category)] = &[
    ("zombie", Horror),
    ("zombies", Horror),
    ("horror", Horror),
    ("idle", Idle),
    ("clicker", Idle),
    ("tycoon", Idle),
    ("incremental", Idle),
    ("platformer", Platformer),
    ("parkour", Platformer),
    ("obby", Platformer),
    ("sandbox", Sandbox),
    ("racing", Racing),
    ("racer", Racing),
    ("drift", Racing),
    ("kart", Racing),
    ("soccer", Sports),
    ("football", Sports),
    ("basketball", Sports),
    ("golf", Sports),
    ("tennis", Sports),
    ("hockey", Sports),
    ("bowling", Sports),
    ("puzzle", Puzzle),
    ("sudoku", Puzzle),
    ("mahjong", Puzzle),
    ("jigsaw", Puzzle),
    ("2048", Puzzle),
    ("crossword", Puzzle),
    ("chess", Strategy),
    ("checkers", Strategy),
    ("backgammon", Strategy),
    ("simulator", Simulation),
];

fn pattern_matches(pattern: &str, token: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix('*') {
        token.starts_with(prefix)
    } else if let Some(suffix) = pattern.strip_prefix('*') {
        token.len() > suffix.len() && token.ends_with(suffix)
    } else {
        pattern == token
    }
}

/// Categories whose keyword rule matches `token`, in rule priority order.
pub fn rule_categories(token: &str) -> impl Iterator<Item = Category> + '_ {
    RULES.iter().filter(move |(_, pats)| pats.iter().any(|p| pattern_matches(p, token))).map(|(c, _)| *c)
}

/// Input to [`assign`].
#[derive(Debug, Clone, Copy)]
pub struct CategoryInput<'a> {
    /// Source of the record (selects the primary-category table).
    pub source: Source,
    /// The source's own categories / genres / namespace, most important first.
    pub source_categories: &'a [String],
    /// Free-form tags.
    pub tags: &'a [String],
    /// Game title (for the strong title words).
    pub title: &'a str,
}

/// Maximum number of categories per game.
pub const MAX_CATEGORIES: usize = 3;

/// Map a record to GNOME categories (see the module docs).
pub fn assign(input: CategoryInput<'_>) -> Vec<Category> {
    let mut out: Vec<Category> = Vec::with_capacity(MAX_CATEGORIES);
    let push = |out: &mut Vec<Category>, c: Category| {
        if out.len() < MAX_CATEGORIES && !out.contains(&c) {
            out.push(c);
        }
    };
    let cats: Vec<String> = input
        .source_categories
        .iter()
        .map(|s| normalize_token(s))
        .filter(|t| !t.is_empty() && !is_gendered(t))
        .collect();
    let tags: Vec<String> =
        input.tags.iter().map(|s| normalize_token(s)).filter(|t| !t.is_empty() && !is_gendered(t)).collect();

    // 1. Primary (table), or — for sources without a primary field — the first rule (in priority order) that
    //    matches any genre, so a specific genre outranks generic ones such as "cozy" → casual.
    if matches!(input.source, Source::Playgama) {
        if let Some((c, _)) =
            RULES.iter().find(|(_, pats)| cats.iter().any(|t| pats.iter().any(|p| pattern_matches(p, t))))
        {
            push(&mut out, *c);
        }
    } else if matches!(input.source, Source::Js13k) {
        push(&mut out, Arcade);
    } else {
        // Gendered labels are filtered above, but the research tables map GD/GM "Girls" to Casual; honour that
        // so such games still get a category instead of falling through to rules on unrelated tags.
        for raw in input.source_categories {
            let t = normalize_token(raw);
            for &c in primary_table(input.source, &t) {
                push(&mut out, c);
            }
        }
    }
    // 2. Optional categories, from the source's own labels only.
    for t in &cats {
        if let Some(c) = optional_category(t) {
            push(&mut out, c);
        }
    }
    // 3. Keyword rules over categories + tags, in rule priority order.
    for (cat, pats) in RULES {
        if cats.iter().chain(tags.iter()).any(|t| pats.iter().any(|p| pattern_matches(p, t))) {
            push(&mut out, *cat);
        }
    }
    // 4. Strong title words.
    if out.len() < MAX_CATEGORIES {
        let title = crate::slug::fold(input.title);
        if title_has_io_suffix(&title) {
            push(&mut out, Multiplayer);
        }
        let words: Vec<&str> = title.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
        for (word, cat) in STRONG_TITLE_WORDS {
            if words.contains(word) {
                push(&mut out, *cat);
            }
        }
        if title.contains("tower defense") {
            push(&mut out, Strategy);
        }
    }
    // 5. Fallback.
    if out.is_empty() {
        out.push(Casual);
    }
    out
}

/// `slither.io`, `Paper.io 2` — the ".io" naming convention of browser multiplayer games.
fn title_has_io_suffix(title: &str) -> bool {
    title.match_indices(".io").any(|(i, _)| {
        let before = title[..i].chars().next_back().is_some_and(char::is_alphanumeric);
        let after = title[i + 3..].chars().next().is_none_or(|c| !c.is_alphanumeric());
        before && after
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    fn cats(source: Source, c: &[&str], tags: &[&str], title: &str) -> Vec<&'static str> {
        let (c, t) = (s(c), s(tags));
        assign(CategoryInput { source, source_categories: &c, tags: &t, title })
            .into_iter()
            .map(Category::slug)
            .collect()
    }

    #[test]
    fn token_normalization() {
        assert_eq!(normalize_token("Racing & Driving"), "racing-&-driving");
        assert_eq!(normalize_token("  Sandbox_Games "), "sandbox");
        assert_eq!(normalize_token("incremental-games"), "incremental");
        assert_eq!(normalize_token("2 Player"), "2-player");
        assert_eq!(normalize_token("games"), "games");
        assert_eq!(normalize_token("Mahjong & Connect"), "mahjong-&-connect");
    }

    #[test]
    fn gamedistribution_tables_and_rules() {
        // Real records from tests/fixtures/gamedistribution-p1.json.
        assert_eq!(
            cats(Source::GameDistribution, &["Match-3"], &["flowers", "sorting", "match3"], "Flower Sort Adventure"),
            ["puzzle"]
        );
        assert_eq!(
            cats(Source::GameDistribution, &[".IO"], &["1player", "ball", "collect", "3d"], "x"),
            ["multiplayer", "io"]
        );
        assert_eq!(
            cats(Source::GameDistribution, &["Casual", "Simulation"], &["destroy", "upgrade"], "x"),
            ["casual", "simulation"]
        );
        assert_eq!(
            cats(Source::GameDistribution, &["Battle", "Strategy"], &["army", "castle", "war"], "x"),
            ["action", "strategy"]
        );
        assert_eq!(cats(Source::GameDistribution, &["Shooter"], &[], "x"), ["action", "shooter"]);
        assert_eq!(cats(Source::GameDistribution, &["Girls"], &["dress"], "Princess"), ["casual"]);
    }

    #[test]
    fn gamepix_namespaces_with_two_categories() {
        assert_eq!(cats(Source::GamePix, &["battle-royale"], &[], "x"), ["action", "multiplayer"]);
        assert_eq!(cats(Source::GamePix, &["zombie"], &[], "x"), ["horror", "action"]);
        assert_eq!(cats(Source::GamePix, &["chess"], &[], "Chess Classic"), ["strategy"]);
        assert_eq!(cats(Source::GamePix, &["match-3"], &[], "Prism Match 3D"), ["puzzle"]);
        assert_eq!(cats(Source::GamePix, &["games-for-girls"], &[], "x"), ["casual"]);
    }

    #[test]
    fn playgama_genres_use_rules_for_primary() {
        // genres of real Playgama records (tests/fixtures/playgama-p1.json)
        assert_eq!(
            cats(Source::Playgama, &["cozy", "puzzle", "merge", "cooking", "cake"], &[], "x"),
            ["puzzle", "simulation", "casual"]
        );
        assert_eq!(cats(Source::Playgama, &["tower-defense", "zombie", "strategy", "pve"], &[], "x")[0], "horror");
        assert_eq!(
            cats(Source::Playgama, &["kids", "decoration", "dress-up", "girls", "make-up"], &[], "x"),
            ["casual"]
        );
    }

    #[test]
    fn fallback_title_words_and_cap() {
        assert_eq!(cats(Source::GameMonetize, &["3D"], &["monstertruck", "unity"], "Nitro Crush"), ["casual"]);
        assert_eq!(cats(Source::GameMonetize, &["3D"], &[], "Zombie Sudoku Racer"), ["horror", "racing", "puzzle"]);
        assert_eq!(cats(Source::GameMonetize, &["Clicker"], &[], "x"), ["idle"]);
        assert_eq!(cats(Source::Famobi, &["jump-and-run"], &[], "x"), ["platformer"]);
        assert_eq!(cats(Source::ItchIo, &["Role Playing"], &[], "x"), ["adventure"]);
        assert_eq!(cats(Source::Js13k, &[], &[], "Rainbow Unicorn Sky Runner"), ["arcade"]);
        assert_eq!(
            cats(Source::GameMonetize, &["Hypercasual"], &[".io", "online"], "Slither.io Remix"),
            ["casual", "multiplayer"]
        );
        assert!(title_has_io_suffix("paper.io 2") && !title_has_io_suffix("radio show") && !title_has_io_suffix(".io"));
        let many = cats(Source::GamePix, &["battle-royale"], &["horror", "idle", "puzzle"], "x");
        assert_eq!(many.len(), 3);
    }

    #[test]
    fn gendered_labels_never_become_categories() {
        for c in Category::all() {
            assert!(!is_gendered(c.slug()));
        }
        assert_eq!(cats(Source::GameMonetize, &["Boys"], &["girls"], "x"), ["casual"]);
        assert_eq!(Category::from_slug("Puzzle"), Some(Category::Puzzle));
        assert_eq!(Category::from_slug("girls"), None);
    }
}
