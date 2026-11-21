# GNOME Design System — v2 "Grove"

Design v2 (2026-11-12) replaces the warm brass-and-parchment v1. The user asked for GNOME to look and feel like two
reference sites: **novene** (testing.itcode.fyi, a browser-in-a-page proxy) and **ivy** (iv.antitechnocrat.net, a
sign-in card on a dark silk wallpaper). v2 takes their *visual language* — palette, type, spacing, radii, glass,
layout patterns and component anatomy — and builds GNOME's own version of it. **Original work only:** no code, CSS,
images, wallpapers, logos, names or copy from either site; fonts come from `@fontsource` (OFL), icons from Lucide,
images are generated for GNOME (`frontend/public/brand-v2/README.txt`).

What v2 is, in one paragraph: a **browser-first shell** — a thin tab strip and a toolbar with a full-width address
bar across the very top, a slim monochrome icon rail on the left below them, and every GNOME page rendered under
that chrome like a page in a browser. A **near-black neutral base** with **monochrome chrome** (the current item is a
white tint in a rounded square), **glass cards** for dialogs, forms and panels, and **one accent** (mint by default)
for actions, links, focus and progress. **Inter** for the interface, **Montserrat** (bold, tight) for the wordmark
and headings. Home is the new-tab page: a dark atmospheric wallpaper ("Grove"), the white GNOME mark next to a bold
GNOME wordmark, and a rounded translucent search box.

Measured from the references in Chromium (1440×900 and 390×844, `getComputedStyle`), 2026-11-12:

| | novene | ivy |
| --- | --- | --- |
| Base | wallpaper under `linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.72))`; panels `#0e0e0e`; hairlines `#242424` | `#000` + animated dark-green silk |
| Text | `#f5f5f5` / `#ededed`; secondary `#a8a8a8`; dim `#6e6e6e` (icons) | `#fff`; sub `#8c9691`; labels `#c9d1cd` |
| Chrome | tab strip 38px + toolbar 51px, `rgba(8,8,8,.72)` + `blur(12px)`, 1px `#242424` bottom lines; rail 50px | — |
| Controls | nav buttons 28px r7; address bar 34px r8 `#0e0e0e` + 1px `#242424`; focus: border `rgba(237,237,237,.45)` + `0 0 0 3px rgba(237,237,237,.14)` | inputs 48px r13 `#050606` + 1px `rgba(255,255,255,.1)`; focus: border mint .7 + 3px mint .15; keyboard ring 2px mint, offset 4px |
| Selection | rail item 34px r10; active `rgba(237,237,237,.14)` + `inset 0 0 0 1px rgba(237,237,237,.16)`; hover `#0e0e0e` + `#a8a8a8` | checkbox: native, `accent-color` mint |
| Cards | page tiles r16 `rgba(10,16,12,.5)` + 1px `rgba(255,255,255,.09)` + inset top highlight + `blur(16px) saturate(1.3)`; settings nav r14 `#0e0e0e` | card 400px r24 `rgba(10,12,11,.95)`, 1px `rgba(255,255,255,.08)`, `0 24px 80px rgba(0,0,0,.6)`, padding 32/28/26 |
| Type | Inter; page title 22px/600/-0.02em; labels 12.5px/500; subs 11–12.5px; wordmark 46px/700/-0.02em | Montserrat 600–800; h1 26px/800/-0.03em; brand 22px/800/-0.04em; labels 12px/700 |
| Buttons | small outlined/ghost, r7–12 | primary 48px r14 mint `#91efbd` + dark ink + `0 8px 24px` mint glow; secondary white; tertiary outlined r12–13 |
| Motion | 0.18s background/color/border | 0.12–0.16s, `cubic-bezier(.2,.7,.2,1)` |

## 1. Principles
1. **The browser is the frame.** GNOME is a browser in a page: the chrome (tabs, address bar, rail) is always there,
   quiet and thin; pages and sites get the space. Internal pages look like pages a browser shows, not like an admin
   dashboard.
2. **Monochrome chrome, one accent.** Navigation and chrome are greys on near-black; the current item is a white tint
   in a rounded square. The accent marks what you can *do* and what is *happening*: primary buttons, links, focus,
   switches and checkboxes when on, progress, selection. Never decorate with it.
3. **Glass where things float or group.** Floating layers (menus, popovers, toasts, sheets) and cards (dialogs,
   sign-in, panels) are glass: translucent near-black, a hairline, a faint top highlight, a big soft shadow. Static
   lists sit on the page with hairlines.
4. **Bold and tight for titles, calm for text.** Montserrat 800 with negative tracking for the wordmark and page
   titles; Inter for everything you read or operate.
5. **Atmosphere at home, focus elsewhere.** Only Home (and the new-tab page) gets the full wallpaper. Every other page
   is calm near-black so content reads first.
6. **Accessible by default.** WCAG 2.2 AA contrast for all text in both themes (checked by `src/settings/color.test.ts`),
   visible focus (2px `--focus` ring, or the field halo), full keyboard paths, ARIA roles on custom controls, hit targets
   ≥ 32px (≥ 40px on touch), `prefers-reduced-motion` and the animation setting respected everywhere.
7. **Fast is a feature.** No layout shift, skeletons only for slow loads, the wallpaper is ≤ 75 KB and paints its
   average color first, only the selected interface font is downloaded.
8. **Honest controls.** Every control does something real; nothing decorative pretends to be interactive.

## 2. Brand assets
`frontend/public/logo.png` and everything in `frontend/public/brand/` stay byte-for-byte unchanged (v1 assets; the
original logo is still shown on About). New assets live in **`frontend/public/brand-v2/`** (provenance:
`brand-v2/README.txt`, original work, AGPL-3.0-only like GNOME):

| File | Use |
| --- | --- |
| `gnome-mark-mono.svg` | **The v2 mark.** One path, `fill="currentColor"`, viewBox `0 0 382 499` (same frame as `brand/gnome-mark.png`). Derived from the transparent cutout: smoothed silhouette + cuts for the hat brim, the nose, the beard line and the mushroom cap. Use it inline or as a CSS mask so it takes `color` (white on dark, ink on light). |
| `gnome-mark-mono-white-{48,96,192,384}.{webp,png}` | Raster mark in `#f5f5f5` (dark theme) for `<img>` use |
| `gnome-mark-mono-ink-{48,96,192,384}.{webp,png}` | Raster mark in `#111111` (light theme) |
| `favicon.svg`, `favicon.ico`, `favicon-32.png`, `favicon-64.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | App icons: white mark on a `#0a0a0a` tile (maskable keeps the 80% safe zone) |
| `wallpaper/grove-{dark,light}.{avif,webp}` | The default Home wallpaper "Grove" (2560×1440; 21–32 KB each): a moonlit spruce clearing in the mist, and the same scene at a misty dawn for the light theme. Registry: `src/styles/wallpapers.ts` |

- **Logo component** (components builder): switch `Logo.svelte` to the mono mark — render the SVG with
  `color: var(--text)` (inline SVG or `mask: url(/brand-v2/gnome-mark-mono.svg) center / contain no-repeat` on a
  `background: currentColor` box with the 382:499 ratio); keep the `size`, `wordmark`, `decorative`, `priority` props
  and the accessible name. Add `variant?: 'mono' | 'color'` (default `'mono'`); `'color'` keeps today's cutout for
  About's "original logo" placement.
- **Favicons / PWA** (shell builder, `index.html` + `public/manifest.webmanifest`): point the favicon links and the
  manifest icons at `/brand-v2/…`, `theme_color`/`background_color` `#0a0a0a`.
- **Wordmark:** typographic, never an image: **GNOME** in Montserrat 800, `letter-spacing: -0.02em`, `line-height: 1`.
  Next to the mark (novene pattern: mark left of the word, one row): the mark is about 1.5× the wordmark's cap height
  (52px next to a 48px wordmark; the hat makes it tall and narrow), bottom-aligned with the baseline, gap 0.3× the
  wordmark size.
- Never recolor the mark with gradients or the accent; never put it on a busy area without enough contrast.

## 3. Color
All colors are CSS custom properties on `:root` (`src/styles/tokens.css`), overridden inline by the settings engine
(`src/settings/apply.ts`: accent derivatives, custom colors). Dark is the default. Components use tokens only.

### Dark (default)
| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0a0a0a` | App and page background |
| `--bg-elevated` | `#0e0e0e` | Chrome base (tab strip, toolbar, rail) under glass |
| `--surface-1` | `#131313` | Cards on pages, the address bar, raised controls, hovered rows |
| `--surface-2` | `#191919` | Menus, popovers, dialogs (base of `--glass-bg*`) |
| `--surface-3` | `#232323` | Pressed / selected opaque fills |
| `--hairline` | `rgba(255,255,255,.08)` | 1px borders, dividers, card borders |
| `--hairline-strong` | `rgba(255,255,255,.14)` | Floating-layer borders, field borders on chrome |
| `--text` | `#f5f5f5` | Primary text, active chrome icons |
| `--text-2` | `#ababab` | Secondary text, idle chrome labels |
| `--text-3` | `#8f8f8f` | Tertiary: hints, placeholders, eyebrows, idle chrome icons (≥ 4.5:1 up to `--surface-3`) |
| `--accent` | `#9ff0c8` | Mint: primary fills, links, switch/checkbox on, progress |
| `--accent-strong` | `#c2f8dd` | Hover of accent fills; accent text on `--accent-soft` |
| `--accent-ink` | `#03170d` | Text/icons on accent fills (14.6:1) |
| `--accent-soft` | `rgba(159,240,200,.14)` | Selected chips, text selection, soft highlights |
| `--focus` | `#c2f8dd` | 2px focus ring |
| `--focus-border` / `--focus-halo` | accent 70% / accent 16% (color-mix) | Field focus: border + `0 0 0 3px` halo |
| `--selected` / `--selected-ring` | `rgba(255,255,255,.10)` / `.14` | Current item in monochrome chrome: fill + `inset 0 0 0 1px` ring. Secondary lines on it use `--text-2` |
| `--hover` / `--press` | `rgba(255,255,255,.05)` / `.08` | Hover and pressed tints |
| `--field-bg` / `--field-border` / `--field-border-hover` | `#070707` / `rgba(255,255,255,.10)` / `.18` | Inputs inside cards and dialogs (ivy wells) |
| `--moss` `--slate` | `#b3cf8a` `#a4b4f2` | Secondary tones (tags, engine badges, info) |
| `--success` `--warning` `--danger` | `#7fe0a6` `#f2c46b` `#ff8a78` | State; each has a `-soft` tint at .14; `--danger-ink #1f0603` |
| `--scrim` | `rgba(0,0,0,.62)` | Behind dialogs and sheets |

### Light (same family)
Paper-white neutrals with the same structure; the accent turns into deep jade so it can be text.

| Token | Value | Token | Value |
| --- | --- | --- | --- |
| `--bg` | `#f4f4f4` | `--text` | `#111111` |
| `--bg-elevated` | `#fafafa` | `--text-2` | `#4d4d4d` |
| `--surface-1` | `#fbfbfb` | `--text-3` | `#666666` |
| `--surface-2` | `#ffffff` | `--accent` / `--accent-strong` | `#0b7a4e` / `#086640` |
| `--surface-3` | `#e8e8e8` | `--accent-ink` | `#f4fff9` |
| `--hairline` / `-strong` | `rgba(0,0,0,.08)` / `.14` | `--focus` | `#0b7a4e` |
| `--selected` / `-ring` | `rgba(0,0,0,.06)` / `.10` | `--field-bg` / `-border` | `#ffffff` / `rgba(0,0,0,.14)` |
| `--moss` `--slate` | `#4c6a1f` `#3f4fa3` | `--success` `--warning` `--danger` | `#16733f` `#8a5a00` `#b3261e` |

Contrast is enforced by `src/settings/color.test.ts`: every text token ≥ 4.5:1 on `--bg`, `--bg-elevated`,
`--surface-1`, `--surface-2`, on hovered rows and (`--text`, `--text-2`) on `--selected`; tone text on its own tint;
inks on their fills; focus and tones ≥ 3:1 as UI. **Text on the wallpaper** must sit on a glass panel or on the
hero's own dimmed area (§9.3); never put `--text-3` straight on the picture.

### Accent presets (Settings → Appearance → Accent color; `appearance.accentPreset`)
| Preset | Dark | Light | |
| --- | --- | --- | --- |
| `mint` (default) | `#9ff0c8` | `#0b7a4e` | ivy-like mint; hand-tuned tokens in tokens.css |
| `periwinkle` | `#9fb5f6` | `#3555c4` | novene-like periwinkle |
| `wheat` | `#e3c58d` | `#7d5f22` | v1 earth tones, re-tuned for the neutral base ↓ |
| `moss` | `#b7cb8c` | `#4f6324` | |
| `lichen` | `#d0da9f` | derived | |
| `ember` | `#f2a272` | derived | |
| `slate` | `#aab4d1` | `#4d5876` | |
| `mushroom` | `#dcbbb4` | derived | |
| `fern` | `#86caa7` | derived | |
| `custom` | any hex (`appearance.accent`) | derived | |

Presets other than mint, and custom accents, get `--accent`, `--accent-strong`, `--accent-soft`, `--accent-ink`,
`--focus` from `deriveAccent()` (OKLCH, hue kept, lightness moved until 4.5:1 on `--bg`, `--bg-elevated` and
`--surface-2`). Everything derived from the accent in CSS uses `color-mix()` on `var(--accent)` so it follows.

## 4. Typography
| Role | Face | Notes |
| --- | --- | --- |
| Interface (default) | **Inter Variable** (`@fontsource-variable/inter` 5.3.0) | `--font-ui`; user-selectable (below) |
| Display: wordmark, page titles, section and card titles, dialog titles | **Montserrat Variable** (`@fontsource-variable/montserrat` **5.3.0**, exact pin) | `--font-display`, whatever the interface font |
| Mono: URLs in details, diagnostics, keyboard hints | Geist Mono Variable | `--font-mono` |

`appearance.fontFamily` (interface font): **`inter`** (default) · `montserrat` (new: the ivy look everywhere) ·
`geist` · `system` · `atkinson` · `fraunces` (serif) · `mono` (`src/styles/fonts.ts` `UI_FONTS`, which the font
picker lists in this order). Self-hosted woff2, latin + latin-ext, `font-display: swap`, lazy.

Scale (base `--font-size`, default 14px; `rem` relative to it): `--text-xs 11` · `--text-sm 12` · `--text-md 14` ·
`--text-lg 16` · `--text-xl 20` · `--text-2xl 26` · `--text-3xl 36` · `--text-4xl 48`.

| Role | Spec |
| --- | --- |
| Wordmark (Home hero) | Montserrat `--weight-wordmark` 800, clamp(2.6rem, 4.6vw, 3.43rem) (≈ 48px), `--tracking-wordmark` -0.02em, `--text` |
| Page title (PageHeader h1) | Montserrat 800, `--text-2xl` (26px), `--tracking-display` -0.03em, line-height 1.15 |
| Card / dialog title | Montserrat 800, 22–24px, -0.03em (ivy "Welcome back") |
| Section title (h2) | Montserrat `--weight-heading` 700, `--text-lg`–`--text-xl`, `--tracking-heading` -0.02em (base.css applies this to bare `h1`/`h2` via `:where()`) |
| Eyebrow / group label | Inter 600, `--text-xs` (11px), 0.08em, uppercase, `--text-3` (novene settings group titles) |
| Body / control label | Inter 400 / 500, `--text-md` (14px); chrome labels and dense rows 13px (0.9286rem) |
| Description / hint | Inter 400, `--text-sm` (12px), `--text-3` |
| Field label | Inter 600, `--text-sm`, `--text-2` (ivy's bold small labels) |
| Button | Inter 600 (primary 700), 13–14px |
| Numbers | `font-variant-numeric: tabular-nums` |

Utilities: `.display`, `.wordmark`, `.eyebrow` (`src/styles/utilities.css`).

## 5. Space, density, radius, elevation
- Spacing (4px grid): `--space-1 4` · `2 8` · `3 12` · `4 16` · `5 20` · `6 24` · `8 32` · `10 40` · `12 48` · `16 64`.
- Density `--density` (`appearance.density`): compact 0.85 · comfortable 1 · spacious 1.15. Controls:
  `--control-h` 34px · `--control-h-sm` 28px · `--control-h-lg` 44px · `--item-h` 32px (menu rows) · `--row-h` 38px
  (list rows) · `--control-px` 13px — all × density; on touch every one is ≥ 40px (44 for lg/rows).
- **Radius** — base `--radius` = `appearance.radius` (0–16, **default 10**):

  | Token | Default | Use |
  | --- | --- | --- |
  | `--radius-sm` = max(2px, r − 4) | 6px | Kbd, checkboxes, tags, small chips, tab close buttons |
  | `--radius` | 10px | Buttons, fields, the address bar, rail items, menu items, list rows on hover |
  | `--radius-lg` = r + 4 | 14px | Menus, popovers, toasts, settings navigation card, primary buttons in cards |
  | `--radius-xl` = r × 1.6 | 16px | Page cards and tiles (games, panels) |
  | `--radius-2xl` = r × 2.4 | 24px | Dialogs, sign-in / account / access-code cards, error and engine cards |
  | `--radius-pill` | 999px | Home search box, switches, chips, badges |

- **Elevation** (dark values; light ones in tokens.css): `--shadow-raise` (page tiles), `--shadow-pop` (menus,
  popovers), `--shadow-card` (`0 24px 80px rgba(0,0,0,.6)` + top highlight: cards, dialogs), `--shadow-sheet`,
  `--shadow-accent` (`0 8px 24px` accent 18%: primary buttons). Flat mode (`performance.gpuEffects` off) turns them
  into hairline rings.

## 6. Glass & blur
| Token | Value (defaults) | Use |
| --- | --- | --- |
| `--glass-opacity` | **0.82** (`appearance.transparency`, 0.55–1) | the one knob |
| `--blur` | **16px** (`appearance.blur`, 0–40) | the other knob |
| `--chrome-bg` | `--bg-elevated` at (opacity − 0.10) ≈ 72% | Tab strip, toolbar, rail, bookmarks bar, mobile bottom bar (novene `rgba(8,8,8,.72)`) |
| `--chrome-filter` | `blur(blur × .75) saturate(1.2)` ≈ 12px | with `--chrome-bg` |
| `--glass-bg` | `--surface-2` at opacity | Popovers, toasts, sheets |
| `--glass-bg-dense` | `--surface-2` at opacity + .14 | Menus, listboxes, command palette, tooltips (legible without blur) |
| `--glass-bg-card` | `--surface-1` at opacity + .12 ≈ 94% | Cards (ivy `rgba(10,12,11,.95)`) |
| `--glass-filter` | `blur(blur) saturate(1.3)` | with the three above |
| `--glass-inset` | `inset 0 1px 0 var(--glass-highlight)` | the faint top highlight on glass |

Recipes: `.glass` (floating layer), `.glass-card` (card: `--glass-bg-card`, hairline border, `--radius-2xl`,
`--shadow-card`), `.glass-chrome` (window chrome). "Reduce transparency", blur 0, GPU effects off or no
`backdrop-filter` support switch all of them to opaque surfaces (tokens.css).

## 7. Motion
Unchanged from v1 (the references sit in the same range): `--dur-1 90ms` (hover/press) · `--dur-2 160ms` (menus,
toggles, focus halo) · `--dur-3 240ms` (panels, route change) · `--dur-4 360ms` (sheets, hero). `--ease-out
cubic-bezier(.2,.8,.2,1)` for nearly everything; `--ease-spring` only for small affordances. Every duration is
`calc(var(--dur-n) * var(--motion))` (`--t-1…4`); `--motion-move` is 0 for reduced/none (fades only); `--press-scale`
(0.98, or 1 without movement) for the pressed state of buttons. Hover and focus changes are color/background/border
transitions only. Tab switches are instant; the route cross-fade stays (≤ 6px rise).

## 8. Iconography
Lucide (`@lucide/svelte`, ISC), stroke **1.75** (`--icon-stroke`), `currentColor`, sizes: 15–16px in the toolbar and
tab strip, 17–18px in the rail, 16px in menus and buttons, 20px in the mobile bottom bar. Monochrome only: idle
`--text-3`, hover `--text-2`, active `--text`; the accent only inside accent-colored controls. Rail set (novene uses
the same metaphors): Home `house`, Browser `globe`, Games `gamepad-2`, Extensions `puzzle`, VPN `shield`, History
`history`, Bookmarks `bookmark`, Downloads `download`, Settings `settings`, About `info`, search `search`. No emoji,
no sparkles.

## 9. Layout

### 9.1 Shell anatomy (desktop and tablet, ≥ 760px)
```
┌────────────────────────────────────────────────────────────────────────────────┐
│ [mark] [tab][tab][tab] [+]                                   (VPN chip)       │ tab strip   38px  --tabstrip-h
├────────────────────────────────────────────────────────────────────────────────┤
│ ← → ⟳ ⌂  [◍ address bar ………………………………………………… ☆ SJ] [⬇] [⋮] (avatar)        │ toolbar     50px  --toolbar-h
├────────────────────────────────────────────────────────────────────────────────┤
│ (bookmarks bar, optional)                                                      │ bookmarks   32px  --bookmarks-h
├──┬─────────────────────────────────────────────────────────────────────────────┤
│⌂ │                                                                             │
│◎ │  stage: the browser view (proxied page / new-tab page) or the routed page   │
│🎮│                                                                             │
│… │                                                                             │
│⚙ │                                                                             │
└──┴─────────────────────────────────────────────────────────────────────────────┘
  rail 52px (--rail-w-compact) below the toolbar; 212px when expanded; right side with sidebarPosition 'right'
```
- **The chrome is global.** Tab strip, toolbar and bookmarks bar render on every route (Home, Browser, Games,
  Extensions, VPN, History, Bookmarks, Downloads, Settings, About, not-found), not only on `/browse`. They are glass
  (`--chrome-bg` + `--chrome-filter`) with 1px `--hairline` bottom borders; the rail has a 1px inner-edge hairline.
- Internal routes stay routes (ARCHITECTURE §5.1); they are not turned into tabs. The tab strip always shows the
  browser's tabs; on another route the browser's active tab is drawn "selected but not in view" (underline at 40%,
  title `--text-2`) and clicking any tab opens the browser view with it. The address bar shows the route as
  `gnome://<page>[/<section>]` with the mono mark as its site icon.
- Settings mapping (no setting is dropped; all keep working):
  - `appearance.sidebar` — `compact` (**default**): the slim icon rail, labels in tooltips. `expanded`: the same rail
    at 212px with labels (re-mapped: v1's wide sidebar with brand header becomes a labelled version of the slim rail).
    `auto`: compact on the browser and below 1100px, expanded elsewhere (unchanged meaning). `hidden`: no rail; an
    8px edge strip or the sidebar shortcut reveals it as a floating glass panel (`--radius-xl`, `--shadow-pop`).
  - `appearance.sidebarPosition` — rail on the left (default) or right, always below the toolbar.
  - `appearance.toolbar` — `full`: back, forward, reload/stop, home, address bar (with star, engine badge, pop-up
    indicator), downloads, menu, account. `compact`: back, forward, reload, address bar, menu.
  - `appearance.tabStrip` — `top`: always; `hidden-when-single`: hidden while ≤ 1 tab (the mark moves to the toolbar's
    left end).
  - `appearance.showBookmarksBar` — the 32px bar under the toolbar on every route.
- Fullscreen (browser): chrome and rail hide; a 6px strip at the top edge reveals the chrome as an overlay.

### 9.2 Mobile (< 760px)
Thumb-first adaptation of the same structure: one **toolbar** row at the top (`--toolbar-h`: back · address bar · tab
count · menu; Forward and Reload/Stop are the first rows of that menu), the **bottom bar** (58px + safe area, glass chrome, 4 destinations + More; current item = `--selected` tile
behind the icon, label `--text`), no rail, no tab strip (the tab count opens the tab switcher sheet). Pages use
16–20px side padding; cards go full-width; dialogs become bottom sheets only where they already are.

### 9.3 Home = the new-tab page
Rendered for `/` and for a browser tab without an address (`browser.newTab: 'home'`).
- **Backdrop** (`appearance.homeBackground`): kind `wallpaper` (**default**, value `grove`) shows the Grove picture
  for the current theme, `object-fit: cover`, `object-position` from the registry, average color painted first.
  It should fill the window **behind the chrome** too (the glass chrome lets the night glow through, novene-style);
  at minimum it fills the stage. `glow` (a soft accent glow at the top), `none`, `color`, `gradient`, `image`
  (with dim and blur) keep working.
- **Hero**, centered horizontally, its center at ~40% of the stage height: the mono mark (52px tall, `--text`) and the
  wordmark (≈48px) on one row, gap 14px; 22px below, the **search box**: `min(560px, 100%)` × 48px, `--radius-pill`,
  `color-mix(in oklab, var(--bg) 62%, transparent)` + `backdrop-filter: blur(14px)`, 1px `--hairline-strong`,
  leading search icon 16px `--text-3`, placeholder "Search or enter an address", the Alt+L hint at the end in `--text-3`;
  focus: `--focus-border` + 3px `--focus-halo`.
- **Quick links / Recent / Favorites stay, but quiet**: quick links as one row of 44px glass tiles
  (`--glass-bg-card`, `--radius-lg`) with 12px labels in `--text-2`, 28px under the search box; Recent and Favorites
  in two glass panels (`--glass-bg-card`, `--radius-xl`, padding 16px, eyebrow title, ≤ 5 rows of 40px) at the bottom
  of the first screen or just below it. Empty states are one line of `--text-2` inside the panel.
- Bottom-right: a small outlined glass pill **"Customize"** (`image` icon, 13px/600, `--text-2`) that opens
  Settings → Appearance → Home background — a real shortcut, novene's pill position.
- Light theme: `grove-light`, text in `--text`; everything else identical.

### 9.4 Pages under the chrome
Content column `--page-max` 1200px (Games) / `--page-max-narrow` 960px (Settings, History, Bookmarks, Downloads,
Extensions, VPN, About), `--page-pad-x` sides, 32px top. Page header: Montserrat 800 26px title + one 13px `--text-3`
line (novene "pick something to play"), left-aligned, optional actions right. Content groups in glass cards
(`--glass-bg-card`, 1px `--hairline`, `--radius-xl`, `--glass-inset`) or directly on the page with hairlines for long
lists. Page background: plain `--bg` (no wallpaper).

## 10. Component spec — owner: **components** (`src/components/**`, `frontend/dev/**`)
Every component keeps its props, events, ARIA and keyboard behaviour; this is a restyle onto the v2 tokens. Gallery
(`dev/gallery.html`) and `scripts/qa-components.mjs` must keep passing.

| Component | Anatomy and states (tokens) |
| --- | --- |
| **Button** | Heights sm 28 · md 34 · lg 44 (cards: lg); radius `--radius` (lg: `--radius-lg`); Inter 600 13–14px. **primary**: `--accent` fill, `--accent-ink` text, `--shadow-accent`; hover `--accent-strong`; pressed `scale(var(--press-scale))`. **secondary**: `--surface-1` fill + 1px `--hairline-strong`, `--text`; hover `--surface-2`/`--field-border-hover`. **ghost**: transparent, `--text-2`; hover `--hover` + `--text`. **danger**: `--danger` fill + `--danger-ink`. New **`variant="inverse"`** (ivy's white button: `#fff` fill, `#111` text in dark; `#111` fill, `#fff` in light) and **`variant="outline"`** (transparent, 1px `--hairline-strong`, `--text-2`, hover `--hover`; ivy tertiary). Loading keeps width; disabled 40% opacity. Focus: 2px `--focus` ring, offset 3px. |
| **IconButton** | 28px (toolbar/tab strip: `--control-h-sm`) or 34px square, radius `--radius-sm`+1 (7px) in chrome / `--radius` elsewhere; icon 15–17px `--text-3`; hover `--hover` + `--text`; `pressed` → `--selected` + ring; disabled 35%. Tooltip on hover/focus after 400ms. |
| **Input / Textarea / SearchInput** | On pages and chrome: `--surface-1` fill, 1px `--hairline-strong`, `--radius`, `--control-h`, 14px. In cards/dialogs (`size="lg"` or a `well` prop): ivy well — 44–48px, `--field-bg`, `--field-border`, `--radius` + 3 (13px), 15px/500. Hover `--field-border-hover`. Focus: `--focus-border` + `0 0 0 3px var(--focus-halo)` (no outline ring on fields). Placeholder `--text-3`. Error: `--danger` border + halo `--danger-soft`, message 12px `--danger`. |
| **Field** | Label Inter 600 12px `--text-2` (6px above), help 12px `--text-3`, error 12px `--danger`; optional end-aligned link in the label row (ivy "Forgot password?"). |
| **Select / Combobox** | Trigger like Input (+ chevron `--text-3`; Select has Input's `sm`/`md`/`lg` sizes, `lg` = the 44px card field); listbox = Menu surface, at least as wide as the field and never wider than the window (long titles and URLs truncate). |
| **Checkbox** | 17px box, `--radius-sm` (5–6px), 1.5px `--control-edge` (local: `--text-3` at 75%, ≥ 3:1 on every surface for WCAG 1.4.11; hover `--text-3`); checked: `--accent` fill + `--accent-ink` check (ivy). Label 13px/500 `--text-2`. |
| **RadioGroup** | Same as Checkbox, round. |
| **Switch** | 40×24 pill (novene 44×24). Off: `--field-bg` + 1px `--field-border`, knob 18px `--text-3`. On: `--accent` track, knob `--accent-ink` (dark knob on mint 14:1 in dark, light knob on jade 5:1 in light; a white knob on mint would vanish). 160ms knob slide (none without movement). |
| **SegmentedControl** | Track `--surface-1` + 1px `--hairline`, `--radius`; selected segment `--selected` + ring, `--text`; others `--text-2`. |
| **Slider** | Track 4px `--surface-3`, filled part `--accent`, thumb 16px white (dark) / `--accent` (light) with `--shadow-raise`; value bubble = Tooltip. |
| **ColorPicker** | Swatches 26px round with 2px `--bg` gap ring; selected: 2px `--text` ring + check in ink (`#111` or `#fff`, whichever contrasts more with the swatch; same for the pipette); presets in the §3 order, one row on phones (6px gap ≤ 480px, hit areas stay 40px). |
| **Menu / MenuList / ContextMenu** | `--glass-bg-dense` + `--glass-filter`, 1px `--hairline-strong`, `--radius-lg`, `--shadow-pop`, padding 6px; items `--item-h`, `--radius` (inset 6px), 13px; hover/active `--hover`→`--selected`; shortcuts `--text-3` mono 11px; separators 1px `--hairline` with 6px margin; danger items `--danger`. |
| **Popover** | `--glass-bg` + filter, `--radius-lg`, `--shadow-pop`, padding 14px. |
| **Tooltip** | `--glass-bg-dense`, `--radius-sm`+2 (8px), 12px/500 `--text`, padding 5px 9px, `--shadow-pop`; kbd hint inside in `--text-3`. |
| **Dialog / ConfirmDialog** | **ivy card**: `--glass-bg-card` + filter, 1px `--hairline`, `--radius-2xl`, `--shadow-card`, padding 32px 28px 26px (mobile 24px 20px), width 400px (sm) / 520px (md) / 720px (lg). Title Montserrat 800 22–24px −0.03em; description 13px/500 `--text-3`; actions full-width stacked in sm cards (primary on top, 44px) or right-aligned in md/lg. Close button: IconButton top-right. Scrim `--scrim` + 4px blur. Access-code prompt and quick-link dialog use this. Built: in `sm` cards a plain two-button footer (Cancel + confirm) becomes two equal 44px buttons, `--radius-lg`, with a ghost Cancel drawn as the outlined tertiary button (DOM order = visual order = tab order); other footers stay right-aligned. |
| **Sheet** | Side/bottom glass (`--glass-bg`), `--radius-2xl` on the open edge, grab handle 36×4 `--hairline-strong`. |
| **Toast** | `--glass-bg` + filter, `--radius-lg`, `--shadow-pop`, 13px; tone icon in tone color; actions as ghost/outline buttons. Built: dense glass (`--glass-bg-dense`, AA over any page or picture), the tone icon in a 28px tile on its `-soft` tint, actions 28px: the first (the toast's own offer: Undo, Retry, Reload) on `--accent` + ink, the rest outlined. |
| **Tabs (in-page)** | Text tabs 13px/500 `--text-2`, selected `--text` + 2px `--text` underline (monochrome). |
| **Chip / Tag / Badge** | Pills; neutral `--surface-1` + hairline `--text-2`; tone variants on their `-soft` tint; Badge counts 11px/700 on `--accent` + ink. |
| **Kbd** | `--surface-1`, 1px `--hairline-strong`, `--radius-sm`, Geist Mono 11px `--text-2`. |
| **ProgressBar / Spinner / Skeleton** | Accent bar 2px (route + page loads, indeterminate shimmer); spinner stroke `--text-2` (accent inside accent buttons); skeleton `--skeleton-*`. |
| **ListRow** | `--row-h`, `--radius` on hover (`--hover`), title 13–14px/500, detail 12px `--text-3`, trailing meta tabular. |
| **SettingRow** | novene settings row: optional 30px icon tile (`--selected` + ring, `--radius`, icon 15px `--text`), label 13px/500 `--text`, description 12px `--text-3`, control right, 1px `--hairline` between rows, reset-to-default ghost button. Built: the tile is the optional `icon` prop (a Lucide icon; additive, no existing call site changes). |
| **PageHeader / SectionHeader** | §4 roles; SectionHeader = eyebrow style or Montserrat 700 h2 (`level` prop). |
| **EmptyState** | Mono mark (48px, `--text-3` at 60%) or icon, title Montserrat 700 18px, one line `--text-3`, one action. |
| **Logo** | §2: mono mark by default, `variant="color"` for the original cutout; `wordmark` per §2. |
| **VirtualList / VirtualGrid / ScrollArea / Divider / Icon** | Tokens only (scrollbar thumb `--scrollbar-thumb`, dividers `--hairline`, icon stroke 1.75). |

## 11. Shell spec — owner: **shell** (`src/app/**`, `src/browser/ui/**`, `src/pages/browser/**`, `src/pages/home/**`, plus `index.html` favicon links and `public/manifest.webmanifest`)
1. **Global chrome.** Move `TabStrip`, `Toolbar` and `BookmarksBar` out of `BrowserView` into a shell-level chrome
   (e.g. `app/Chrome.svelte`) rendered above the rail and stage on every route (§9.1). The chrome starts the browser
   model (`startBrowser()`), but the engine iframe must stay lazy (created when a proxied tab needs it, ARCHITECTURE
   §5.1); `BrowserView` keeps the content area (engine slot, new-tab page, error overlay, engine state, find bar,
   notices) and the fullscreen behaviour. Grid: rows `tabstrip toolbar bookmarks stage`, columns `rail stage`.
2. **Tab strip** (38px, `--chrome-bg`): left end the mono mark (24px, link to Home, 38px square, tooltip "Home");
   tabs `flex: 0 1 200px`, min 96px, 37px tall, no backgrounds; favicon/spinner 14px, title 12px/500 (`--text-sm`),
   close × 13px in a 20px `--radius-sm` button (visible on hover/active/touch); idle title `--text-3`, hover `--text-2` +
   `--hover`, active `--text` + 2px `--text` underline inset 10px (40% when another route is shown); 1px × 14px
   `--hairline` separators between idle tabs; pinned tabs 40px icon-only; drop indicator 2px `--accent`; new-tab `+`
   28px IconButton. Right end: the VPN chip (`getStatus('vpn')`: 8px tone dot + "VPN · <location>" 12px `--text-2`,
   link to `/vpn`) when the status exists. Keyboard, drag, middle-click and context menus unchanged.
3. **Toolbar** (50px, `--chrome-bg`, padding 0 8px, gap 6px): nav IconButtons 28px (`--radius-sm`+1, icon 15px, idle
   `--text-3`, disabled 35%); **address bar** flex 1, 34px, `--radius`, `--surface-1`, 1px `--hairline`, 13px text;
   site icon 14px at the start (a globe for every web page whatever its scheme, the mono mark for `gnome://`, the
   search icon when empty or focused; **never a padlock or an open-lock warning**: the address bar is not a security
   indicator, ENGINE-PROTOCOL §1.2 rule 3); star, engine badge (SJ/UV mini chip) and pop-up indicator inside its end; focus = field focus
   (§10 Input). Suggestions dropdown = Menu surface, full address-bar width, 8px below. Right: downloads (+ badge),
   menu, and the **account avatar** (28px circle, `--surface-3`, initial in 12px/700, or a `circle-user` icon "Sign
   in"; only on servers with accounts; opens Settings → Account & sync). On internal routes Back/Forward go through the
   app's history (expose `canGoBack/canGoForward` from the router's entry index), Reload re-mounts the page, and
   Enter opens what was typed in a new browser tab. Loading: 2px `--accent` bar on the toolbar's bottom edge.
4. **Rail** (52px, `--chrome-bg`, below the toolbar): top the search / command-palette button, then the main
   clusters with 12px gaps (no separator lines), bottom Settings, About and the collapse toggle; items 34px square
   (`--rail-item`), `--radius`, gap 5px, padding 11px top/bottom; idle `--text-3`, hover `--hover` + `--text-2`,
   current `--selected` + `inset 0 0 0 1px var(--selected-ring)` + `--text` (no accent indicator); tooltips on the
   outer side with the shortcut. Expanded: 212px, rows 36px with icon + 13px/500 label, same states. The account
   entry moves to the toolbar avatar; the VPN status moves to the tab strip chip. Context menu (mode, position) stays.
5. **Mobile** (§9.2): toolbar + bottom bar restyled as glass chrome; `MoreSheet`/`TabSwitcher` as glass sheets.
6. **Home** (§9.3): `HomePage`, `HomeSearch`, `QuickLinks`, `SiteList`, `HomeBackground` (already renders the
   `wallpaper` kind; extend it behind the chrome; the scrollbar gutter must not show a `--bg` strip over the
   picture), the "Customize" pill, the mono mark via the new Logo.
7. **Browser overlays**: ErrorOverlay and EngineState as ivy cards (`.glass-card`, max 440px, centered); FindBar as a
   floating glass pill under the toolbar's right end; DownloadsPanel, EngineBadge and PopupIndicator popovers on the
   dense glass surface; Notices as toasts; CommandPalette as a dense glass card (`--radius-xl`, 640px, search field
   48px on top).
8. Keep every e2e expectation of `tests/e2e/engine/suites/shell-*.mjs` and `library-*.mjs` (update selectors only when
   the DOM legitimately moves; prefer roles and labels) in Chromium and Firefox, plus `frontend/scripts/visual-qa.mjs`.

## 12. Pages spec — owner: **pages** (`src/pages/{settings,about,history,bookmarks,downloads,extensions,games,vpn,notfound}/**`)
Common: §9.4 header and column, glass cards, eyebrows, 13px body, AA on every surface.

| Page | Spec |
| --- | --- |
| **Settings** | novene settings layout: left **navigation card** (240px, `--surface-1`, 1px `--hairline`, `--radius-lg`, `--shadow-raise`, padding 12px; "Settings" Montserrat 700 16px header; the search field 34px on top; items 36px, `--radius`, icon 16px + 13px label `--text-2`; current `--selected` + ring + `--text`), sticky under the chrome. Right: groups with eyebrow titles (13px icon `--text-3` + 11px/600 uppercase), rows per **SettingRow** (§10) inside a glass card per group. Appearance: accent swatches in §3 order (in the light theme show each preset's effective light value — `ACCENT_PRESETS[id].light`, or `accentTokens()` for derived ones — and its contrast; today the picker shows the dark value and reports "1.2:1 · adjusted" for mint on the light page); the font picker lists `UI_FONTS`; the Home background editor lists Wallpaper · Glow · Plain · Color · Gradient · Image (dim/blur only for color, gradient, image). Mobile: the navigation becomes a sections list (`/settings`) and a horizontal scroller of pills above each section; the page starts 20px under the chrome (other pages 40px), like a native settings list. Sections whose feature this build does not ship (VPN, Games, Extensions) keep their header and show an empty state that says so. Account & sync (`AccountPanel`) uses the **ivy sign-in card** (below). |
| **Sign-in / account card** | 400px, `.glass-card` (24px radius, padding 32/28/26): brand row (mono mark 36–40px + "GNOME" Montserrat 800 22px −0.04em), title Montserrat 800 26px −0.03em ("Sign in" / "Create an account" / signed-in name), 13px/500 `--text-3` subtitle, ivy-well fields (48px), password field with a show/hide IconButton inside (built: the 28px `size="sm"` button, its hit area padded to the touch minimum by IconButton), "Remember…"-style checkboxes if any, **primary** full-width 48px `--radius-lg` button, an "or" divider (12px/600 `--text-3` between 1px `--hairline` lines) where two ways exist, outline tertiary buttons (44px) for secondary paths, the switch line ("No account? Create one") in 13px with an accent link. Errors as Field errors + a danger toast for server errors. |
| **History / Bookmarks / Downloads** | Header + a toolbar row (filter SearchInput 38px glass, actions as secondary/outline buttons, "Clear" as danger-ghost); lists in one glass card with hairline rows (`ListRow`), sticky day headers as eyebrows; empty state centered in the card. History's selection bar ("n selected" · Cancel · Remove, dense glass) covers the toolbar row while visits are selected and sticks under the chrome; it never pushes the list down (that moved the rows under the pointer between two checkbox clicks). Dialogs (bookmark edit, import, clear data) per §10 Dialog. |
| **Games** | novene launcher: search + category Select in one row (38px glass fields, `--radius-lg`), a count in `--text-3`; grid of 185px square glass tiles (`--radius-xl`, 1px `--hairline`, `--glass-inset`, hover lift `translateY(-2px)` × `--motion-move` + `--hairline-strong`), thumbnail 96px `--radius-xl`+2, title 12.5px/500; list view = ListRow. Detail and Play pages: glass card with the embed, actions in the header. |
| **Extensions** | One glass card per built-in extension: icon tile, name 14px/600, description, Switch on the right; per-site rules and filter lists as SettingRow lists. |
| **VPN** | Status hero card (location, tone dot, exit check result, the "only traffic inside GNOME is routed" note), locations as a selectable list (current = `--selected` + ring), kill switch / verify rows as SettingRows. |
| **About** | Hero card: mono mark 64px + wordmark + version; "Original logo" shows `logo.png` via `Logo variant="color"`; sections (how it works, privacy, engines, shortcuts, diagnostics, licenses, source) as glass cards with eyebrow titles; license list rows hairline-separated. The license data (`licenses.ts`) already credits Montserrat; keep `licenses.test.ts` green. |
| **Not found** | Centered ivy card (400px): mono mark 40px, "Page not found" Montserrat 800 24px, the path in Geist Mono 12px, primary "Go home" + outline "Open the browser". |

## 13. Voice & copy
Short, plain, honest, sentence case, no exclamation marks, no hype. Privacy scope stays explicit ("Routes pages
opened in GNOME through the selected gateway. Other apps on your device are not affected."). novene's lowercase
labels are not copied: GNOME keeps sentence case.

## 14. Do / don't
- **Do**: thin glass chrome, monochrome icons, white-tint current items, one accent, Montserrat 800 titles with tight
  tracking, ivy cards for anything that asks the user for input, hairline-separated lists, generous spacing in cards.
- **Don't**: accent-colored navigation, colored icon sets, glowing borders, gradients on text, the wallpaper behind
  dense pages, `--text-3` directly on pictures, emoji, sparkle iconography, stock illustrations, copying either
  reference's assets or copy.

## 15. Settings and migration (foundation, done)
`src/settings/{schema,defaults,validate,apply}.ts`, ARCHITECTURE §5.3. Settings are stored whole, so the v2 defaults
come with **settings version 2** and a migration (`migrateDesignV2`): appearance values that still equal their v1
default move to v2 — accent `wheat` → `mint` (and the custom-accent default hex), font `geist` → `inter`, glass
opacity 0.78 → 0.82, blur 18 → 16, radius 6 → 10, sidebar `auto` → `compact`, backdrop `glow` → `wallpaper`/`grove`
(dim and blur kept) — and every value a user changed stays. New values: `accentPreset` `mint` · `periwinkle`;
`fontFamily` `montserrat`; `homeBackground.kind` `wallpaper` (value = wallpaper id, unknown ids show Grove).

## 16. Builder work orders
Three builders work in parallel on disjoint files; tokens, fonts, settings and brand assets are done (foundation,
`ui:direction`). Each builder: restyle with tokens only, keep every feature, route, page and setting working, keep
`cd frontend && npm run check && npm test` green after every increment, and re-run the e2e suites that look at their
UI in Chromium and Firefox (`E2E_PORT_BASE=<your range> node tests/e2e/engine/run.mjs --only shell-ui,shell-settings,shell-browse,shell-input,shell-activation,shell-capabilities,shell-sw-update,library-pages,library-visits,library-sync,library-upgrade,library-perf`
— `--only` takes exact names; `*-lib` files (e.g. `library-seed-lib`) are helpers — then `tests/e2e/settings/*.mjs`,
`tests/e2e/about/about-qa.mjs`, `frontend/scripts/visual-qa.mjs`; set `GNOME_QA_OUT` to a scratch directory until the
restyle is final) — update selectors when the DOM legitimately
changes, never weaken an assertion, prefer roles/labels. Need a token that does not exist? Ask the owner of
`src/styles/**` instead of hard-coding a value.

| Builder | Files | Delivers |
| --- | --- | --- |
| **shell** | `src/app/**`, `src/browser/ui/**`, `src/pages/browser/**`, `src/pages/home/**`, `index.html` (favicon links only), `public/manifest.webmanifest` | §9 and §11 |
| **components** | `src/components/**`, `frontend/dev/**`, `frontend/scripts/qa-components.mjs` | §10 (Logo first: the shell and pages use it) |
| **pages** | `src/pages/{settings,about,history,bookmarks,downloads,extensions,games,vpn,notfound}/**`, plus the presentational `src/library/ui/{SiteTile,Notice}.svelte` that only those pages use (not the stores) | §12 |

Leftover v1 values the builders replace: the earth-tone monogram tints in `src/pages/home/Monogram.svelte` (shell) and
`src/library/ui/SiteTile.svelte` (pages) → neutral `--surface-3` tiles with `--text-2` letters, or the v2 presets;
`ColorPicker`'s default `#d6b47a` and its "Use a hex color like #d6b47a." hint → `#9ff0c8` (components; then update
`scripts/qa-components.mjs`, which waits for that hint); `dev/Gallery.svelte`'s initial wheat accent and
`contrastAgainst="#0f0f0d"` → mint and `#0a0a0a` (components). Known a11y findings on `/browse` from
`scripts/visual-qa.mjs` (axe; markup in `TabStrip.svelte` / `Toolbar.svelte`, which the foundation did not touch): the tab close button is a focusable control inside
`role="tab"` (nested-interactive) and the mobile tab-count button's name "Tabs (n open)" does not contain its visible
text "n" (label-content-name-mismatch) — fix them in the tab strip / toolbar restyle (shell). The `browse` and `focus`
scenarios of `visual-qa.mjs` still expect the pre-Wave-B stub browser (`.queue` list, an `h1` "Browser") and fail
since the real browser landed; the shell builder updates them to the real view (roles/labels).

**QA baseline at handover (2026-11-12, after the foundation; Chromium + Firefox; historical):** `npm run check` clean,
`npm test` 885 passed; e2e shell + library suites 356 passed, the only failures being `shell-settings` "WebRTC: blocked
by default, allowed after the switch" (the engine-host realm, `src/engine-host/webrtc.ts`, was being edited by the
engine-host reviewer during the run; the app-side snapshot does not involve appearance) and `library-seed`, which is a
helper and not a suite; `settings-qa` and `settings-features-qa` pass in both browsers (the server needs
`GNOME_ALLOW_CUSTOM_WISP=1` for the custom-Wisp step and `GNOME_VPN_PROFILES` for the VPN rows); `about-qa` fails only
its two pre-Wave-B checks ("engines are not listed", "shortcut reference lists working shortcuts only": the browser now
registers, so engines and tab shortcuts are listed; pages builder: update them to the shipped feature set);
`visual-qa` fails only on `/browse` (the stale `browse`/`focus` scenarios, the two axe findings above, and Firefox's
engine console warnings about unsupported `allow` feature names). Running `visual-qa` against the Vite dev server
needs the server's `GNOME_PUBLIC_ORIGINS` set to the dev origin alone (with two app origins listed, the engine host
posted its messages to the other origin than the page that embedded it, both ways round)
and, while other agents run Vite/Vitest, a private Vite `cacheDir` (otherwise "504 Outdated Optimize Dep").

**QA baseline after the restyle (2026-11-18, final gate `ui:final`, production build served by gnome-server with
accounts, VPN profiles and custom Wisp enabled; Chromium + Firefox):**
- `npm run check`: 0 errors, 0 warnings (5000 files). `npm test`: 67 files, 897/897.
- Production build: startup (index.html scripts + modulepreloads, the measure of the 106.6 KB figure before the
  restyle) **138.9 KB gzip JS** in 27 files (379.2 KB raw), plus 15.3 KB gzip CSS in 6 files; 154.2 KB JS + CSS.
- e2e shell + library suites (`engine/run.mjs --only shell-ui,shell-settings,shell-browse,shell-input,shell-activation,shell-capabilities,shell-sw-update,library-pages,library-visits,library-sync,library-upgrade,library-perf`):
  Chromium 179/180, Firefox 174/178. The only steady failure in both is `shell-settings` "WebRTC: blocked by default,
  allowed after the switch" (`typeof RTCPeerConnection` stays `undefined` after `privacy.webrtc = allow`: engine host,
  `src/engine-host/webrtc.ts`, not UI). Firefox's other three (`shell-capabilities` clear site data,
  `shell-sw-update` reload applies the update, `library-pages` "select two visits") passed 37/37 on a re-run of those
  suites; the last one was a real UI defect (the selection bar pushed the rows 62px down under the pointer), fixed in
  `HistoryPage.svelte`, after which `shell-ui` + `library-pages` + `library-visits` pass in both browsers.
- `settings-qa`, `settings-features-qa` (Vite dev server proxying to the stack), `about-qa` (and `GNOME_QA_EXPECT=offline`
  against a static server without `/api`): all checks pass in both browsers.
- `visual-qa` on the production build: Chromium all checks pass; Firefox fails only on `/browse`, with engine output
  (`Feature Policy: Skipping unsupported feature name "clipboard-write"/"autoplay"` for the engine iframes' `allow`
  list, `Ignoring unsupported entryTypes: longtask`, `Layout was forced before the page was fully loaded` from
  `/engine/`, and on phones Scramjet's `console.error` "unrewriteurl: unexpected url …/engine/"); none comes from the
  UI. Re-run 2026-11-19 (integration part 2): the longtask and `unrewriteurl` lines are gone (engine-host fixes);
  `visual-qa.mjs` now counts the remaining two Firefox warnings (`BENIGN_WARNINGS`: the app engine iframe's
  `autoplay`/`clipboard-write`, which Chromium enforces, and "Layout was forced…" from proxy-origin documents) instead
  of failing on them, so both browsers pass; any other warning still fails. Component QA on the dev server (`GNOME_QA_ONLY=components,keyboard,touch,virtualgrid,motion,layoutshift,a11y,homedata,idb`,
  `scripts/qa-components.mjs`): all checks pass in both browsers (axe WCAG 2.2 AA: no violations); VirtualGrid 10,000
  cards p95 16.8 ms per frame. The leftovers listed above (nested-interactive tab close, tab-count label, stale
  `browse`/`focus` scenarios, about-qa's pre-Wave-B checks) are done.
- Screenshots: `docs/screenshots/{foundation,settings,about,library}` are the v2 look from these runs (the v1-only
  `foundation/browse-queue-*` stub scenario was removed). Headless Chromium starts its virtual pointer at (0,0), over
  the tab strip's Home mark: `visual-qa.mjs` parks it mid-stage after each load so no stray tooltip is captured.

Shared edits made by the foundation outside its own files (functional wiring only, for the builders to restyle):
`src/pages/home/{background.ts,HomeBackground.svelte,home.test.ts}` (the `wallpaper` kind),
`src/pages/settings/{sections/Appearance.svelte,registry.ts}` (fonts from `UI_FONTS`, theme colors from
`THEME_COLORS`, the Wallpaper kind, new keywords), `src/pages/about/{licenses.ts,licenses.test.ts}` (Montserrat credit,
font roles), `index.html` (boot fallback colors `#0a0a0a`/`#f4f4f4`).

## 17. History
- **v1 (2026-11-09 … 11-12)**: warm near-black + brass/wheat accent, cream text, Fraunces display + Geist UI, 6px
  radius, a labelled sidebar with the brand header, a "lantern glow" Home. Its contrast work (every text token on
  every surface, hovered rows, tone tints) carried over into v2's tests.
- **v2 (2026-11-12)**: this document. Built by the shell, components and pages builders, reviewed per area, and
  passed the final gate on 2026-11-18 (QA baseline in §16).
