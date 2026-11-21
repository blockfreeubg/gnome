# GNOME games catalog: where to get up to 10,000 games legitimately

**Status:** research complete, 2026-11-09. Everything below was checked on that date with `curl`, headless Chromium (Playwright cache `chromium_headless_shell-1248`), and by reading the publishers' own terms pages. Anything I could not check is marked **UNVERIFIED**.
**Scope:** which sources the GNOME `/games` page may import; how to import them (endpoints, parameters, fields, pagination, IDs); how to embed them (iframe and header requirements); and what the terms require. Ground rules: no scraping, copying or re-hosting of copyrighted game files. Only official embeds, authorized publisher feeds/APIs, and properly licensed open-source games. Never invent catalog entries.

Raw sample responses for importer tests are in
`/tmp/claude-1000/-home-duderucool-gnome/f2049012-6316-4b31-bd8a-a00530b243a1/scratchpad/games-samples/` (see [§10](#10-sample-files-for-importer-tests)). They are scratch files; copy them into the repo's test fixtures before that directory is cleaned up.

---

## 0. Summary

### 0.1 Ranked sources (build importers in this order)

| Rank | Source | Listed now (counted 2026-11-09) | Mechanism | Third-party iframe | Registration needed | Verdict |
|---|---|---|---|---|---|---|
| 1 | **GameDistribution** (Azerion) | **21,847** (feed); site says "21K+ titles" | Public JSON/XML catalog feed, 100 items/page, ETag/304 | Yes (no XFO/CSP on `html5.gamedistribution.com`) | Publisher account (Publisher Game License Agreement) | **Implement first** |
| 2 | **GamePix** | **14,788** (v2 feed) | JSON Feed 1.1, `quality_score`, dates, 12/24/48/96 per page | Yes | Publisher SID (`sid=1` is the public default; unknown SIDs → HTTP 400) | **Implement** |
| 3 | **Playgama** | **2,856** | Catalogue API (POST JSON), ranking order, rich metadata | Yes (`frame-ancestors *`) | Partner CLID (Partners T&C, 40% share) | **Implement** |
| 4 | **GameMonetize** | **38,538** (`feed.php`); site says "38,540+" | JSON/XML feed, `num`≤1000+/page | Yes | Publisher account + "add your site in the dashboard" | **Implement** (behind quality filters; strict rate limiting) |
| 5 | **Famobi** | **649** | Single public JSON feed | Yes | Affiliate program, **minimum 50,000 visits/month** | Implement; switch on only once affiliate ID is approved |
| 6 | **itch.io** | 864,109 web projects (browse page); RSS gives 36 per page | RSS (`.xml` on any browse URL) + documented `data.json` | Official widget `itch.io/embed/<id>` and `itch.io/embed-upload/<upload_id>` send no XFO/CSP (header check only, not frame-tested); game pages are `frame-ancestors 'self' https://itch.io` | None for RSS/widget | Implement as **discovery + link-out/widget**. Playable embeds are manual, per game |
| 7 | **js13kGames** | **2,799** entries (2012–2026) | Per-year RSS | **No** (`play.js13kgames.com`: `frame-ancestors 'self' https://js13kgames.com`) | None | Implement as **link-out**. Self-host only repos with an OSS license, after review |
| 8 | **Curated open-source games** (GitHub) | 20+ verified below; 1,139 MIT repos tagged `html5-game` (not vetted) | Hand-maintained manifest; self-hosted builds | N/A (served by GNOME) | None; follow each license | Implement (small, no ads, fully under operator control) |
| 9 | **Y8** | ~34,662 `/games/` URLs in sitemap | Official per-game "Add this game to your web page" iframe snippet; **no feed/API** | Yes (`y8.com/embed/<slug>`) | None stated | **Manual curation only** (bulk import would need scraping) |
| – | CrazyGames | – | No public publisher/embed program; `/embed/<slug>` → 401 | No (`X-Frame-Options: SAMEORIGIN`) | – | **Do not use.** ToS §6.2.O bans access "through any type of proxy server"; §6.3.G bans scraping |
| – | Poki | – | No publisher program | No (`frame-ancestors https://*.poki.io …`) | – | **Do not use** |
| – | Armor Games | 10-item RSS | RSS of newest games only | No (`frame-ancestors 'self'`, XFO SAMEORIGIN) | Written permission needed to frame/deep-link | **Do not use** (possibly plain links only) |
| – | Newgrounds | – | None for third parties | No (XFO DENY), proof-of-work bot guard | Written authorization needed to copy/distribute | **Do not use** |
| – | Kongregate | – | None (robots blocks `/*.rss`, `/games/*/embed`) | No (XFO SAMEORIGIN) | – | **Do not use** |

### 0.2 How many games are legitimately reachable

* **Embeddable distributor catalogs (ranks 1–5) list 78,678 games** (21,847 + 38,538 + 14,788 + 2,856 + 649). Title-overlap samples ([§7](#7-how-many-legitimate-games-are-reachable)) show 8–27% of each catalog is also on GameDistribution. That puts the **estimate at about 55,000–70,000 unique titles** (sample-based, so this is a range, not a count).
* Link-out and discovery sources on top: itch.io (864k web projects, mostly jam/prototype quality), js13kGames (2,799), Y8 (manual), and a curated OSS set (tens to low hundreds).
* **Conclusion:** 10,000 games can be reached several times over from 2–3 networks. The real limits are (a) which networks the operator actually signs up with, and (b) quality filtering. GameDistribution + GamePix + Playgama alone come to about 30–35k unique titles.

### 0.3 Rules that affect the architecture

1. **Do not load publisher embeds through Scramjet/Ultraviolet.** Load them as normal cross-origin iframes from the GNOME origin.
   * A proxied embed has its JS rewritten and its origin and referrer replaced. Scramjet builds a synthetic `Referer` from the virtual client URL: `repos/scramjet/packages/core/src/fetch/util.ts:26-46`, `createReferrerString()`, commit `517206bc`, `@mercuryworkshop/scramjet` core `2.0.67-alpha.2`.
   * GameDistribution's terms count "referrer stripping or replacement, empty or spoofed domains" as Invalid Traffic. Playgama's count "spoofed or stripped referrer data". Both forbid altering games or SDKs.
2. **Exclude the games page and its embeds from any GNOME ad or tracker blocking.** Networks pay through in-game ads; GD §2.4 and Playgama §6.1 forbid interfering with the SDK, ads or branding.
3. **Content-policy conflict.** GD §6.2(iii)(c) says Publisher Properties may not "contain or promote … illegal activities, including … hacking", and Playgama §6.1 has a similar clause. A site that markets filter circumvention ("unblocked") could be judged in breach. Operators should tell the networks about the proxy feature when applying, or serve the games catalog from a separate (sub)domain with no circumvention marketing.

---

## 1. Method and evidence

* Every count, field list and header below comes from live requests on 2026-11-09, using the user agent `Mozilla/5.0 (X11; Linux x86_64) GNOME-research/0.1` (or a Chrome UA for HTML pages). Requests were kept small, with ≥1 s gaps and background back-off where I hit rate limits (GameMonetize, itch.io).
* Totals were found by binary search on the page number (GD, GameMonetize), from `last_page_url` (GamePix), from `totalCount` (Playgama), from `num_games` (Famobi), and by counting RSS items (js13k).
* **Embedding check:** a local page at `http://127.0.0.1:8765/` held ten iframes (GD, GM, GamePix, Playgama, Famobi, Y8, js13k, Poki, CrazyGames, Armor Games). Headless Chromium 156 recorded which frames loaded and which were blocked ([§8](#8-embedding-verification-matrix)).
* Terms were read from each publisher's own page. Dates are the ones printed on those pages.
* Helper scripts: `/tmp/claude-1000/-home-duderucool-gnome/f2049012-6316-4b31-bd8a-a00530b243a1/scratchpad/games-research/scripts/` (`render.sh`, `netlog.cjs`, `embedcheck.cjs`, `overlap.py`, `lic.sh`, the probe scripts). Raw captures are in `…/games-research/raw/`.

---

## 2. Unified schema (SQLite)

One table for all sources. One row = one source listing. Cross-source duplicates are linked via `canonical_id` ([§9.3](#93-deduplication-across-sources)).

```sql
CREATE TABLE games (
  id               INTEGER PRIMARY KEY,
  source           TEXT NOT NULL,      -- 'gamedistribution'|'gamepix'|'playgama'|'gamemonetize'|'famobi'|'itchio'|'js13k'|'y8'|'oss'
  source_id        TEXT NOT NULL,      -- stable ID inside the source (see per-source "Stable ID")
  slug             TEXT NOT NULL UNIQUE, -- GNOME URL slug, e.g. 'obby-1-laser-to-break-walls' (+ '-2' on collision)
  title            TEXT NOT NULL,      -- HTML-unescaped, trimmed
  description      TEXT,               -- plain text (strip HTML)
  instructions     TEXT,               -- controls / how to play, when provided
  developer        TEXT,               -- NULL when the source does not expose it (GD, GM, GamePix, Playgama, Famobi)
  thumbnail_url    TEXT NOT NULL,      -- best landscape image (~512x384 or 16:9/16:10)
  thumbnails       TEXT NOT NULL DEFAULT '[]', -- JSON [{url,w,h,kind:'landscape'|'square'|'icon'|'wide'|'cover'}]
  embed_kind       TEXT NOT NULL,      -- 'iframe' | 'widget' | 'link' | 'selfhost'
  embed_url        TEXT,               -- template-expanded at render time (publisher IDs from config)
  source_url       TEXT,               -- canonical page at the source (attribution link)
  categories       TEXT NOT NULL DEFAULT '[]', -- JSON array of GNOME categories (§6), primary first, max 3
  source_categories TEXT NOT NULL DEFAULT '[]', -- JSON, raw source categories
  tags             TEXT NOT NULL DEFAULT '[]', -- JSON, normalized lowercase tags (SEO junk removed, §9.4)
  width            INTEGER,            -- native/preferred size (NULL if unknown)
  height           INTEGER,
  orientation      TEXT,               -- 'landscape'|'portrait'|'any'|NULL
  mobile           INTEGER,            -- 1/0/NULL(unknown)
  published_at     TEXT,               -- ISO-8601 UTC or NULL
  updated_at       TEXT,               -- ISO-8601 UTC or NULL
  popularity_rank  INTEGER,            -- position in the source's popularity/quality ordering (1 = best), NULL if none
  popularity_score REAL,               -- normalized 0..1 inside the source (GamePix quality_score; 1 - rank/N otherwise)
  license          TEXT,               -- SPDX id for 'oss'/'js13k' self-hosted entries, else NULL
  attribution      TEXT,               -- e.g. 'via GameDistribution', 'by Emlise on itch.io', 'MIT © 2014 Gabriele Cirulli'
  flags            TEXT NOT NULL DEFAULT '[]', -- JSON: 'kids_friendly','no_blood','iap','ip_risk','nsfw_risk', ...
  status           TEXT NOT NULL DEFAULT 'active', -- 'active'|'missing'|'removed'|'blocked'
  canonical_id     INTEGER REFERENCES games(id), -- set on duplicates (points at preferred listing)
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  missing_count    INTEGER NOT NULL DEFAULT 0, -- consecutive syncs without the item
  raw              TEXT NOT NULL,      -- original record (JSON or XML-as-JSON) for re-mapping
  UNIQUE (source, source_id)
);
CREATE INDEX games_cat ON games(status, canonical_id);
CREATE TABLE game_categories (game_id INTEGER REFERENCES games(id) ON DELETE CASCADE, category TEXT, PRIMARY KEY (game_id, category));
CREATE TABLE source_state (source TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, last_sync_at TEXT, last_total INTEGER, last_error TEXT);
```

Store publisher IDs in config, not in rows, so they can rotate. `embed_url` keeps the source template; the API fills in placeholders at render time:

```toml
[games.sources.gamedistribution] enabled = true                 # embed adds ?gd_sdk_referrer_url=<GNOME game page URL>
[games.sources.gamepix]          enabled = true  sid = "1"      # replace with publisher SID from my.gamepix.com
[games.sources.playgama]         enabled = true  clid = ""      # partner CLID from widgets.playgama.com
[games.sources.gamemonetize]     enabled = false                # enable after the site is added in the GM dashboard
[games.sources.famobi]           enabled = false affiliate_id = "" # e.g. "A-XXXXX" (format UNVERIFIED, see §3.5)
[games.sources.itchio]           enabled = true  mode = "link"  # 'link' | 'widget'
[games.sources.js13k]            enabled = true  mode = "link"
```

---

## 3. Embeddable distributor feeds

### 3.1 GameDistribution (Azerion / Keygames Network B.V.), rank 1

**Program and terms**
* Publisher page: <https://gamedistribution.com/publishers/partnership/>. It offers "Direct Game Integration — Embed GameDistribution game URLs into your site's gaming pages", a white-label portal, and licensed content. It says "21K+ titles", "1K game creators", "26 different genres". Contact: partnership@azerion.com.
* Terms: **Publisher Game License Agreement** <https://static.gamedistribution.com/terms/publisher.html> ("last updated 19 June 2025"). Key clauses:
  * Licence goes only to Publishers with an active account. Not allowed: subscription or pay-to-own models, native app stores (§2.1, intro).
  * Distributor gets exclusive authority to sell in-game ads and IAP (§2.2).
  * Publisher must implement the "Tags" (scripts, tags, **ads.txt**) and the technical spec; Distributor may approve the implementation first (§2.3 + definitions).
  * **Must not "alter, change, modify, observe, reverse-engineer, or interfere with" the SDK, Games or Tags** (§2.4).
  * Must keep "a valid and active Google Ad Manager account" for HeaderLift ad management (§2.6).
  * **Revenue share 33% of Net Revenue**; paid when ≥ EUR 100 (§3.1, §3.3).
  * Must not remove or change branding or links in games (§6.2(ii)(b)).
  * Publisher Properties must not "contain or promote … illegal activities, including, but not limited to hacking" (§6.2(iii)(c)), or illegal file-sharing (§6.2(iii)(f)).
  * "No monitoring": no automated access "for monitoring availability, performance, or functionality, or for benchmarking" without consent (intro).
  * Invalid Traffic includes "**referrer stripping or replacement, empty or spoofed domains**".
  * Remove all games on termination (§7.6).
* Developer terms: <https://static.gamedistribution.com/terms/developer.html> (not needed for importing).
* `robots.txt` allows everything. The sitemap has 30,893 `/games/<slug>/` pages. That is a superset of the distributable feed; use the feed.

**Endpoint** (public, no auth, `Access-Control-Allow-Origin: *`, ETag; `If-None-Match` → **304** verified)
```
GET https://catalog.api.gamedistribution.com/api/v2.0/rss/All/
    ?collection=all&categories=All&tags=All&subType=all&type=all&mobile=all&rewarded=all
    &amount={1..100}&page={1..N}&format=json|xml
```
* Parameters, verified by experiment:
  * `amount` is capped at **100** (requests for 500 or 1000 still return 100).
  * `page` starts at 1. Past the end the API returns `[]`.
  * `categories=<GD category>` filters (e.g. `Puzzle`; `Puzzle,Casual` also gives 200).
  * `tags=<tag>`, `subType=WebGL|Javascript|…` and `type=html5` are accepted.
  * `rewarded=1|true` is accepted but changed nothing in the sample.
  * Only `collection=all` works. `exclusive|best|hot|new|featured` → **HTTP 500**.
  * `mobile` only accepts `all`. `1`, `true`, `0` → **HTTP 500**.
  * Unknown parameters (e.g. `company=`) and duplicate keys → HTTP 500.
  * The path segment after `/rss/` must be `All` (`/rss/Puzzle/` returns `[]`).
* **Total on 2026-11-09:** 218 full pages of 100 + 47 on page 219 = **21,847**.
* `format=xml` is RSS 2.0 with `title, description, status, category*, company (always empty in 200 sampled items), guid (=Md5), link (=Url), g:image_link*`. It has **no** tags, size or mobile flag, so **use JSON**. `format=rss` returns JSON.
* Ordering: newest first (UNVERIFIED; there is no date field to confirm it).
* The website's own GraphQL API (`gd-website-api.gamedistribution.com`, `wizardSearchRSS` with `sortBy`, `performanceIndicator`, `developers`, `publishedAt`) is internal. **Do not use it** (undocumented, plus the "No monitoring" clause).

**JSON item** (`Vec<GdGame>`, every field present in all 448 sampled items):
```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct GdGame {
    pub title: String,
    pub md5: String,                 // 32 hex, stable ID; also in Url and image names
    pub description: String,         // 4/448 empty
    pub instructions: String,
    #[serde(rename = "Type")] pub kind: String,   // "html5" (448/448)
    pub sub_type: String,            // "Javascript" 218, "WebGL" 124, "Construct 2" 86, "Construct 3" 20
    pub mobile: String,              // "true" | "false"  (STRING, not bool) — 164 true / 284 false
    pub mobile_mode: Option<String>, // always null in samples
    pub height: u32, pub width: u32, // e.g. 1280x720, 800x600, 960x540, 720x1280 (portrait)
    pub https: Option<bool>,         // true 415, null 32, false 1 (the false one has an http:// Url)
    pub status: i64,                 // 2 = 428/448, 1 = 11, 15, 14, 9, 0 — meaning UNVERIFIED; all loaded fine
    pub url: String,                 // "https://html5.gamedistribution.com/<md5>/"
    pub asset: Vec<String>,          // "https://img.gamedistribution.com/<md5>-<W>x<H>.jpg|.jpeg"
    pub category: Vec<String>,       // 1–2 values (411 have 1, 37 have 2)
    pub tag: Vec<String>,            // free tags + content flags "No Blood", "Kids Friendly", "No Cruelty"
}
```
* **Thumbnail sizes:** filename suffixes `512x384` (4:3), `512x512`, `512x340`, `200x120`, `1280x720`, `1280x550`, as `.jpg` or `.jpeg`. A few legacy items have a bare `<md5>.jpg`. Pick `512x384`, else `1280x720`, else the first entry. Read W×H from the suffix.
* **Categories** (31, from `https://gamedistribution.com/sitemap-categories.xml`): `.IO, 3D, Action, Adventure, Agility, Arcade, Art, Basketball, Battle, Boardgames, Bubble Shooter, Cards, Care, Casual, Cooking, Dress-up, Educational, Football, Girls, Jigsaw, Mahjong & Connect, Match-3, Merge, Puzzle, Quiz, Racing, Racing & Driving, Shooter, Simulation, Sports, Strategy`. There are 758 tags (`sitemap-tags.xml`), including `horror, scary, idle, clicker, platformer, sandbox, multiplayer, 2players, zombie, runner, tycoon`.
* Distribution in a 448-item sample (pages 1, 60, 120, 180, 219): Casual 84, Puzzle 67, Dress-up 64, Adventure 37, Racing & Driving 31, Shooter 29, Simulation 26, Battle 26, Agility 20, .IO 13, …
* **Not in the feed:** developer/company, publish dates, popularity. The embed page's JSON-LD does contain `creator.name` (e.g. "Serbull"), but fetching every embed page to read it is per-game crawling. **Leave `developer` NULL**, or ask GD for a feed that includes it.

**Embed** (official docs: <https://github.com/GameDistribution/gd-embed-game> README)
* Direct: `https://html5.gamedistribution.com/<md5>/?gd_sdk_referrer_url=<exact GNOME game page URL>`. The README defines `gd_sdk_referrer_url` as "Your exact game page url".
* Wrapper alternative: `https://embed.gamedistribution.com/?url=<Url>&width=W&height=H&language=en&gdpr-tracking=1&gdpr-targeting=1&gdpr-third-party=1&gd_sdk_referrer_url=…`. The `gdpr-*` flags can be set to `0` to follow the user's CMP choice.
* Headers on `html5.gamedistribution.com` (HEAD and GET): **no `X-Frame-Options`, no CSP**, `Access-Control-Allow-Origin: *`, CloudFront.
* Headless test: the iframe loaded (title "Obby: +1 Laser to Break Walls"). The loader page adds an inner `<iframe id=game allow=autoplay allowfullscreen>` pointing at `//html5.gamedistribution.com/<token>/<md5>/index.html` after the SDK's pre-roll (`SDK_GAME_START`). It reads `parentURL`, `parentDomain` and `topDomain` (inline loader script) for ad attribution and domain checks.

**Mapping to the unified schema**

| unified | GameDistribution |
|---|---|
| source_id | `Md5` |
| slug | slugify(`Title`) |
| title / description / instructions | `Title` / `Description` / `Instructions` |
| developer | NULL (not exposed) |
| thumbnail_url, thumbnails | `Asset[]` → pick `-512x384`; parse `-WxH` |
| embed_kind / embed_url | `iframe` / `Url` + `?gd_sdk_referrer_url={page_url}` |
| source_url | NULL (GD website slugs are not in the feed) |
| source_categories / categories | `Category[]` → [§6.1](#61-primary-category-tables) |
| tags / flags | `Tag[]` lowercased; `No Blood`→`no_blood`, `Kids Friendly`→`kids_friendly`, `No Cruelty`→`no_cruelty` |
| width / height / orientation | `Width` / `Height` / derived (`h>w` → portrait) |
| mobile | `Mobile == "true"` |
| published_at / updated_at | NULL |
| popularity | none. Use GNOME's own play counts. Feed position may only mean "newest" |
| raw extras | `Type, SubType, Status, Https, MobileMode` |

### 3.2 GamePix, rank 2

**Program and terms**
* <https://partners.gamepix.com/publishers>: "Publisher Affiliate Program … Join the Affiliate Program by registering on the GamePix Dashboard … integration works via direct embedding, JSON API, or ready-made white-label websites". Revenue share; the percentage is not public.
* Dashboard: <https://my.gamepix.com/> (login required; the publisher-specific terms there are **UNVERIFIED**).
* The site terms (iubenda, <https://www.iubenda.com/terms-and-conditions/67570123>) say: "Users may not reproduce, duplicate, copy, sell, resell or exploit any portion of this Website … without the Owner's express prior written permission, granted either directly or **through a legitimate reselling program**". The affiliate program is that route.
* Feed generator: <https://partners.gamepix.com/rss-feed>. Its warning: "⚠️ Don't use this URL if you already have a Publisher account. Monetize your site by accessing our dashboard."
* `www.gamepix.com` returns 403 to curl (bot protection). `partners.gamepix.com` and `feeds.gamepix.com` respond normally.

**Endpoint** (public, `Access-Control-Allow-Origin: *`, `Content-Type: application/feed+json`; no ETag seen)
```
GET https://feeds.gamepix.com/v2/json?sid={SID}&page={1..}&pagination={12|24|48|96}[&order=pubdate][&category={namespace}]
GET https://feeds.gamepix.com/v2/xml?...same...     (RSS 2.0: guid=embed URL, title, description, category, pubDate only)
```
* The generator (`rss-feed` JS chunk) builds `https://feeds.gamepix.com/v2/{json|xml}?page=1&pagination={12|24|48|96}` plus optional `&category=` and `&order=pubdate`. Default order is `quality`.
* **`sid`:** leaving it out gives `sid=1` (the public default). **Any unregistered SID → HTTP 400 `{"message":"Bad request: sid not found"}`**; I tried `TEST123` and `12345`. So a real publisher SID is required to monetize.
* `pagination=100` or `200` → no items. Use 96.
* Pagination fields: `next_url` (missing on the last page), `first_page_url`, `last_page_url`, `modified`.
* **Total:** `last_page_url` gives page 617 at 24/page; page 617 holds 4 items → **14,788**. (At 96/page: 155 pages.) The legacy `/v1/json` reports 255 pages × 24 ≈ 6.1k. Use v2.
* `category` filtering verified (`category=puzzle` → only `puzzle`). There are 148 namespaces (from the generator's `__NEXT_DATA__`):
  `2048, action, addictive, adventure, airplane, animal, anime, arcade, archery, ball, baseball, basketball, battle, battle-royale, bejeweled, bike, block, board, bowling, boxing, brain, bubble-shooter, building, car, card, casual, cats, checkers, chess, christmas, city-building, classics, clicker, coco, coding, coloring, cooking, cool, crazy, cricket, dinosaur, dirt-bike, dragons, drawing, dress-up, drifting, driving, educational, escape, family, farming, fashion, fighting, fire-and-water, first-person-shooter, fishing, flash, flight, fun, games-for-girls, gangster, gdevelop, golf, granny, gun, hair-salon, halloween, helicopter, hidden-object, hockey, horror, horse, hunting, hyper-casual, idle, io, jewel, jigsaw-puzzles, jumping, knight, mahjong, makeup, management, mario, match-3, math, memory, minecraft, mining, mmorpg, mobile, money, monster, multiplayer, music, naval, ninja, ninja-turtle, offroad, open-world, parking, parkour, piano, pirates, pixel, platformer, police, pool, puzzle, racing, restaurant, retro, robots, rpg, runner, scary, scrabble, sharks, shooter, simulation, skateboard, skibidi-toilet, skill, snake, sniper, soccer, solitaire, spinner, sports, stickman, strategy, surgery, survival, sword, tanks, tap, tetris, trivia, truck, two-player, tycoon, vibe-coded, war, word, world-cup, worm, wrestling, zombie`.

**JSON Feed item** (`items[]`):
```rust
pub struct GpFeed { pub version: String, pub title: String, pub home_page_url: String, pub feed_url: String,
    pub next_url: Option<String>, pub first_page_url: String, pub last_page_url: String, pub modified: String,
    pub items: Vec<GpItem> }
pub struct GpItem {
    pub id: String,            // e.g. "737HCH" (5–6 chars; 2-char ids exist) — stable ID
    pub title: String,
    pub namespace: String,     // slug, e.g. "prism-match-3d"
    pub description: Option<String>, // present in ~55% (160/288 sampled)
    pub category: String,      // one namespace from the list above
    pub orientation: String,   // "landscape" | "portrait" | "all"
    pub quality_score: f64,    // 0.24..0.98 observed — popularity/quality signal
    pub width: u32, pub height: u32, // only 800x600 or 600x800 observed (orientation-derived, not native)
    pub date_modified: String, pub date_published: String, // RFC 1123, e.g. "Wed, 12 Nov 2025 12:34:52 GMT"
    pub banner_image: String,  // https://img.gamepix.com/games/<ns>/cover/<ns>.png?w=320  → 320x200 JPEG (w= resizes)
    pub image: String,         // https://img.gamepix.com/games/<ns>/icon/<ns>.png?w=105  → 105x105
    pub url: String,           // https://play.gamepix.com/<ns>/embed?sid=<SID>
}
```

**Embed:** `https://play.gamepix.com/<namespace>/embed?sid=<SID>`.
* Headers: no XFO/CSP (S3 + CloudFront). The headless iframe loaded.
* The player loads Google ad scripts and an **iubenda consent banner inside the frame**. It also tags itself with `window.google_page_url = location.href`.

**Mapping**

| unified | GamePix |
|---|---|
| source_id / slug | `id` / `namespace` |
| title / description | `title` / `description` (nullable) |
| developer | NULL |
| thumbnail_url / thumbnails | `banner_image` (`?w=` up to the needed width; 16:10) / + `image` (square icon) |
| embed_url | `url` with the `sid` replaced by config |
| categories | `category` → [§6.1](#61-primary-category-tables) |
| width/height/orientation | `width`/`height` (not native) / `orientation` (`all`→`any`) |
| mobile | NULL (UNVERIFIED; GamePix markets every game as cross-platform) |
| published_at / updated_at | parse `date_published` / `date_modified` |
| popularity_score / rank | `quality_score` / position under `order=quality` |

### 3.3 Playgama, rank 3

**Program and terms**
* <https://playgama.com/partners>: "Earn up to 50% from Ads & in-game purchases … download all our games in one JSON file … Log in to get your unique partner CLID … Withdraw earnings once you reach $100".
* Docs: <https://wiki.playgama.com/playgama/for-partners/getting-started> and <https://wiki.playgama.com/playgama/for-partners/import-the-game-catalog.md>. Steps: register at widgets.playgama.com, get a **CLID** ("automatically embedded in all iframe codes, affiliate links, and widgets"), download catalog JSON, embed `gameURL` in an `<iframe>`.
* **Partners Terms and Conditions** (Chapter 2 of <https://playgama.com/termsofuse#partners-terms>, "Last Updated: 28.01.2026"; counterparty LeadToChanges L.L.C-FZ, Dubai). Key clauses:
  * Licence for the web version on the Partner's Platform; no native app stores without written approval (§2.1).
  * Company sells ads and IAP (§2.2).
  * Integrate through the provided widgets, API or links (§3.1).
  * Follow branding and technical requirements (§3.3–3.4).
  * **Remove games on request; the licence ends when a game is removed** (§3.5).
  * Registration must be approved (§4.1).
  * **Partner gets 40% of Net Revenue**; payout from $100 (§5.1, §5.3, §5.5).
  * §6.1: do not alter games or widgets; no bots or fraud; do not remove branding; the platform must not contain, promote or link to "illegal activities, including but not limited to hacking", pirated content, or incentivized traffic.
  * Invalid Traffic includes "**spoofed or stripped referrer data**".
* `robots.txt` disallows `/api/` on playgama.com. The catalogue API used below is on `widgets.playgama.com` and is what the official catalog UI calls.

**Endpoint** (what the official catalog page at <https://widgets.playgama.com/> calls; seen in a headless network log; **no login needed**, but without login the CLID is not attached)
```
GET  https://widgets.playgama.com/api/v1/partner/export/catalogue/sort      -> {"sortOptions":[{"id":"ranking_default","title":"Top performance"},{"id":"created_at","title":"New games",...}]}
GET  https://widgets.playgama.com/api/v1/partner/export/catalogue/filters   -> {ageGroups[], genders[], interests[657 ids], mobileReady[], supportedLanguages[]}
POST https://widgets.playgama.com/api/v1/partner/export/catalogue/games     (Content-Type: application/json) -> 201
     {"pagination":{"limit":100,"offset":0},"sort":{"type":"ranking_default"},
      "filters":{"ageGroups":[],"interests":[],"platforms":[],"supportedLanguages":[],"hasInAppPurchases":false}}
```
* Response: `{"games":[…], "totalCount": 2856}`.
* **Pagination quirk:** `offset` is rounded down to a multiple of `limit`, i.e. page = ⌊offset/limit⌋. `offset=1` returns the same rows as `offset=0`. `limit=1000, offset=2000` → 856 rows. Use `offset = page * limit`.
* `limit` up to at least 1000 works.
* `interests` ids include `top_playgama, trending_now, popular, arcade, io, action, puzzle, racing, adventure, match-3, cards, sports, strategy, simulation, skill, two-player, horror, multiplayer, tycoon, platform, clicker, obby, idle, survival, …`. **Many are brand names:** `minecraft, gta, mario-games, pokemon-games, five-nights-at-freddy-games, roblox-games, sprunki, among-us, subway-surfers-games, fortnite-ripoff-games, …` (see [§11](#11-compliance-checklist), IP risk).
* This API is undocumented; the wiki documents the "Download JSON" UI. Treat its shape as UNVERIFIED-stable and keep the importer tolerant. The documented fallback is the operator downloading the JSON from the UI after login (it contains the CLID) and uploading it to GNOME's admin import.

**Game object** (all 16 keys present in 100/100 items):
```rust
pub struct PgResp { pub games: Vec<PgGame>, #[serde(rename = "totalCount")] pub total_count: u32 }
#[serde(rename_all = "camelCase")]
pub struct PgGame {
    pub id: String,                  // numeric string, e.g. "97426" — stable ID
    pub slug: String,                // "piece-of-cake-merge--bake"
    pub title: String,
    pub description: String,         // long, multi-paragraph text
    pub how_to_play_text: String,
    #[serde(rename = "gameURL")] pub game_url: String,          // https://playgama.com/export/game/<slug>  (embed)
    #[serde(rename = "playgamaGameUrl")] pub playgama_game_url: String, // https://playgama.com/game/<slug> (source page)
    pub genres: Vec<String>,         // e.g. ["cozy","puzzle","merge","cooking",...]
    pub tags: Vec<String>,           // e.g. ["defold-games-online","relaxing-games",...]
    pub images: Vec<String>,         // [big_preview (1920x1080 PNG observed; ?width= ignored), icon]
    pub videos: Vec<serde_json::Value>, // {playgama_id, external_url, type:"gameplay"}
    pub mobile_ready: Vec<String>,   // "For Android" | "For IOS" | "For Desktop"
    pub gender: Vec<String>,
    pub in_game_purchases: String,   // "Yes" | "No"
    pub supported_languages: Vec<String>, // e.g. ["en-US"]
    pub screen_orientation: PgOrient, // {horizontal: bool, vertical: bool}
}
```

**Embed:** `https://playgama.com/export/game/<slug>`.
* Header: `content-security-policy: frame-ancestors *; …`, so framing is explicitly allowed anywhere. The headless iframe loaded (ads, TCF locators, recaptcha).
* The docs' snippet is `<iframe src="…" frameborder="0" width="100%" height="600px">`.
* How the CLID is attached to `gameURL` once logged in is **UNVERIFIED**. The widget JS appends `?clid=<clid>&widget_id=<id>` to modal game URLs, so expect `?clid=`.

**Mapping**

| unified | Playgama |
|---|---|
| source_id / slug | `id` / `slug` |
| title / description / instructions | `title` / `description` / `howToPlayText` |
| developer | NULL |
| thumbnail_url | `images[0]` (16:9 preview); `images[1]` = icon |
| embed_url / source_url | `gameURL` (+`clid`) / `playgamaGameUrl` |
| categories / tags | `genres[]` → keyword rules [§6.2](#62-keyword-rules-secondary-categories-and-fallbacks); `tags[]` |
| orientation | `screenOrientation` → both true = `any`, else `landscape`/`portrait` |
| mobile | `mobileReady` contains "For Android" or "For IOS" |
| flags | `inGamePurchases=="Yes"` → `iap` |
| popularity_rank | position under `sort.type=ranking_default` |
| published_at | NULL (order by `created_at` exists, but there is no date field) |

### 3.4 GameMonetize (GMO Holding Ltd.), rank 4

**Program and terms**
* <https://gamemonetize.com/publishers>: "Choose from 38,540+ games … 45% Revenue share … Net 30". Payouts by PayPal and USDT ERC20, minimum $30 (<https://gamemonetize.com/faq>).
* The FAQ: "**You can embed games on your site, register on our portal, add your site in the dashboard and get revenue share from games published to your website.**"
* The site ToS (<https://gamemonetize.com/termofuse.php>, linked from registration) is generic: no copying of site material; Norway law.
* `robots.txt` is empty (`User-Agent: *`).
* **Rate limiting:** Cloudflare **error 1015** after about 4 back-to-back `num=1000` requests (~1 MB each) within ~10 s. Space requests ≥10 s apart.

**Endpoints**
```
A) GET https://gamemonetize.com/feed.php?format=0|1&num={N}&page={P}[&category={id}][&company={CompanyNoSpaces}]
      format=0 -> JSON array; format=1 -> RSS 2.0 (<item><id,title,type,description,instructions,category,tags,url,thumb,width,height>)
B) GET https://rss.gamemonetize.com/rssfeed.php?format=json|xml&category=All|{id}&type=html5|mobile&popularity={p}&company=All|{name}&amount={10|20|30|40|100|All}
      (official RSS Builder https://gamemonetize.com/rss-builder; gamemonetize.com/rssfeed.php 302-redirects here)
```
* **Use A for the full sync.**
  * `num` up to at least 1000 works.
  * Total: 38 pages × 1000 + **538** on page 39 = **38,538**. Page 40 is empty.
  * `category=<id>` and `company=` filter. `popularity` and `type` are **ignored** by feed.php (identical results).
* **Use B for popularity ranks.**
  * `popularity` ∈ `newest, mostplayed, hotgames, bestgames, exclusivegames, editorpicks, branding` ("No Branding"). `mostplayed` and `exclusivegames` change the ordering (verified).
  * **No paging:** `page` is ignored. B also **returns `amount + 1` items** (asking for 10 gives 11).
  * `amount=All` presumably returns the whole ranked list in one response. Size not tested, UNVERIFIED.
* Category ids (RSS Builder): Action=0, .IO=1, 2 Player=2, 3D=3, Adventure=4, Arcade=5, Bejeweled=6, Boys=7, Clicker=8, Cooking=9, Girls=10, Hypercasual=11, Multiplayer=12, Puzzle=13, Racing=14, Shooting=15, Soccer=16, Sports=17, Stickman=18, Baby Hazel=19, AI=20.
* 1,293 company options in the builder.
* **Ids differ by endpoint:** the same game is `id:"88558"` in feed.php but `id:"38540"` in rssfeed.php. **Use the 32-char hash in `url` as the stable ID.** It is the same in both endpoints and in the thumbnail path.
* **Entity escaping:** feed.php JSON gives `"Dash &amp; Slash"`; rssfeed.php gives `"Dash &amp;amp; Slash"`. HTML-unescape **twice**.
* Category labels can differ between endpoints for the same game (`Stickman` vs `Fighting`, `Puzzle` vs `Puzzles`). Prefer feed.php.

**JSON item (feed.php):**
```rust
pub struct GmGame {
    pub id: String,           // endpoint-specific numeric string — NOT stable across endpoints
    pub title: String,        // HTML-escaped
    pub description: String, pub instructions: String,
    pub url: String,          // https://html5.gamemonetize.co/<32-char-hash>/   (embed) — hash = stable ID
    pub category: String,     // single label
    pub tags: String,         // comma-separated, includes SEO noise ("free games for your website", "2026 games", "Best Games")
    pub thumb: String,        // https://img.gamemonetize.com/<hash>/512x384.jpg (also 512x512.jpg, 512x340.jpg exist)
    pub width: String, pub height: String, // strings: "800","600" (459/1000), "1280","720" (148/1000), ...
}
```
* Distribution in the newest 1000: Puzzle 257, Arcade 132, Racing 128, Hypercasual 105, Adventure 104, Shooting 87, Sports 49, Girls 27, Clicker 25, Action 25, Multiplayer 18, Stickman 12, …
* **Not exposed:** developer (only usable as a filter), dates, mobile flag, numeric popularity.

**Embed:** `https://html5.gamemonetize.co/<hash>/`. No XFO/CSP (Cloudflare), `Access-Control-Allow-Origin: *`. The headless iframe loaded (a Unity WebGL build with its SDK inside). How the publisher is attributed is not documented publicly; it is site-based via the dashboard (**UNVERIFIED**).

**Mapping**

| unified | GameMonetize |
|---|---|
| source_id | hash from `url` path (`/([a-z0-9]{32})/`) |
| title / description / instructions | unescape(`title`) etc. |
| developer | NULL |
| thumbnail_url | `thumb` (512x384); derive `512x512.jpg`, `512x340.jpg` |
| embed_url | `url` |
| categories / tags | `category` → [§6.1](#61-primary-category-tables); `tags.split(',')` minus SEO noise ([§9.4](#94-text-hygiene)) |
| width / height | parse ints |
| mobile | NULL (tags `Mobile`/`Android` are weak hints) |
| popularity_rank | position in rssfeed.php `popularity=mostplayed` (optional job) |

### 3.5 Famobi (Famobi GmbH, Cologne), rank 5

**Program and terms**
* <https://famobi.com/publishers/>: "Affiliate Partner Program … **To be eligible for registering as an affiliate partner you need a minimum of 50.000+ total visits per month on your website or app.** Apply Now".
* The general ToS (<https://famobi.com/terms-of-service/>) is end-user oriented. Affiliate terms come with the application (UNVERIFIED).
* Famobi's demo portal <https://html5games.com/> shows "Place the game link on your website!" with the bare link `https://play.famobi.com/<package_id>`. Its own links use the affiliate form `https://play.famobi.com/<package_id>/A1000-10` and `//play.famobi.com/wrapper/<package_id>/A1000-10`.

**Endpoint:** `GET https://api.famobi.com/feed` → whole catalog in one response (~512 KB).
* `n=<limit>` truncates. `o`, `page`, `a`, `category`, `lang` had no effect.
* `{"categories":[23 strings],"num_games":649,"games":[…]}`.

```rust
pub struct FaFeed { pub categories: Vec<String>, pub num_games: u32, pub games: Vec<FaGame> }
pub struct FaGame {
    pub package_id: String,   // stable ID & slug, e.g. "gun-spin"
    pub name: String, pub description: String, // one-line tagline
    pub thumb: String,        // 320x320 JPEG (verified); thumb_60 / thumb_120 / thumb_180 square variants
    pub thumb_60: String, pub thumb_120: String, pub thumb_180: String,
    pub link: String,         // https://play.famobi.com/<package_id>
    pub date: String,         // "YYYY-MM-DD" (2014-08-02 .. 2026-10-28)
    pub aspect_ratio: f64,    // w/h; 0 = unknown (72), 1 (193), 0.67, 1.78, ...
    pub related: Vec<serde_json::Value>,
    pub categories: Vec<String>,
    pub orientation: String,  // "none" | "portrait" | "landscape" (+ one typo "landcape")
    pub highscores_enabled: bool,
}
```
Categories: `action, puzzle, arcade, management, racing, skill, girls, quiz, match-3, sports, cars, mahjong, educational, bubble-shooter, cards, dress-up, make-up, multiplayer, jump-and-run, time-management-and-strategy, tamagotchi, cooking, breakout`.

**Embed:** `https://play.famobi.com/<package_id>/<affiliate_id>` (affiliate form as used on html5games.com; the exact ID format for new affiliates is UNVERIFIED). No XFO/CSP. The headless iframe of `https://play.famobi.com/gun-spin` loaded.
**Mapping:**
* `source_id=package_id`, `title=name`, `thumbnail_url=thumb`, `embed_url=link + '/' + affiliate_id`, `published_at=date`.
* `width/height`: NULL; keep `aspect_ratio` in `raw`.
* `orientation`: `none`→`any`.
* `mobile=1` (Famobi games are built mobile-first; UNVERIFIED per game).
* No popularity signal.
* **Gate:** keep `enabled=false` until an affiliate ID exists. Plain links to `play.famobi.com/<id>` are what Famobi invites any site to do ("Place the game link on your website").

---

## 4. Link-out and discovery sources

### 4.1 itch.io, rank 6 (discovery, widget, link-out)

**Official mechanisms**
* **RSS:** "For any browse page URL … append `.xml` to the end of the URL to get access to an RSS feed", plus `https://itch.io/feed/new.xml`, `/feed/featured.xml`, `/feed/sales.xml` (<https://itch.io/docs/api/overview>).
  * Useful browse URLs: `https://itch.io/games/free/platform-web.xml`, `/games/newest/free/platform-web.xml`, `/games/free/genre-puzzle/platform-web.xml`, `/games/free/platform-web/tag-open-source.xml`.
  * Paging: `?page=N`, 36 items per page. Page 2 verified on `/games/platform-web.xml`; pages 50 and 100 verified on `/games/free/platform-web.xml`. `/games/free/platform-web.xml?page=500` → 404, so there is a cap (exact value UNVERIFIED).
  * `https://itch.io/games/platform-web` reports **864,109 results** for web.
* **Widget embed:** "You can easily get embed codes for any page on itch.io by clicking the Embed link at the very bottom of the page … The widget can be used for web games as well, instead of including links to download or purchase it will link back to your game page on itch.io" (<https://itch.io/docs/creators/widget>).
  * `https://itch.io/embed/<game_id>` sends **no XFO/CSP** (verified), so it can be framed.
* **Game metadata:** the documented JS API `Itch.getGameData({user, game, onComplete})` (<https://itch.io/docs/api/javascript>). Its `https://static.itch.io/api.js` builds `https://<user>.itch.io/<game>/data.json` (verified).
  * Response: `{id, title, cover_image, screenshots[], authors[{name,url}], tags[], links{self,devlog,comments}}`, plus price and rewards when set.
* **Playable HTML5 embed:** `https://itch.io/embed-upload/<upload_id>?color=…` sends no XFO/CSP (verified). It wraps `https://html-classic.itch.zone/html/<upload_id>/index.html`.
  * The `upload_id` is only in the game page HTML (`html-classic.itch.zone/html/20401285/…` on `emlise.itch.io/seasonshift`). It is **not** in RSS or `data.json`. Getting it in bulk would mean crawling game pages.
  * So **playable embeds are manual**: an operator copies the code from the game's "Embed" dialog.
  * Game pages themselves send `content-security-policy: frame-ancestors 'self' https://itch.io`. Never hotlink `html-classic.itch.zone`.
* **Terms** (<https://itch.io/docs/legal/terms>, "Updated April 15 2023"): publishers give users "a non-exclusive, perpetual license to access the content … **as permitted through the functionality of the Service**". Widgets and links are such functionality; re-hosting is not.
* `robots.txt` disallows crawling `/embed/` and `/embed-upload/` (they are iframe targets, not crawl targets).
* **Rate limits:** HTTP **429** within a few requests even at ~1 request per 25 s. It recovered after about 2 minutes. Budget **≤2 requests/min** with exponential back-off.

**RSS item fields** (12, all present): `guid` (=game URL), `title` (decorated, e.g. `"Season Shift [Free] [Puzzle]"`), `plainTitle`, `imageurl` (`https://img.itch.zone/<b64>/315x250%23c/<x>.png` crop, or `/original/`), `price` (`$0.00`), `currency`, `link`, `description` (CDATA: short text + `<img>`), `pubDate`, `createDate`, `updateDate`, `platforms` (`<html>yes</html>`, `<windows>`, `<osx>`, `<linux>`, `<android>`).
* The genre appears in the decorated title. Seen: `Visual Novel, Puzzle, Simulation, Platformer, Shooter, Strategy, Action, Role Playing, Other, Adventure, Rhythm, Fighting, Racing, Educational, Card Game, Interactive Fiction, Sports`.

**Mapping:**
* `source_id` = `data.json.id` (numeric) once enriched, otherwise the `guid` URL.
* `title = plainTitle`; `description` = CDATA text without `<img>`; `developer` = `authors[0].name` (or the subdomain); `thumbnail_url = imageurl`.
* `embed_kind = 'widget'` (`https://itch.io/embed/<id>`) or `'link'` (`guid`).
* `source_categories` = bracketed genre; `tags` = `data.json.tags`.
* `published_at = createDate`, `updated_at = updateDate`.
* `popularity_rank` = position in the "Top" feed. `flags += 'paid'` when `price != $0.00` (link-out only).
* **Enrichment is rate-limited**, so cap it at a few hundred titles a day.

### 4.2 js13kGames, rank 7 (link-out; optional OSS self-host)

* **Listing:** per-year RSS `https://js13kgames.com/<year>/games.xml` for 2012…2026 (RSS 2.0 + `media:` ns).
  * Items: `title`, `link` (`https://js13kgames.com/<year>/games/<slug>`), `guid` (same), `description` (CDATA: `<img src=".c.png">By <author>`), `media:content url="https://play.js13kgames.com/<slug>/.c.png|.c.jpg"`.
  * Per-year counts: 62, 70, 129, 160, 127, 253, 273, 245, 226, 223, 167, 163, 187, 197, 317 → **2,799 total**.
  * **Slugs are globally unique** (2,799 unique; link slug always equals play slug), so `source_id = slug`.
  * Cover images: 800×500 PNG (recent), 400×250 JPEG (2012).
  * The site also preloads a binary-packed `/<year>.js` data file. It is undocumented; do not use it.
* **Embedding is blocked:** `https://play.js13kgames.com/<slug>/` sends `content-security-policy: frame-ancestors 'self' https://js13kgames.com`. The headless test confirmed the block. **Link out to the entry page.**
* **Licensing** (<https://js13kgames.com/2026/rules>, "Copyright ownership"):
  * "Entrants retain ownership of all intellectual and industrial property rights". The licence they grant is to "the Competition Organizer, its subsidiaries, agents and partner companies" only.
  * Rules ask for a "GitHub repository with readable, unmangled source code", and add "please report anyone who distributes your game without your consent".
  * So source on GitHub ≠ permission. In the 100 newest repos of the `js13kGames` GitHub org (2,822 repos), GitHub detected a licence for 22: MIT 17, Apache-2.0 2, ISC 2, GPL-3.0 1. Another 3 were NOASSERTION and **75 had none**.
  * **Self-host only repos with an OSI licence** (≈20–25% → ~600 candidates), and only after checking the asset licences too.
* Categories: none in RSS. Map to `Arcade` by default, or curate by hand.

### 4.3 Y8, rank 9 (manual curation only)

* Each game page has an official **"Add this game to your web page — By embedding the simple code line"** box with `<iframe src="https://y8.com/embed/slope" scrolling="no" style="width: 960px; height: 641px; border: 0; margin: 0; padding: 0;"> </iframe>`.
  * `https://www.y8.com/embed/<slug>` has **no XFO**. Main pages are `X-Frame-Options: SAMEORIGIN`.
  * The headless iframe loaded and nested `storage.y8.com/…` as the game.
* **No catalog feed/API:** `/new/games.rss` → 406, `/rss`, `/feeds`, `/api` → 404. The sitemap (`/sitemaps/y8/en/sitemap{1,2}.xml.gz`) lists ~34,662 `/games/` URLs, but metadata would need page scraping. So: **operator copies the embed snippet per game**. `source_id = slug`; `width/height` come from the snippet.
* ToS <https://www.y8.com/terms> ("Last modified: July, 2022") has no explicit embedding clause. It forbids misuse of Y8 trademarks and logos.

---

## 5. Sources not to use (and why)

| Source | Evidence (2026-11-09) | Decision |
|---|---|---|
| **CrazyGames** | `www.crazygames.com` sends `X-Frame-Options: SAMEORIGIN`; `/embed/moto-x3m` → **HTTP 401** (gated); docs.crazygames.com is developer-only. ToS <https://www.crazygames.com/terms-and-conditions> ("Last updated: April 2026"): §6.2.O "You will not mask your identity in any way, including … IP masking or accessing the Website through **any type of proxy server**"; §6.3.G "You will not conduct any systematic or automated data collection activities (including scraping…)"; §6.3.I "will not use or copy the Platform or the Games, except as expressly permitted". Hotlinking `games.crazygames.com/en_US/<slug>/index.html` (no XFO) would be an unauthorized embed. | Exclude. Only consider with a written partnership. |
| **Poki** | `poki.com` sends `content-security-policy: frame-ancestors https://*.poki.io http://localhost:1234 http://localhost:11001 http://localhost:8080/`. ToU <https://poki.com/en/c/terms-of-use>: "you cannot copy the logo of a game and use it for your own Website"; "will not … use any robot, spider or other automatic device … to access the Website". No publisher program (Poki for Developers is for studios). | Exclude. |
| **Armor Games** | `frame-ancestors 'self'` + XFO SAMEORIGIN. ToS <https://armorgames.com/page/terms-and-conditions> ("last modified on May 15, 2018"): "Unless you have received specific written permission … you may not (a) 'frame' … (c) deep link"; licence "limited to personal and non-commercial uses". `https://armorgames.com/feed` = 10 newest (`armorgames-feed.xml` sample). | Exclude (do not deep-link without permission). |
| **Newgrounds** | `X-Frame-Options: DENY`, `frame-ancestors 'self'`; curl gets 403 and the site serves an argon2id proof-of-work guard (`/_guard/api/v1/challenge`). ToU <https://www.newgrounds.com/wiki/help-information/terms-of-use> §III.A "you will not copy or distribute any part of the Website … without Newgrounds's prior written authorization"; §III.C limits automated access. | Exclude. |
| **Kongregate** | XFO SAMEORIGIN; `robots.txt` has `Disallow: /*.rss` and `Disallow: /games/*/embed`; terms <https://www.kongregate.com/en/pages/terms> ("Last updated: May 21, 2024") ban bots and automation. | Exclude. |
| "Unblocked games" GitHub mirrors | e.g. `HTML5GameArchive/gfiles` ("Where all HTML5 Games are stored", no licence), plus the many similar repos found in the `topic:html5-game` search. | **Never import.** These redistribute copyrighted builds. |

---

## 6. GNOME category mapping

GNOME categories: **Action, Adventure, Arcade, Racing, Sports, Puzzle, Strategy, Multiplayer, Simulation, Idle, Platformer, Casual, Horror, Sandbox.**

Algorithm (`categories` = ordered, max 3, primary first):
1. **Primary** = table lookup on the source's primary category ([§6.1](#61-primary-category-tables)).
2. **Secondary** = keyword rules ([§6.2](#62-keyword-rules-secondary-categories-and-fallbacks)) run over source categories + tags. For Playgama/itch, also run them over genres. Run them over the title only for the "strong" words marked ★. Apply in the priority order given and skip duplicates.
3. If nothing matched → `Casual`.
4. Never expose gendered source categories (`Girls`, `Boys`, `games-for-girls`) as categories. Map them through tags, or to `Casual`.

### 6.1 Primary category tables

**GameDistribution**

| GD | GNOME | GD | GNOME |
|---|---|---|---|
| .IO | Multiplayer | Girls | Casual |
| 3D | *(none; use rules)* | Jigsaw | Puzzle |
| Action | Action | Mahjong & Connect | Puzzle |
| Adventure | Adventure | Match-3 | Puzzle |
| Agility | Arcade | Merge | Puzzle |
| Arcade | Arcade | Puzzle | Puzzle |
| Art | Casual | Quiz | Puzzle |
| Basketball | Sports | Racing | Racing |
| Battle | Action | Racing & Driving | Racing |
| Boardgames | Strategy | Shooter | Action |
| Bubble Shooter | Puzzle | Simulation | Simulation |
| Cards | Casual | Sports | Sports |
| Care | Simulation | Strategy | Strategy |
| Casual | Casual | Cooking | Simulation |
| Dress-up | Casual | Educational | Casual |
| Football | Sports | | |

**GameMonetize** (feed.php labels; rssfeed.php variants in parentheses)

| GM | GNOME | GM | GNOME |
|---|---|---|---|
| Action | Action | Girls | Casual |
| .IO | Multiplayer | Hypercasual | Casual |
| 2 Player | Multiplayer | Multiplayer | Multiplayer |
| 3D | *(rules)* | Puzzle (Puzzles) | Puzzle |
| Adventure | Adventure | Racing | Racing |
| AI | *(rules)* | Shooting | Action |
| Arcade | Arcade | Soccer | Sports |
| Baby Hazel | Casual | Sports | Sports |
| Bejeweled | Puzzle | Stickman (Fighting) | Action |
| Boys | *(rules)* | Clicker | **Idle** |
| Cooking | Simulation | | |

**GamePix** (148 namespaces; groups)

| GNOME | GamePix namespaces |
|---|---|
| Action | action, battle, battle-royale(+Multiplayer), boxing, fighting, first-person-shooter, gangster, gun, knight, ninja, shooter, sniper, stickman, sword, tanks, war, wrestling, naval, police |
| Adventure | adventure, escape, rpg, pirates, dragons, dinosaur |
| Arcade | arcade, classics, retro, flash, ball, snake, worm, spinner, tap, skill, runner, sharks, robots, pixel |
| Racing | racing, car, driving, drifting, bike, dirt-bike, truck, offroad, airplane, helicopter, flight |
| Sports | sports, soccer, basketball, baseball, bowling, cricket, golf, hockey, pool, skateboard, world-cup, archery, horse, fishing, hunting |
| Puzzle | puzzle, 2048, block, brain, bubble-shooter, bejeweled, jewel, jigsaw-puzzles, mahjong, match-3, memory, math, scrabble, word, trivia, tetris, hidden-object, coding |
| Strategy | strategy, chess, checkers, board, city-building(+Simulation), management(+Simulation) |
| Multiplayer | multiplayer, io, two-player, mmorpg(+Adventure) |
| Simulation | simulation, farming, cooking, restaurant, surgery, hair-salon, parking, money |
| Idle | idle, clicker, tycoon |
| Platformer | platformer, jumping, parkour, fire-and-water |
| Casual | casual, hyper-casual, addictive, cool, crazy, fun, family, coloring, drawing, dress-up, fashion, makeup, games-for-girls, educational, card, solitaire, music, piano, cats, animal, anime, christmas, halloween, mobile, gdevelop, vibe-coded |
| Horror | horror, scary, zombie(+Action), monster, granny(★ IP risk) |
| Sandbox | open-world, building, mining, minecraft(★ IP risk) |

**Famobi:** action→Action; puzzle, quiz, match-3, mahjong, bubble-shooter→Puzzle; arcade, skill, breakout→Arcade; racing, cars→Racing; sports→Sports; management, cooking, tamagotchi→Simulation; time-management-and-strategy→Strategy; multiplayer→Multiplayer; jump-and-run→**Platformer**; girls, dress-up, make-up, educational, cards→Casual.

**itch.io genres:** Action, Fighting, Shooter→Action; Adventure, Role Playing, Visual Novel, Interactive Fiction→Adventure; Platformer→Platformer; Puzzle→Puzzle; Racing→Racing; Rhythm→Arcade; Simulation→Simulation; Sports→Sports; Strategy, Card Game→Strategy; Survival→Action (+Horror if tagged); Educational, Other→Casual.

**Playgama:** no single primary field. Run the rules below over `genres[]` and take the first match as primary.

**js13k / Y8 / OSS:** chosen by hand in the curation manifest. Default `Arcade` (js13k) or `Casual`.

### 6.2 Keyword rules (secondary categories and fallbacks)

Tokens are normalized: lowercase, `_`/space→`-`, and a trailing `-games` is dropped (Playgama uses `sandbox-games`, `incremental-games`). Rules are applied in this priority order:

| Priority | GNOME | Tokens (exact token or prefix*) |
|---|---|---|
| 1 | Multiplayer | multiplayer, io, .io, 2-player, two-player, 2players, 2-player-*, pvp, 1v1, co-op, mmo, mmorpg, online, battle-royale, 3-player |
| 2 | Horror | horror, scary, survival-horror, psychological-horror, jump-scare, creepy, backrooms, zombie*, slenderman*, granny* |
| 3 | Idle | idle, clicker, incremental, tycoon, afk, *-clicker |
| 4 | Platformer | platformer, platform, jump-and-run, side-scrolling, parkour, obby, jumping |
| 5 | Sandbox | sandbox, open-world, crafting, building, mining, voxel, ragdoll, physics-sandbox, mineblock, city-building |
| 6 | Racing | racing, race, driving, drift*, car-racing, kart*, moto*, bike*, rally, drag-racing, offroad, truck |
| 7 | Sports | sports, soccer, football, american-football, basketball, baseball, golf, mini-golf, tennis, hockey, pool, billiards, 8-ball-pool, bowling, cricket, volleyball, penalty, goalkeeper, skateboarding, snowboarding, ski |
| 8 | Puzzle | puzzle, match-3, match3, mahjong*, jigsaw, 2048, sudoku, word*, trivia, quiz, brain*, logic, hidden-object, bubble-shooter, sorting, memory, connect, tiles, crossword*, spot-the-difference |
| 9 | Strategy | strategy, tower-defense, defense, rts, tactical, turn-based, turnbased, chess, checkers, board, backgammon, card |
| 10 | Simulation | simulation, simulator, life-simulation, cooking, farm*, restaurant, management, time-management, surgery, doctor, hospital, pet*, tamagotchi, care, flight, parking, business |
| 11 | Adventure | adventure, rpg, action-rpg, escape, point-and-click, story, visual-novel, interactive-fiction, dungeon*, quest*, roguelike* |
| 12 | Action | action, shooter, shooting, fps, third-person-shooter, fighting, battle, war, gun, sniper, ninja, sword, stickman, beat-em-up, combat |
| 13 | Arcade | arcade, retro, classic, snake, breakout, pinball, runner, endless, skill, agility, flappy*, one-button, reaction |
| 14 | Casual | casual, hypercasual, hyper-casual, dress-up, makeup, make-up, coloring, drawing, kids, family, educational, solitaire, art, cozy, relaxing |

---

## 7. How many legitimate games are reachable

| Source | Count on 2026-11-09 | How counted | Embeddable by GNOME? |
|---|---|---|---|
| GameDistribution | 21,847 | binary search, `amount=100` (page 219 = 47) | Yes, iframe |
| GameMonetize | 38,538 | binary search, `num=1000` (page 39 = 538) | Yes, iframe |
| GamePix | 14,788 | `last_page_url` page 617 @24, last page = 4 | Yes, iframe (SID) |
| Playgama | 2,856 | `totalCount` | Yes, iframe (CLID) |
| Famobi | 649 | `num_games` | Yes, iframe (affiliate ≥50k visits/mo) |
| **Subtotal (listings)** | **78,678** | | |
| itch.io (web) | 864,109 results | browse page header | Widget/link; playable = manual |
| js13kGames | 2,799 | RSS 2012–2026 | Link-out; OSS subset self-host |
| Y8 | ~34,662 URLs | sitemap | Manual per-game iframe |
| OSS (GitHub) | 20+ verified (§8.2); 1,139 MIT repos with topic `html5-game` (61 with ≥10★), 2,522 MIT `browser-game` | GitHub search API | Self-host |

**Overlap** (`scripts/overlap.py`; normalized-title match, i.e. lowercase alphanumerics only):

| Sample | n | Also in GD (30,763 sitemap slugs) |
|---|---|---|
| GameMonetize newest 1000 | 998 | 82 (8%) |
| GamePix (pages 1, 60, 120 @96) | 288 | 60 (21%) |
| Playgama top 100 | 100 | 27 (27%) |
| Famobi (full) | 646 | 152 (24%) |

Other pairs: GamePix∩GM-newest-1000 = 15, Playgama∩GM-newest-1000 = 3, Famobi∩GamePix-sample = 1.

Title matching gives false positives on generic names ("Solitaire") and misses renamed games. So **unique embeddable titles are estimated at about 55k–70k**. GD + GamePix + Playgama alone come to about 30–35k. The 10,000 target is well within reach. Curate by quality (GamePix `quality_score`, Playgama ranking, GM `mostplayed`, GNOME play counts) and by compliance filters ([§11](#11-compliance-checklist)).

---

## 8. Embedding verification matrix

### 8.1 Headers and headless iframe test (parent `http://127.0.0.1:8765`, Chromium 156)

| Embed URL tested | XFO | CSP frame-ancestors | Result |
|---|---|---|---|
| `https://html5.gamedistribution.com/021f9b735ab14fdf9604b10aefc188c3/?gd_sdk_referrer_url=…` | – | – | **Loaded** |
| `https://html5.gamemonetize.co/56wzq0cuv3c4ryszun8e7zbi5ryy158o/` | – | – | **Loaded** |
| `https://play.gamepix.com/prism-match-3d/embed?sid=1` | – | – | **Loaded** (ads + iubenda CMP inside) |
| `https://playgama.com/export/game/popping-candies` | – | `*` | **Loaded** |
| `https://play.famobi.com/gun-spin` | – | – | **Loaded** |
| `https://y8.com/embed/slope` → `www.y8.com/embed/slope` | – | – | **Loaded** (inner `storage.y8.com`) |
| `https://itch.io/embed/5188892`, `https://itch.io/embed-upload/20401285` | – | – | header check only (no XFO/CSP) |
| `https://play.js13kgames.com/cat-hop-cloud/` | – | `'self' https://js13kgames.com` | **Blocked** |
| `https://poki.com/en/g/subway-surfers` | – | `https://*.poki.io http://localhost:…` | **Blocked** |
| `https://www.crazygames.com/game/moto-x3m` | SAMEORIGIN | – | **Blocked** |
| `https://armorgames.com/play/19734/super-mirror-wizard` | SAMEORIGIN | `'self'` | **Blocked** |
| `https://www.newgrounds.com/…` | DENY | `'self'` | (403 to curl) |
| `https://www.kongregate.com/…` | SAMEORIGIN | – | not tested in frame |

### 8.2 Verified open-source games (licence file read from `raw.githubusercontent.com/<repo>/HEAD/…`)

All of these can be **self-hosted** (`embed_kind='selfhost'`, served by Axum under `/games/oss/<slug>/` from a pinned build). Show the licence and author, and link to the repo.

| Repo | Licence (file) | Notes |
|---|---|---|
| gabrielecirulli/2048 | MIT (`LICENSE.txt`) | static |
| BKcore/HexGL | MIT (`LICENSE`); README: "code and resources are now licensed under the MIT License" | WebGL racer |
| MaxBittker/sandspiel | MIT | falling-sand **Sandbox**; check that the build is static |
| sharkdp/cube-composer | MIT | puzzle |
| particle-clicker/particle-clicker | MIT | **Idle** |
| IvarK/AntimatterDimensionsSourceCode | MIT | **Idle** |
| Acamaeda/The-Modding-Tree | MIT | idle framework/game |
| jakesgordon/javascript-racer | MIT-style (`LICENSE`) | racing |
| jakesgordon/javascript-breakout | MIT-style | arcade |
| kenrick95/c4 | MIT | Connect Four (2-player) |
| selenebun/bullethell | MIT | arcade/action |
| kbjorklu/chess | MIT | strategy |
| cwtickle/danoniplus | MIT | rhythm (needs chart data) |
| aframevr/a-blast | MIT | WebXR shooter |
| KilledByAPixel/LittleJS | MIT | engine with example games |
| sumn2u/baghchal | BSD-3-Clause | board/strategy |
| doublespeakgames/adarkroom | MPL-2.0 | adventure/idle |
| pmotschmann/Evolve | MPL-2.0 | idle |
| Hextris/hextris | GPL-3.0 | arcade/puzzle (copyleft: publish modified source) |
| ellisonleao/clumsy-bird | GPL-3.0 | Flappy-Bird-style (avoid trade dress) |
| gvtulder/tessel | GPL-3.0 | puzzle |
| mgerhardy/caveexpress | GPL (`LICENSE`) | native-first; web build UNVERIFIED |
| FreezingMoon/AncientBeast | AGPL-3.0 | needs a server → AGPL obligations |
| mozilla/BrowserQuest | MPL-2.0 code; content under a separate licence per `LICENSE` | needs a Node server |
| freeciv/freeciv-web | GPL server / AGPL client | heavy, server needed |

**Do not self-host** (no licence file found, or restricted assets):
* AlexNisnevich/untrusted: no licence file; music includes CC-BY-NC-SA and "used with permission".
* wwwtyro/Astray, end3r/Captain-Rogers, lostdecade/onslaught_arena: no licence found.
* R74nCom/sandboxels: custom "R74n Content License v1.1", review before use.

GitHub search figures (unauthenticated search API, 2026-11-09):
* `topic:html5-game`: 2,994 repos. Of the top 100 by stars: MIT 36, none 24, NOASSERTION 15, GPL-3.0 10.
* `topic:html5-game license:mit`: 1,139 (61 with ≥10★).
* `topic:js13k`: 420 (top 100: none 49, MIT 35).
* `topic:game-off license:mit`: 29.

---

## 9. Importer design notes (Rust/Axum/Tokio/SQLite)

### 9.1 Jobs and cadence

| Source | Request plan | Cadence | Politeness |
|---|---|---|---|
| GameDistribution | `amount=100`, pages 1..until `[]` (~219 req, ~140 KB each). `If-None-Match` per page (304 verified) | daily | 1 req/s; on 5xx back off ×2 |
| GamePix | `pagination=96`, follow `next_url` (~155 req) | daily | 1 req/s |
| Playgama | POST `limit=1000`, `offset=page*1000` (3 req) | daily | 1 req/5 s |
| GameMonetize | `feed.php?format=0&num=1000&page=N` (39 req, ~0.9 MB each) | daily/weekly | **≥10 s between requests**; on HTML body "error code: 1015" sleep 60–120 s |
| Famobi | 1 request | daily | – |
| itch.io | 1–5 RSS pages + `data.json` enrichment for new items only | daily | **≤2 req/min**; on 429 sleep 150 s+ |
| js13k | 15 yearly RSS (only the current year changes) | weekly | – |

* Use `reqwest` with gzip and a clear UA, e.g. `GNOME-catalog/<ver> (+https://<operator-site>)`.
* Store the raw record. Upsert on `(source, source_id)`. Bump `last_seen_at`.
* An item missing from a *complete* sync gets `missing_count += 1`. At 3, set `status='missing'` and hide it. If a network asks for removal, set `removed` (Playgama §3.5; GD §7.6 on termination).
* Treat a sync as complete only if the item count is within ±10% of the previous total. This avoids mass-hiding when a feed returns an error page with HTTP 200.
* Parse XML defensively: itch.io and js13k are RSS 2.0 with CDATA; GameMonetize rssfeed.php XML is `ArrayOfRSSViewModel`.

### 9.2 Embed rendering (Svelte)

```html
<iframe src={embedUrl} title={title} width="100%" style="aspect-ratio: {width}/{height}"
        allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope" allowfullscreen
        loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>
```
* **Do not** set `referrerpolicy="no-referrer"`, and do not wrap embeds in proxy URLs.
* Avoid `sandbox`. If you must use it, include `allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-pointer-lock allow-orientation-lock`. A restrictive sandbox breaks ad click-outs and the SDKs, which counts as "interfering".
* GD: build `embed_url` as `https://html5.gamedistribution.com/<md5>/?gd_sdk_referrer_url=${encodeURIComponent(location.origin + '/games/' + slug)}`.
* **CSP of the GNOME page** (served by Axum). Allow only the top-level embed hosts; nested ad frames are governed by the embed's own document:
  `frame-src 'self' https://html5.gamedistribution.com https://embed.gamedistribution.com https://html5.gamemonetize.co https://play.gamepix.com https://playgama.com https://play.famobi.com https://y8.com https://www.y8.com https://itch.io;`
  `img-src 'self' https://img.gamedistribution.com https://img.gamemonetize.com https://img.gamepix.com https://static.playgama.com https://img.cdn.famobi.com https://img.itch.zone https://play.js13kgames.com https://cdn2.y8.com data:;`
* Serve the games page at the GNOME origin (`/games/<slug>`), outside the Scramjet/UV service-worker scope, and outside any GNOME adblock list.

### 9.3 Deduplication across sources

* Key = normalized title (lowercase, strip non-alphanumerics, drop suffixes like " 2d", " online", " html5"). Add developer when both sides have it (itch, js13k).
* For pairs with low title confidence, compare thumbnail perceptual hashes (64-bit dHash on 128-px downscales).
* Preferred listing on collision: the source with the operator's highest revenue terms and best metadata (default order: Playgama > GamePix > GameDistribution > GameMonetize > Famobi). Other rows get `canonical_id` and stay as fallbacks if the preferred embed disappears.

### 9.4 Text hygiene

* HTML-unescape up to twice (GameMonetize). Strip HTML from itch/js13k CDATA. Trim, and collapse whitespace.
* Drop SEO noise tags (GameMonetize/Playgama): `free games for your site`, `free games for your website`, `best games`, `20xx games`, `unity games`, `html5`, `webgl`, `android`, `mobile`, `crazy-games`, `unblocked`, `*-games-online`, `gam-supported-games`.
* GameDistribution content flags → `flags` (`No Blood`, `Kids Friendly`, `No Cruelty`).

---

## 10. Sample files for importer tests

Directory: `/tmp/claude-1000/-home-duderucool-gnome/f2049012-6316-4b31-bd8a-a00530b243a1/scratchpad/games-samples/`. All files are unmodified responses from 2026-11-09.

| File | Request |
|---|---|
| `gamedistribution.json` | `…/api/v2.0/rss/All/?collection=all&categories=All&tags=All&subType=all&type=all&mobile=all&rewarded=all&amount=10&page=1&format=json` |
| `gamedistribution.xml` | same, `amount=5&format=xml` |
| `gamepix.json` / `gamepix.xml` | `https://feeds.gamepix.com/v2/json?sid=1&pagination=12&page=1` / `…/v2/xml?…` |
| `gamepix-pubdate.json` | `…/v2/json?sid=1&pagination=12&page=1&order=pubdate` |
| `playgama.json` | POST `…/api/v1/partner/export/catalogue/games` body `{"pagination":{"limit":10,"offset":0},"sort":{"type":"ranking_default"},"filters":{…}}` |
| `gamemonetize-feed.json` / `gamemonetize-feed.xml` | `https://gamemonetize.com/feed.php?format=0&num=10&page=1` / `format=1&num=5` |
| `gamemonetize-rssfeed.json` | `https://rss.gamemonetize.com/rssfeed.php?format=json&category=All&type=html5&popularity=newest&company=All&amount=10` (11 items) |
| `gamemonetize-rssfeed.xml` | same, `format=xml&popularity=mostplayed` |
| `famobi.json` | `https://api.famobi.com/feed?n=10` |
| `itch-free-web.xml` | `https://itch.io/games/free/platform-web.xml` |
| `itch-free-web-open-source.xml` | `https://itch.io/games/free/platform-web/tag-open-source.xml` |
| `itch-data.json` | `https://emlise.itch.io/seasonshift/data.json` |
| `js13k-2012.xml` | `https://js13kgames.com/2012/games.xml` (62 items) |
| `armorgames-feed.xml` | `https://armorgames.com/feed` (reference only; source excluded) |
| `github-repo-2048.json` | `https://api.github.com/repos/gabrielecirulli/2048` (shape for the OSS manifest licence check) |

---

## 11. Compliance checklist

1. **Register before enabling a source.** GD needs a publisher account + domain + Tags/ads.txt + Google Ad Manager (§2.3, §2.6). GameMonetize needs the site added in the dashboard. GamePix needs a SID. Playgama needs a CLID (registration approved, §4.1). Famobi needs an affiliate ID (≥50k visits/month). Keep each network's ID in config; leave the source `enabled=false` until set. Serve `/ads.txt` from config (Axum static route) with the lines the networks supply.
2. **Keep ads, SDKs and branding intact.** No ad-blocking, script injection, overlays on the game frame, or removing "more games" links and logos (GD §2.4, §6.2(ii)(b); Playgama §6.1). Exempt the games page from GNOME's own blockers.
3. **Never proxy the embeds.** Load embeds directly; never through Scramjet/UV or a Wisp tunnel. Proxying rewrites game code and replaces origin and referrer (`scramjet/packages/core/src/fetch/util.ts:26`), which both GD and Playgama classify as invalid or fraudulent traffic. Don't set `referrerpolicy=no-referrer` on game iframes.
4. **Content policy versus the proxy feature.** GD §6.2(iii)(c) and Playgama §6.1 bar properties that "contain or promote … illegal activities, including … hacking". CrazyGames bans proxy access outright. Disclose the proxy product when applying, keep "bypass/unblock" marketing off the games pages, or put the games catalog on its own subdomain. Get written confirmation from each network.
5. **No monitoring or benchmarking crawlers.** GD forbids automated availability/performance monitoring without consent. Do not run headless health checks against GD embeds; rely on feed presence and user reports.
6. **Attribution.** Show "via <Network>" and the developer when known (itch, js13k, OSS). Link to `source_url` (Playgama `playgamaGameUrl`, itch `guid`, js13k `link`). For OSS, show the licence name, copyright line and repo link; ship the LICENSE file with the build; for (A)GPL games, also publish any modified source.
7. **Removal sync.** Honour removals within one sync cycle: `missing_count` ≥ 3 → hide; network request → `removed`. On terminating a network relationship, purge all its embeds (GD §7.6).
8. **IP-risk filter.** Distributor catalogs contain brand knock-offs (Playgama interests `minecraft`, `gta`, `mario-games`, `pokemon-games`, `five-nights-at-freddy-games`, `roblox-games`, `sprunki`, `among-us`, `fortnite-ripoff-games`; GamePix categories `mario`, `minecraft`, `skibidi-toilet`, `ninja-turtle`, `granny`; GD tags `pokemon-games`, `harry-potter-games`, `spider-man-games`, …). Flag titles and tags that match a configurable trademark blocklist as `ip_risk` and hide them by default. Apply the same rule to OSS clones (e.g. Pac-Man/Tetris names).
9. **Privacy and kids.** Embeds load Google ads, TCF/GPP locators and CMPs (iubenda in GamePix). GNOME must run its own CMP for EU visitors and pass consent where supported (GD `gdpr-tracking`/`gdpr-targeting`/`gdpr-third-party` on `embed.gamedistribution.com`). Several networks require users to be 13+ (GamePix, CrazyGames, itch). Use GD `Kids Friendly` and the other flags for any kids section.
10. **No native-app or subscription redistribution** (GD §2.1, Playgama §2.1).
11. **Thumbnails.** Hotlink the network CDNs (allowed by the publisher feeds). Locally caching or resizing images is **UNVERIFIED** with respect to each network's terms. Poki explicitly forbids reusing game logos, which is another reason it is excluded.
12. **Do not hotlink asset hosts** (`games.crazygames.com`, `html-classic.itch.zone`, `storage.y8.com`). Use only the official embed endpoints listed above.

---

## 12. Not verified

* **GameDistribution:** meaning of `Status` values (2, 1, 0, 9, 14, 15); whether feed order is newest-first; whether GD blocks embeds on unregistered domains (the SDK reads parent/top domain).
* **GamePix:** publisher dashboard terms and revenue share %; how SID attribution works beyond URL validation.
* **Playgama:** stability of the `widgets.playgama.com/api/v1/partner/export/catalogue/*` API (undocumented; it is what the official catalog UI calls); exact CLID parameter on `gameURL`.
* **GameMonetize:** size and behaviour of `rssfeed.php?amount=All`; how publisher attribution works in embeds.
* **Famobi:** affiliate agreement text; affiliate ID format for new partners; revenue share.
* **itch.io:** maximum RSS page; whether every HTML5 game's Embed dialog offers a playable embed (depends on creator settings).
* **Caching and resizing thumbnails** under each network's terms.
* **Revenue-share percentages** not quoted above are not public.

---

## 13. Reproduction snippets

```bash
# GameDistribution total (binary search lands on page 219 with 47 items)
curl -s "https://catalog.api.gamedistribution.com/api/v2.0/rss/All/?collection=all&categories=All&tags=All&subType=all&type=all&mobile=all&rewarded=all&amount=100&page=219&format=json" | jq length   # 47
# GamePix total pages
curl -s "https://feeds.gamepix.com/v2/json?sid=1&pagination=24&page=1" | jq -r .last_page_url          # ...page=617...
# Playgama total
curl -s -X POST -H 'Content-Type: application/json' https://widgets.playgama.com/api/v1/partner/export/catalogue/games \
  -d '{"pagination":{"limit":1,"offset":0},"sort":{"type":"ranking_default"},"filters":{"ageGroups":[],"interests":[],"platforms":[],"supportedLanguages":[],"hasInAppPurchases":false}}' | jq .totalCount   # 2856
# GameMonetize last page (be gentle: ≥10 s between calls)
curl -s "https://gamemonetize.com/feed.php?format=0&num=1000&page=39" | jq length   # 538
# Famobi
curl -s https://api.famobi.com/feed | jq .num_games   # 649
# Framing headers
curl -sI https://play.js13kgames.com/cat-hop-cloud/ | grep -i content-security   # frame-ancestors 'self' https://js13kgames.com
curl -sI "https://playgama.com/export/game/popping-candies" | grep -i content-security  # frame-ancestors *; ...
```
