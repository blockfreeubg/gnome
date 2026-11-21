//! Trademark / knock-off blocklist (research §11.8).
//!
//! Distributor catalogs contain many unlicensed games named after famous brands ("Minecraft Classic", "Sprunki
//! Retake", "Plants vs Zombies Fusion"). Records that match a blocklist term get status `ip_risk`, which hides them
//! by default; an admin can review and set them `active`.
//!
//! Matching is on whole words after folding (lowercase, accents removed, punctuation → space), so `pokemon` matches
//! "Pokémon Quest" and the tag `pokemon-games`, but `mario` does not match "Marionette". Each term has a scope:
//! * [`Scope::Any`] — title, tags and source categories: the brands the research found used as knock-off bait in
//!   the feeds' own tags/categories (Playgama interests, GamePix namespaces, GameDistribution tags);
//! * [`Scope::Title`] — title only: other heavily cloned franchises, and the clone names the research lists for
//!   titles ("Pac-Man/Tetris names"). Feeds use such words as SEO tags on unrelated games (a generic block puzzle
//!   tagged `tetris`), so tags alone do not flag them;
//! * [`Scope::TitleStart`] — titles that *start* with the term: brand names that are also everyday phrases ("Among
//!   Us Online" is a knock-off, "They Are Among Us" is not);
//! * [`Scope::Labels`] — tags and source categories only.
//!
//! Live check 2026-11-10: Famobi distributes the official *Cut the Rope* games, so that franchise is deliberately
//! not a default term. Live check 2026-11-11 (review, 14,929 GamePix games): the title-only terms from `huggy` to
//! `choo choo charles` and `granny` in titles matched only knock-offs (Poppy Playtime, Minecraft's Steve and Alex,
//! FNaF, Granny, …), while `among us` anywhere in a title also flagged "The dead among us" and "They Are Among Us".
//!
//! The list is configurable: `GNOME_CATALOG_BLOCKLIST` adds comma-separated terms (`!term` removes one),
//! `GNOME_CATALOG_BLOCKLIST_FILE` points to a file with one term per line (`#` comments, `title:` / `start:` /
//! `label:` prefixes for the narrower scopes, `!term` removes a default term).

use crate::slug::fold;

/// Where a term is matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Title, tags and source categories.
    Any,
    /// Title only.
    Title,
    /// Titles that start with the term.
    TitleStart,
    /// Tags and source categories only.
    Labels,
}

/// One blocklist term (stored folded: lowercase words separated by single spaces).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Term {
    /// Folded words of the term, e.g. `plants vs zombies`.
    pub words: String,
    /// Where the term is matched.
    pub scope: Scope,
}

/// Default title-or-label terms (research §11.8: Playgama interests, GamePix namespaces, GameDistribution tags).
pub const DEFAULT_TERMS: &[&str] = &[
    "minecraft",
    "gta",
    "grand theft auto",
    "mario",
    "super mario",
    "pokemon",
    "five nights at freddy",
    "fnaf",
    "roblox",
    "sprunki",
    "amongus",
    "fortnite",
    "subway surfers",
    "skibidi",
    "ninja turtle",
    "ninja turtles",
    "tmnt",
    "harry potter",
    "spider man",
    "spiderman",
];

/// Default title-only terms: clone names (research §8.2/§11.8) and other heavily cloned franchises.
pub const DEFAULT_TITLE_TERMS: &[&str] = &[
    "pac man",
    "pacman",
    "tetris",
    "flappy bird",
    "luigi",
    "pikachu",
    "freddy fazbear",
    "incredibox",
    "hogwarts",
    "plants vs zombies",
    "angry birds",
    "candy crush",
    "temple run",
    "geometry dash",
    "zelda",
    "kirby",
    "donkey kong",
    "yoshi",
    "metroid",
    "sonic the hedgehog",
    "sonic exe",
    "street fighter",
    "mortal kombat",
    "tekken",
    "call of duty",
    "counter strike",
    "csgo",
    "pubg",
    "free fire",
    "clash of clans",
    "clash royale",
    "brawl stars",
    "stumble guys",
    "fall guys",
    "huggy wuggy",
    "poppy playtime",
    "rainbow friends",
    "squid game",
    "baldi",
    "cuphead",
    "undertale",
    "terraria",
    "the sims",
    "lego",
    "hot wheels",
    "transformers",
    "star wars",
    "marvel",
    "avengers",
    "batman",
    "superman",
    "disney",
    "pixar",
    "mickey mouse",
    "barbie",
    "hello kitty",
    "peppa pig",
    "paw patrol",
    "spongebob",
    "doraemon",
    "naruto",
    "dragon ball",
    "hatsune miku",
    // Live check 2026-11-11: every title match in the GamePix catalog was a knock-off.
    "huggy",
    "steve and alex",
    "steve alex",
    "steve vs alex",
    "alex and steve",
    "freddy",
    "granny",
    "addams",
    "bomberman",
    "frogger",
    "doodle jump",
    "speakerman",
    "fireboy and watergirl",
    "kpop demon hunters",
    "k pop demon hunters",
    "choo choo charles",
];

/// Default title-start terms: brands that are also everyday phrases.
pub const DEFAULT_TITLE_START_TERMS: &[&str] = &["among us"];

/// Default label-only terms (GamePix's `granny` category is research §11.8 bait; the brand also matches titles).
pub const DEFAULT_LABEL_TERMS: &[&str] = &["granny", "among us"];

/// The compiled blocklist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocklist {
    terms: Vec<Term>,
}

impl Default for Blocklist {
    fn default() -> Self {
        let mut b = Blocklist { terms: Vec::new() };
        for (list, scope) in [
            (DEFAULT_TERMS, Scope::Any),
            (DEFAULT_TITLE_TERMS, Scope::Title),
            (DEFAULT_TITLE_START_TERMS, Scope::TitleStart),
            (DEFAULT_LABEL_TERMS, Scope::Labels),
        ] {
            for t in list {
                b.add(t, scope);
            }
        }
        b
    }
}

/// Fold text into space-separated lowercase words with a leading and trailing space (`" super mario bros "`).
pub fn fold_words(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push(' ');
    for c in fold(s).chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with(' ') {
            // Punctuation (including apostrophes: "freddy's" -> "freddy s") separates words.
            out.push(' ');
        }
    }
    if !out.ends_with(' ') {
        out.push(' ');
    }
    out
}

impl Blocklist {
    /// An empty list (matches nothing).
    pub fn empty() -> Self {
        Blocklist { terms: Vec::new() }
    }

    /// Add a term (ignored when it folds to nothing or is already present with that scope).
    pub fn add(&mut self, term: &str, scope: Scope) {
        let words = fold_words(term).trim().to_owned();
        if words.is_empty() || self.terms.iter().any(|t| t.words == words && t.scope == scope) {
            return;
        }
        self.terms.push(Term { words, scope });
    }

    /// Remove a term (every scope).
    pub fn remove(&mut self, term: &str) {
        let words = fold_words(term).trim().to_owned();
        self.terms.retain(|t| t.words != words);
    }

    /// Apply a blocklist file: one term per line, `#` comments, `title:` / `start:` / `label:` prefixes, `!term`
    /// removes.
    pub fn apply_file(&mut self, text: &str) {
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            if let Some(t) = line.strip_prefix('!') {
                self.remove(t);
            } else if let Some(t) = line.strip_prefix("label:") {
                self.add(t, Scope::Labels);
            } else if let Some(t) = line.strip_prefix("title:") {
                self.add(t, Scope::Title);
            } else if let Some(t) = line.strip_prefix("start:") {
                self.add(t, Scope::TitleStart);
            } else {
                self.add(line, Scope::Any);
            }
        }
    }

    /// The terms (for diagnostics and the rules fingerprint).
    pub fn terms(&self) -> &[Term] {
        &self.terms
    }

    /// The first term matching the record, if any.
    pub fn check<'a>(&'a self, title: &str, labels: &[String]) -> Option<&'a str> {
        if self.terms.is_empty() {
            return None;
        }
        let t = fold_words(title);
        let l: Vec<String> = labels.iter().map(|x| fold_words(x)).collect();
        self.terms
            .iter()
            .find(|term| {
                let needle = format!(" {} ", term.words);
                match term.scope {
                    Scope::Any => t.contains(&needle) || l.iter().any(|x| x.contains(&needle)),
                    Scope::Title => t.contains(&needle),
                    Scope::TitleStart => t.starts_with(&needle),
                    Scope::Labels => l.iter().any(|x| x.contains(&needle)),
                }
            })
            .map(|term| term.words.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: &[&str]) -> Vec<String> {
        x.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn matches_whole_words_after_folding() {
        let b = Blocklist::default();
        assert_eq!(b.check("Pokémon Quest", &[]), Some("pokemon"));
        assert_eq!(b.check("Five Nights at Freddy's 4", &[]), Some("five nights at freddy"));
        assert_eq!(b.check("Plants vs. Zombies Fusion Mode", &[]), Some("plants vs zombies"));
        assert_eq!(b.check("Super-Mario Bros", &[]), Some("mario"));
        assert_eq!(b.check("Fun Game", &v(&["pokemon-games"])), Some("pokemon"));
        assert_eq!(b.check("Spider-Man Swing", &[]), Some("spider man"));
        assert_eq!(b.check("Marionette Theater", &[]), None);
        assert_eq!(b.check("Legolas Archery", &[]), None);
        assert_eq!(b.check("Prism Match 3D", &v(&["match-3"])), None);
        assert_eq!(b.check("Flower Sort Adventure", &v(&["flowers", "sorting"])), None);
        // Officially distributed by Famobi.
        assert_eq!(b.check("Cut The Rope Time Travel", &v(&["puzzle"])), None);
    }

    #[test]
    fn scopes() {
        let b = Blocklist::default();
        // Title-only franchises: an SEO tag on an unrelated game does not flag it, the title does.
        assert_eq!(b.check("Block Blast Master", &v(&["tetris", "addictive"])), None);
        assert_eq!(b.check("Tetris Classic", &[]), Some("tetris"));
        assert_eq!(b.check("Drone Zero", &v(&["arcade", "flight"])), None);
        // Research brands also match tags.
        assert_eq!(b.check("Keyboard Rush", &v(&["running", "roblox"])), Some("roblox"));
        // Granny knock-offs use the name in titles and in GamePix's `granny` category.
        assert_eq!(b.check("Granny House Escape", &[]), Some("granny"));
        assert_eq!(b.check("Scary House", &v(&["granny"])), Some("granny"));
        // Everyday phrases: only a title that starts with the brand (or a tag) is flagged.
        assert_eq!(b.check("Among Us", &[]), Some("among us"));
        assert_eq!(b.check("Among Us: Impostor Online", &[]), Some("among us"));
        assert_eq!(b.check("They Are Among Us", &[]), None);
        assert_eq!(b.check("The dead among us", &v(&["arcade"])), None);
        assert_eq!(b.check("Space Crew", &v(&["among-us"])), Some("among us"));
        assert_eq!(b.check("AmongUs Online", &[]), Some("amongus"));
        // Live knock-offs the first list missed (review 2026-11-11).
        for (title, term) in [
            ("Extreme Huggy", "huggy"),
            ("Steve and Alex Dungeons", "steve and alex"),
            ("Alex and Steve Go Skate", "alex and steve"),
            ("Freddy at Obby World", "freddy"),
            ("The Addams Family Perfect Fit Jigsaw", "addams"),
            ("K-Pop Demon Hunters Nail Studio", "k pop demon hunters"),
            ("Noob VS. Choo-Choo Charles", "choo choo charles"),
        ] {
            assert_eq!(b.check(title, &[]), Some(term), "{title}");
        }
        for fine in ["Angry Gran", "Stevens Alexander Quest", "Huge Wuggy Fields", "Pac Rush Man"] {
            assert_eq!(b.check(fine, &[]), None, "{fine}");
        }
    }

    #[test]
    fn file_overrides() {
        let mut b = Blocklist::default();
        b.apply_file(
            "# local additions\nelsa   # Frozen dress-up knock-offs\nlabel:obby\ntitle:noob\nstart:fall\n!lego\n\n",
        );
        assert_eq!(b.check("Fall Dash", &[]), Some("fall"));
        assert_eq!(b.check("Leaves Fall", &[]), None);
        assert_eq!(b.check("Elsa Dress Up", &[]), Some("elsa"));
        assert_eq!(b.check("Lego Racer", &[]), None);
        assert_eq!(b.check("Obby Tower", &[]), None);
        assert_eq!(b.check("Tower", &v(&["obby"])), Some("obby"));
        assert_eq!(b.check("Noob Miner", &[]), Some("noob"));
        assert_eq!(b.check("Miner", &v(&["noob"])), None);
        assert_eq!(Blocklist::empty().check("Minecraft", &[]), None);
    }
}
