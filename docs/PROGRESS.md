# GNOME — Progress Checklist

Legend: `[x]` done & verified · `[~]` in progress · `[ ]` not started · `[!]` blocked / needs decision

Last updated: 2026-11-20 (session 7)

## Phase 1 — Research & architecture
- [x] Inspect existing project (only `logo.png` — a 392×510 JPEG named `.png`)
- [x] Toolchain check (node 26, npm 12, cargo/rustc 1.99, gcc/clang/cmake, docker, sqlite3, Playwright browsers cached)
- [x] Clone reference repos (Scramjet, Ultraviolet, HolyWisp, Sapphire, Mullvad)
- [x] License survey (see `docs/research/` and `docs/LICENSES.md` once written)
- [x] Brand assets derived from `logo.png` (original untouched): transparent cutout, favicons, PWA icons → `frontend/public/brand/`
- [x] Deep research reports → `docs/research/*.md` (7 reports)
- [x] End-to-end compatibility spikes: UV + HolyWisp verified (research); **two-origin engine host** spike done 2026-11-11
      (Scramjet + UV over real HolyWisp, Chromium 156 + Firefox 157, two verified runs + an adversarial review:
      `docs/research/spike-engine-host.md`, harness `tests/e2e/spike-engine-host/`); its `/wisp/` is a stub that mirrors
      the Rust gateway, so the run against gnome-server belongs to the Wave A2 integration step
- [x] Architecture document → `docs/ARCHITECTURE.md` (v0.3: origins/tickets §4.6, engines §5.4, extensions §5.5, games §6, VPN §7)
- [x] API contract → `docs/API.md`
- [x] Design system spec → `docs/DESIGN.md`
- [x] Implementation plan & ownership map (below)

## Phase 2 — Core application
- [x] Repository scaffold — Cargo workspace (backend, `crates/catalog`, `crates/net`) and frontend Vite + Svelte 5 + TS
      (`npm run check`, `npm test`, `npm run build` pass 2026-11-11); `deployment/`, `scripts/`, `bench/` come with Wave D
- [x] Design system (tokens, typography, components, icons, motion) — foundation finished 2026-11-10 (240 unit tests; visual QA Chromium + Firefox); independent review done 2026-11-11
- [x] App shell, navigation, page transitions (reviewed 2026-11-11)
- [x] Persistent settings store (local-first + optional account sync) + Settings/About pages — 2026-11-11: every
      `schema.ts` key has a working control, account sync with a per-key three-way merge, About; reviewed (Playwright QA in
      Chromium + Firefox against a real gnome-server). Rows of features this build lacks stay hidden until those features
      register: `browser` registers since Wave B step 2; `extensions`, `vpn` and `games` rows are still hidden
- [x] Rust backend core (config, SQLite, sessions/auth, rate limiting, security headers, static serving, health, admin listener) — 2026-11-10: finished + independent review (17 fixes incl. a login-backoff race)
- [x] gnome-net SSRF-safe client, Wisp gateway (zero-copy splice), VPN gateway profiles, filter-list service — 2026-11-11:
      built + independently reviewed, with two origins and Wisp tickets (1 h TTL, `?t=<ticket>&/`, 401/426 ticket probe) and
      `RLIMIT_NOFILE` raised at startup; `cargo test --workspace`: 407 passed. The full VPN chain with a real Mullvad tunnel
      was not run (it needs an operator account)

## Phase 3 — Proxy
- [x] Scramjet integration (primary) — Wave B step 2, integration part 2 gate 2026-11-19 (`wb2p2:gate`): full e2e run in
      Chromium + Firefox 1010 pass / 17 expected limits / 6 flakes passing on re-run; real browsing 88/88
- [x] HolyWisp integration (primary Wisp server) + Rust WebSocket gateway — `services/holywisp/` packaged 2026-11-10 (pinned e0a0f15, static amd64/arm64, reproducible, 16/16 upstream tests, 87/87 egress smoke); gateway done 2026-11-11 (Origin, ticket, caps, splice relay; the
      `#[ignore]`d real-HolyWisp test `holywisp_e2e` passed by hand with the debug and release builds)
- [x] Ultraviolet integration (fallback) + engine manager (controlled fallback, manual selection) — the init-failed switch is
      proven (host-fallback); the switch notice in the UI has no test yet
- [x] Transport abstraction (libcurl / epoxy; configurable Wisp endpoints; reconnection) — custom routes test-socketed and
      failing over (part 2); open: an intermittent libcurl 'code 35 SSL connect error' in Firefox × Scramjet e2e runs only
- [x] Real website navigation tested end-to-end — through GNOME's own UI, both engines × both browsers (part 2: shell lane
      20 checks × 4, gate 22 × 4); GitHub's deferred page fragments never fill (Wave E site compatibility)

## Phase 4 — Browser
- [x] Tabs, toolbar, omnibox, loading indicators, fullscreen, shortcuts, context menus — Save link/image works since part 2;
      every §7 browser-gated setting checked through the UI (c4.mjs)
- [x] History, bookmarks, downloads, session restoration — part 2 gate: library suites pass in both browsers
- [ ] Extension architecture + built-ins (ad blocker, tracker blocker, privacy, cookie manager, cosmetic filtering)

## Phase 5 — VPN
- [~] Browser-compatible VPN (proxy traffic via authorized egress gateways) — server side done 2026-11-11
      (`GNOME_VPN_PROFILES`, `/wisp/p/<id>/`, health probes, `/api/vpn/locations`, `services/vpn/` recipes checked
      statically); the exit check through the location's path and the kill switch come with the VPN page (Wave C)
- [x] ~~Native companion~~ — dropped: GNOME is a website only (user direction, 2026-11-09)
- [ ] VPN page + settings

## Phase 6 — Games
- [~] Catalog DB + importer (legitimate feeds only) + search (FTS5) + pagination — `gnome-catalog` built 2026-11-10: live GamePix import 14,865 games (199 s, ~11 MiB peak), 244 ip_risk hidden, queries < 1 ms; reviewed 2026-11-11 (re-check: 14,929 games, 315 ip_risk); server routes/jobs/thumbnails/OSS fetch in Wave C
- [ ] Games page (search, categories, trending, new, popular, featured, favorites, recent)
- [ ] Player (official embeds, fullscreen, optional proxied mode)

## Phase 7 — Rust optimization & benchmarks
- [ ] Node.js baseline for hot paths + wisp-js baseline
- [ ] Benchmarks (throughput, latency, RSS, startup) → `docs/BENCHMARKS.md`
- [ ] Profile-guided optimizations; release profile (LTO, strip, codegen-units=1)

## Phase 8 — Security & production
- [~] Unit/integration/e2e tests — 2026-11-18: `cargo test --workspace` 431 passed (2 real-HolyWisp tests are `#[ignore]`d
      and pass by hand), frontend 897 unit tests, the Wave B e2e runner (154 rows on the integration run) and the
      Playwright harnesses (engine-host spike, Settings, About, visual QA, component QA)
- [ ] Dependency audits (cargo audit/deny, npm audit)
- [~] SSRF / origin / rate-limit / admin-exposure tests — backend tests cover gnome-net's IP policy (incl. DNS-rebinding
      decoys), per-role route tables, CSRF/Origin, rate limits and admin isolation; the spike's adversarial review attacked
      both origins from a proxied page
- [ ] Production build pipeline (minify, tree-shake, precompress, image optimization, no public source maps, opt-in obfuscation of GNOME-owned code only)
- [ ] Deployment (Docker, compose, systemd, Caddy, Raspberry Pi 4 notes)

## Phase 9 — Delivery
- [~] README, setup, dev/prod commands, deployment guide, env var reference, architecture explanation — root
      `README.md` written and verified 2026-11-18 (workflow `wf_b4427f98-2f1`); each wave keeps it current; the
      deployment guide follows Wave D

## ▶ RESUME HERE (session 7, 2026-11-20 — Wave B step 3 resumed: x4 builder, lane reviews, integration, gate)

- **Session 7 (2026-11-20 15:00, session `644420fb-ffdf-4b95-9476-f363487a0e45`)** picks up after the 5-hour limit cut off
  `wf_93c6a14d-9c1` on 2026-11-19 at 12:39 (lane x4's builder and the reviewers of x1, x2, x3 and x5 mid-work; the builders
  of x1, x2, x3 and x5 had returned reports, now in session 6's `handoff/reports/b3-x{1,2,3,5}.json`). The machine has
  rebooted since (no orphaned servers; the /tmp scratch is gone). Tree at 15:04: `npm run check` 0 errors, `npm test`
  1370/1370. Found while resuming: every e2e runner build logs "127 build-check problem(s)", because
  `tests/e2e/engine/lib/build.mjs` checks the engine-host graph without the step-3 import rules (only the `build` suite
  passes `STEP3_ENGINE_ALLOWED`); handed to x1's reviewer.
  - **Running: `wf_a58961ae-b46`** (script `.../644420fb-ffdf-4b95-9476-f363487a0e45/workflows/scripts/gnome-wave-b3-resume-s7-wf_a58961ae-b46.js`):
    successors `b3-x4` (13000-13999) ∥ `b3-x1-review` (10000-) ∥ `b3-x2-review` (11000-) ∥ `b3-x3-review` (12000-) ∥
    `b3-x5-review` (14000-) → `b3-x4-review` → `b3-integrate` (15000-; adds the cross-lane items: x3's SameSite glue with
    the contract field `inits`, the CORS decision from x1's measurements, the engine iframe showing through GNOME pages,
    About's limitations, x2's root/body `:style()` deviation) → `b3-review-security` (16000-) ∥ `b3-review-completeness`
    (16500-) → `b3-fix` → `b3-gate`. It keeps using session 6's handoff kit (progress logs, scripts, reports). Condensed
    transcripts of the cut-off agents are in `handoff/resume/cutoff-s6-<label>.md`. The watcher
    `handoff/scripts/watch_s7.py <run>` saves each result to `handoff/reports/<label>.json`. If the limit cuts it off
    within this session, the engine re-runs the steps. In a new session, write a continuation from this run's journal
    (`.../644420fb-ffdf-4b95-9476-f363487a0e45/subagents/workflows/wf_a58961ae-b46/journal.jsonl`).

- **Session 6 (2026-11-18, session `866c4dff-b2bd-46bf-a890-aabadc4f11c5`)** picks up after the weekly usage limit, which
  cut off every agent of both session-5 workflows on 2026-11-12 at 16:23 (no step returned a report). The machine
  rebooted since: every `/tmp` scratch dir (old stack scripts, old screenshots, the reference shots) is gone and no
  orphaned dev servers are left (the port lists below are history). Tree at 19:37: `npm run check` 0 errors, `npm test`
  886/886. Handoff kit (reboot-safe): `~/.claude/projects/-home-duderucool-gnome/866c4dff-b2bd-46bf-a890-aabadc4f11c5/handoff/`
  — `ref/shots/` (reference screenshots re-taken 2026-11-18), `resume/cutoff-s5-<label>.md` (condensed session-5
  transcripts), `progress/<label>.md` (agents append; the session-5 logs were copied in), `reports/` (step results as
  JSON), `scripts/` (condense.py, agents_live.py).
  - **UI restyle: DONE (2026-11-18 23:30, `ui:final` pass_after_fixes).** Every route matches the novene/ivy direction in
    dark + light, desktop + phone; 143 final screenshots in `handoff/shots-ui-final/`; docs/screenshots refreshed;
    DESIGN.md updated (globe, never a padlock, in the address bar — ENGINE-PROTOCOL §1.2 rule 3; QA baseline §16).
    Gates: check 0, npm test 897/897; shell+library e2e Chromium 179/180, Firefox 174/178 (re-runs pass; the steady
    failure is the engine-host WebRTC row, part 2 item A1); settings/about/component QA pass in both browsers; startup
    JS 138.9 KB gzip (+30 % over the 106.6 KB pre-restyle baseline; Wave D budget item).
  - 2026-11-19 00:30: the 5-hour usage limit cut off the Wave C plan reviewers and the Wave D planner; the workflow
    engine re-ran all three after the reset.
  - **Workflow 1 (`wf_81397cb2-88b`, launched 2026-11-18 19:50, script `.../866c4dff-b2bd-46bf-a890-aabadc4f11c5/workflows/scripts/gnome-s6-ui-finish-and-b2-part1-wf_81397cb2-88b.js`):** UI restyle finish — three area finishers (`ui:finish-shell` 36000-36999, `ui:finish-components`
    37000-37999, `ui:finish-pages` 38000-38999; each finishes both of its area's session-5 builders) → one fixing
    reviewer per area as soon as its finisher ends (`ui:review-shell` 39000-, `ui:review-components` 39500-,
    `ui:review-pages` 40000-) → `ui:final` (40500-40999; screenshots copied to `handoff/shots-ui-final/`). Beside it,
    Wave B step 2 integration part 1 (unchanged scope, see the session-5 bullet): `wb2:contract-backend` (41000-41499)
    ∥ `wb2:docs` → `wb2:verify-part1` (41500-41999).
  - **Workflow R (`wf_b4427f98-2f1`, 2026-11-18, user request "also make a readme.md on how to start it with every
    feature"):** root `README.md` — three surveyors (backend/CLI/config, true feature status, dev + tests) → `readme:write`
    → `readme:verify-run` (a new operator follows it literally, ports 46000-46499, cargo in `~/.cache/gnome-targets/readme`)
    ∥ `readme:verify-audit` (every claim against the code) → `readme:fix` (46700-46999). **Done** (651 lines; operator run
    in both browsers + audit, 20 corrections applied; reports `handoff/reports/readme-*.json`). Product bugs it found
    (DuckDuckGo `/undefined` under Scramjet; hard reload is a plain reload) are in `handoff/part2-worklist.md`.
  - **Part 1: done** (`wb2:docs`, `wb2:contract-backend`, `wb2:verify-part1` all pass_after_fixes; reports in
    `handoff/reports/wb2-*.json`). Gates on its final tree: check 0, npm test 897/897, clippy clean, cargo test 431 pass /
    2 ignored (2/2 by hand), runner 154 pass / 0 fail, backend-proxy standalone 131/0, backend-https 22/22. New: three
    proxy CSP functions in the contract with a shared fixture both the vitest and `csp.rs` compare against;
    `SwClient.post`; 'ready' = built and nothing known wrong; late first hello connects (client.ts change is part 2);
    account-sync per-kind try; runner `standalone = true` hook. **Part 2's work list:** `handoff/part2-worklist.md`.
    Left for part 2 from `wb2:docs`:
    an e2e row for the init-failed engine switch (corrupted `scramjet.wasm`, one `tab.engineSwitched{reason:'init-failed'}`
    per tab) so §6.2 can be marked proven; the About "known limitations" texts in that report's
    `interfaces_for_other_teams` (replace two `LIMITS` entries in `pages/about/EngineSection.svelte`, add six); the
    `uv-doc-hook.js` header; rerun every suite in both browsers and downgrade any `[proven]` marker whose row fails.
  - **Wave C plan (`wf_4a9d97f8-ce3`, launched 2026-11-18 ~21:20, doc-only):** `wave-c:plan` writes `docs/WAVE-C.md`
    (games backend: catalog in gnome-server, routes, jobs, thumbnails, CSP from embed hosts, OSS on the proxy origin;
    games UI + player; VPN page + settings + exit check + the stranded kill switch; e2e fixtures) → security/compliance
    ∥ completeness reviews (report only) → `wave-c:plan-fix`. It must say which lanes may run beside Wave B step 3.
  - **Wave D plan (`wf_78772cfc-501`, launched 2026-11-18 ~21:50, doc-only):** `wave-d:plan` writes `docs/WAVE-D.md`
    (benchmarks vs Node/wisp-js baselines → docs/BENCHMARKS.md; production build pipeline; deployment: Docker, compose,
    Caddy, systemd, Raspberry Pi notes; dependency audits; the deferred hardening items) → security/operations ∥
    completeness reviews → `wave-d:plan-fix`. It must say which lanes may run beside Wave B step 3 and Wave C.
  - **2026-11-19 ~13:30 usage limit reached during step 3:** builders x1, x2, x3, x5 had returned reports (x4 still running;
    reviewers of x2/x3/x5 running). Open cross-lane items: x3's SameSite glue for sw.ts/tabs.ts
    (`handoff/progress/b3-x3-scripts/sw-samesite-glue.txt`), x2's CS10 under UV (nested UV documents get no onDocument),
    x3's K12/P7 under UV (x1's SW context). Within this session the workflow engine re-runs cut-off steps after the
    reset; otherwise resume from the journal of `wf_93c6a14d-9c1` (reports in its journal.jsonl).
  - **Wave B step 3 (`wf_93c6a14d-9c1`, launched 2026-11-19 ~11:40):** lanes `b3-x1` (10000-10999), `b3-x2` (11000-),
    `b3-x3` (12000-), `b3-x4` (13000-), `b3-x5` (14000-) per docs/WAVE-B3.md, each followed by `<lane>-review` →
    `b3-integrate` (15000-; §13 item 8, the §12.4 matrix, docs + README) → `b3-review-security` (16000-) ∥
    `b3-review-completeness` (16500-) → `b3-fix` → `b3-gate`. Added to the plan: x3 enforces SameSite where UV does not
    (step-2 security finding 1); x1 investigates CORS emulation in the SW. Cargo target `~/.cache/gnome-targets/b3`
    (never `cargo test --release` there); e2e outputs `~/.cache/gnome-e2e-b3-*`. LANDED lines: `handoff/progress/b3-x1.md`,
    `b3-x5.md`. After step 3: Wave C (all lanes) with Wave D's a-parts, run one wave at a time (quota-bound).
  - **Wave B step 2: DONE (2026-11-19 ~11:30, `wb2p2:gate` pass).** npm test 951/951, cargo test 432 (+2 ignored passing),
    full e2e 1010 pass, real browsing 88/88, all QA scripts pass; README status rows updated. Open (owners): cross-site
    isolation between proxied sites (UV ignores SameSite, no CORS) → step 3 lane x3; intermittent Firefox × Scramjet
    libcurl SSL error (upstream, cause unknown); SW update apply may need a second reload; GitHub fragments → Wave E.
    Reports: `handoff/reports/wb2p2-*.json`.
  - **Integration part 2 (`wf_bf8ebfba-3f0`, launched 2026-11-19 00:40):** `wb2p2:engine` (worklist A, ports
    23000-23999) ∥ `wb2p2:shell` (worklist B + real browsing through the UI, 24000-24999) → `wb2p2:review-security`
    (25000-) ∥ `wb2p2:review-quality` (25500-) → `wb2p2:fix` (26000-) → `wb2p2:gate` (27000-; every suite in both
    browsers, docs + README truthful). Server binary `~/.cache/gnome-targets/wb2p2`; e2e outputs under
    `~/.cache/gnome-e2e-wb2p2-*`. Ports now stay below 32768 (Linux's outgoing range starts there).
  - **2026-11-19 ~03:10 usage limit reached.** Part 2: `wb2p2:shell` DONE (all B1–B11, C3, C4; report
    `handoff/reports/wb2p2-shell.json`); `wb2p2:engine` was running its full suite (progress log
    `handoff/progress/wb2p2-engine.md`); reviews, fix and gate still to run. Within this session the workflow engine
    re-runs cut-off steps after the reset; in a new session, resume from the journal of `wf_bf8ebfba-3f0`.
  - **Plans done (2026-11-19 ~02:20):** `docs/WAVE-C.md` (2465 lines, 42 review findings applied; D23 makes Wisp tickets
    route-bound) and `docs/WAVE-D.md` (1590 lines, 54 findings applied). Their (log) decisions are in the decisions log.
    **Open user decision:** Wave D D10 (no obfuscation vs an opt-in step) — asked 2026-11-19; default = minify only.
  - **Next:** after part 2's gate: Wave B step 3 (x1–x5) + Wave C g1, v2, g2, v1, t + Wave D a-parts (d1a, d2a, d3a, d4a),
    staged so the machine is not overloaded (≤ ~8 builders at once); then step 3 integration → Wave C v3 + integration →
    Wave D b-parts + integration → Wave E. Every
    wave that adds or changes a feature updates its `README.md` section (decisions log 2026-11-18).
- **Session 5 (2026-11-12 16:04, session `513d2f13-6cd4-4fe9-9f35-b1ee7206ba3c`)** picked up after the 13:50 usage-limit
  cut-off, which stopped all six restyle builders of `wf_3bf962e4-104` mid-work (about 110 files changed, no reports; the
  tree was green at 16:14: `npm run check` 0 errors, `npm test` 886/886). `wf_96662f5a-c9d` resumes them — `ui:shell-chrome`
  (36000-36499), `ui:start-page` (36500-36999), `ui:components-forms` (37000-37499), `ui:components-overlays` (37500-37999),
  `ui:pages-settings` (38000-38499), `ui:pages-other` (38500-38999) → `ui:review-shell` (39000-), `ui:review-components`
  (39500-), `ui:review-pages` (40000-) → `ui:final` (40500-). Each agent appends to a progress log in
  `.../513d2f13-6cd4-4fe9-9f35-b1ee7206ba3c/handoff/progress/<label>.md`; the predecessors' condensed logs are in
  `.../handoff/resume/cutoff-1350-ui-*.md`. Final screenshots: `.../handoff/shots-ui-final/`.
- **Wave B step 2 integration** (the 10 lane agents of `wf_84438bab-662` are done; their reports are
  `.../dd256ece-be77-4b53-a635-25f83fe68d31/handoff/reports/wave-b-*.json`). `resumeFromRunId` does not work across
  sessions, so session 5 runs the integration as new workflows that read those reports from disk, in two parts:
  - **Part 1 (running beside the restyle since 16:25, `wf_195f36e0-6de`; touches no UI or engine-host runtime files):**
    `wb2:contract-backend` (41000-41499: contract change requests in `src/shared/**`, CSP fixtures shared with `csp.rs`,
    `account-sync.ts` per-kind try, runner hook for the standalone backend suites, cargo gates in `target/`) ∥ `wb2:docs`
    (ENGINE-PROTOCOL §1.1 threat table and markers, ARCHITECTURE stale sections, WAVE-B3 realm.ts API, the About
    "known limitations" texts for part 2) → `wb2:verify-part1` (41500-41999, a skeptic).
  - **Part 2 (after `ui:final`):** rebuild `wb-e2e`, every suite under `tests/e2e/engine/` in both browsers, the spike
    leak suite and attack rows against the real engine host, real browsing through GNOME's UI (both engines, both
    browsers), the About limitations, the open lane items part 1 lists for the engine host/SW/transport, the
    `registerFeature('browser')` check, the Phase 3/4 checklist → an independent review (security ∥ quality) → fixes.
    Findings F2–F6 of `docs/WAVE-B3.md` §11.2 stay with step 3's lane x1 unless they are small.
- **Orphaned dev servers** from the cut-off builders listen on 127.0.0.1 ports 31010, 31080-31082, 32090, 33010-33012,
  33080-33082, 33090-33092, 33510 and 33520-33522 (PIDs 1488313 1488315 1492065 1492066 1492067 1492068 1494865 1494943
  1498025 1508057 1508058). Agents must not bind those ports or kill them; the user stops them.
- **Wave A2: done** (session 4, `wf_74148f76-567`, 7 steps passed after fixes). **Wave B step 1 (contract): done**
  (`wf_145dde91-909`): final `docs/ENGINE-PROTOCOL.md` v1, the frozen contract in `frontend/src/shared/**` (151 tests),
  `docs/WAVE-B.md` (five lanes, §10 owners of the Wave B inputs); two reviews (security, completeness) + fix (29/30 applied).
- **Wave B step 2 (running, `wf_84438bab-662`, launched 01:50)**: five lanes per `docs/WAVE-B.md` §2–§6 in parallel —
  `wave-b:a-engine-core` (27000-27499), `wave-b:b-transport-sw-build` (27500-27999; day-one modules first),
  `wave-b:c-browser-shell` (28000-28499), `wave-b:d-browser-data` (28500-28999), `wave-b:e-backend` (29000-29499) —
  each followed by `<label>-review` as soon as its builder finishes, then `wave-b:integrate` (29500-29999: contract change
  requests, wiring, every suite in both browsers, real browsing, `registerFeature('browser')`, docs). Builders at effort
  `high`, reviews/integration at `max`. Cargo: lanes a–d share `~/.cache/gnome-targets/wb-e2e`; lane e uses `target/`.
- State at launch: frontend `npm run check` clean, 492 tests (28 files) pass; `cargo test --workspace` 407 pass.
  The orphaned dev servers and watchers left by cut-off agents were stopped by the user on 2026-11-12 at 11:20.
- **2026-11-12 03:20–06:10 usage-limit cut-off:** `a-engine-core` and the four running reviews (`b`, `c`, `d`, `e`) were
  cut off; the workflow engine re-ran all five at 06:10. Their predecessors' condensed transcripts (what they already
  found and fixed) are in the handoff kit: `resume/cutoff-0320-wave-b-<lane>.md`. A re-run reviewer should read its
  file first, so it doesn't redo finished work; the integration step should merge those findings into the record.
- **Wave B step 3 planning: done** (`wf_73083f95-b51`, 12:59; `docs/WAVE-B3.md` ~224 KB, 41/41 review findings applied): `wave-b3:plan` writes
  `docs/WAVE-B3.md` (built-in extensions: filter engine + network blocking, cosmetic + scriptlets, privacy + cookies,
  Extensions UI) → `review-security` ∥ `review-completeness` (report only) → `plan-fix`. Doc-only: new shared code is
  written into the plan and added by its lane after step 2's integration.
- 2026-11-12 ~09:15: usage limit reached while `a-engine-core-review` (step 2) and both step-3 plan reviews were
  running; the workflow engine re-ran all three at about 11:10.
- **UI restyle (user direction, 2026-11-12 11:30; running as `wf_3bf962e4-104`):** "make it more in the style of
  https://testing.itcode.fyi/ and https://iv.antitechnocrat.net/". `ui:direction` (DESIGN.md v2 + foundation: tokens, type,
  monochrome mark in `public/brand-v2/`, original wallpaper, new defaults) → `ui:shell` ∥ `ui:components` ∥ `ui:pages` →
  six builders (`ui:shell-chrome`, `ui:start-page`, `ui:components-forms`, `ui:components-overlays`, `ui:pages-settings`,
  `ui:pages-other`) → three area reviewers that fix (`ui:review-shell`, `ui:review-components`, `ui:review-pages`) →
  `ui:final` (sped up at the user's request at 13:20; the script was edited and the run resumed from `ui:direction`'s
  cached result). Reference screenshots: the session scratchpad's `ref/shots/`.
- **Step 2 is paused:** `wf_84438bab-662` was stopped at 13:22 right after `a-engine-core-review` passed (all 10 lane agents
  done; `wave-b:integrate` had started and edited nothing). Resume it after the restyle with
  `Workflow({scriptPath: '.../workflows/scripts/gnome-wave-b-build-wf_84438bab-662.js', resumeFromRunId: 'wf_84438bab-662'})`:
  the 10 finished agents replay from cache and only the integration runs. Remove the STOP note above first.
**If this session is cut off:**
- Journal: `~/.claude/projects/-home-duderucool-gnome/dd256ece-be77-4b53-a635-25f83fe68d31/subagents/workflows/wf_84438bab-662/journal.jsonl`.
  A step with a `started` line but no `result` line was interrupted: condense its `agent-<id>.jsonl` with
  `handoff/scripts/condense.py <agent.jsonl> <out.md>` and resume it with that brief. (Within the same session the
  workflow engine re-runs a step cut off by the usage limit by itself; the re-run agent reads its predecessor's log.)
- Script (prompts to reuse): `.../dd256ece-be77-4b53-a635-25f83fe68d31/workflows/scripts/gnome-wave-b-build-wf_84438bab-662.js`.
- Handoff kit (reboot-safe): `.../dd256ece-be77-4b53-a635-25f83fe68d31/handoff/` — `reports/` (every finished step of
  Wave A2 and Wave B step 1 as JSON), `brief-finished-11.json`, `resume/`, `scripts/{condense,watch*}.py`.
- HolyWisp binaries: `services/holywisp/build/x86_64/{holywisp,holywisp-client}` (rebuild: `services/holywisp/fetch-build.sh`).
- Next after step 2: Wave B step 3 (extensions: gnome-shield core + adapters, filter-engine worker, cookie manager,
  Extensions page; hook points in `docs/WAVE-B.md` §9) → e2e on real sites → multi-lens review; then Wave C (games + VPN page).

## Implementation plan (waves; each step = builder + independent review/fix)
Session 1 (2026-11-09) ran research + Wave A until the usage limit stopped every agent mid-step.
- **Wave A2 (resume, 2026-11-10)** — backend: core finish → review → origins + Wisp tickets + gateway → gnome-net + filter
  lists + VPN profiles → review · frontend: foundation finish (Rail effect loop) → review → Settings + About → review ·
  proxy: HolyWisp packaging (`services/holywisp/`) → two-origin engine-host spike (Scramjet + UV over HolyWisp, Chromium +
  Firefox) → `docs/research/spike-engine-host.md` + `tests/e2e/` harness.
- **Wave B — proxy + browser**: engine protocol contract (`src/shared/engine-protocol.ts`, `docs/ENGINE-PROTOCOL.md`) →
  engine host (Scramjet + UV adapters, engine manager/fallback, transport manager, SW) ∥ browser shell (tabs, toolbar,
  omnibox, session restore, history/bookmarks/downloads stores + pages, context menus, find, zoom, fullscreen,
  shortcuts) → extensions (gnome-shield core + adapters, filter engine worker, cookie manager, Extensions page) →
  integration e2e on real sites → review.
- **Wave C — games + VPN**: `gnome-catalog` (schema, importers, FTS5, ranking, thumbnails, CLI/admin) ∥ games UI (catalog,
  sections, search, categories, favorites, recent, player) ∥ VPN page + verify + `services/vpn/` examples → review.
- **Wave D — performance + production**: Node/wisp-js baselines vs Rust/HolyWisp benchmarks (`docs/BENCHMARKS.md`),
  build pipeline (vendor copy, precompress, image optimization, no public source maps, opt-in obfuscation of GNOME-owned
  code), deployment (Docker multi-arch, compose, systemd, Caddy, Raspberry Pi notes), dependency audits.
- **Wave E — verification + delivery**: multi-dimension adversarial review → fixes → full e2e → README/setup/deploy/env docs.

## Wave B step 2: cross-lane findings so far (for the lane reviewers and `wave-b:integrate`)
> **Status 2026-11-18 (from the lane review reports, to be re-proven by integration part 2's full rerun):** the history
> wipe (lane c review: `#freshStartApplied` starts true, unit test), the `download.done` race (lane c review, unit test) and
> F1 — engine-host-realm functions in proxied realms (lane a review, critical, fixed with `realm.ts`'s page kit; WAVE-B3 §4.7)
> are fixed; the `session.test.ts` flake was deflaked (lane c review); the `bareMuxWorkerCsp()` contract item is done
> (part 1); the Firefox idle-SW docs item is done (`wb2:docs`); the Firefox + Ultraviolet byte count was measured equal by
> the lane d review (`library-visits` asserts it; part 2's rerun confirms). Still open: F2–F6 (open in the code on
> 2026-11-18 per `wb2:docs`; lane x1's first tasks in step 3).
Found by one lane in another lane's files. The reviewer of the owning lane fixes them; whatever is left goes to the
integration step. Full reports: `~/.claude/projects/-home-duderucool-gnome/dd256ece-be77-4b53-a635-25f83fe68d31/handoff/reports/wave-b-*.json`.
- **Lane c (high):** `startBrowser()` clears the whole history on every app load, whatever `privacy.clearHistoryOnExit`
  says. In `src/browser/browser.svelte.ts` the `onLibrary()` listener calls `#applyClearOnExitHistory(lib)` as soon as it
  registers, while `#freshStartApplied` is still `false` (lane d's `library-pages` e2e, 2 failures).
- **Lane c:** a `download.done` that arrives right after `download.started` is dropped as an unknown id, because
  `#onDownloadStarted` adds the id to its known set only after `await DownloadStore.started()` resolves. Small downloads
  stay "Downloading" until the engine host ends (lane d's `library-visits`, 4 failures, every engine × browser).
- **Lane a (with lane b's UV tap):** Firefox + Ultraviolet downloads complete with `received` < `total` (21,396,876 of
  21,456,836 for a 21 MB zip; lane b's row: `download.done` 1,982,464 vs 2,097,152 signalled by the SW).
- **Lane a (HIGH, found by the step-3 planner by reading the code, not run):** step 2 installs engine-host-realm
  functions in proxied realms (`popups.ts` keep('open'/'close') and the form-submit wrapper; `webrtc.ts` frame getters
  and insertion wrappers; the `tabs.ts` UV createWebSocket wrapper). An ordinary proxied page can then reach the
  engine-host realm, e.g. through `fn.constructor` (the engine-host CSP allows 'unsafe-eval'). Install functions created
  in the proxied realm instead; `docs/WAVE-B3.md` §3 has a helper for this. `wave-b:integrate` must fix it and add a test.
- **For `wave-b:integrate` from the step-3 plan reviews (`docs/WAVE-B3.md` §11.1–§11.2, findings F2–F6):** step-2
  engine paths that give ordinary pages the engine-host window (F2, e.g. UV `frameElement`); the SW still authenticates
  engine hosts by client URL, which a page can fake with `history.pushState` to `/engine/` (F3); UV's cross-origin
  `pushState`/`replaceState` (F4) and `cookieStore` (F5); forged CSP-violation counts (F6, `isTrusted`). Fix them in
  step 2 if they're small; otherwise they're lane x1's first tasks in step 3.
- **Lane c:** `src/browser/session.test.ts` flaked once in lane d's full `npm test` run.
- **Contract (integration step):** the frozen `bareMuxWorkerCsp()` (`connect-src 'self'` alone) is itself a permissive
  realm: opened as a document it loaded `<img>`, `<iframe>` and module `import()` from a sentinel in Chromium, and as a
  worker it can `importScripts()` any URL. Lane e serves a stricter policy; `src/shared/proxy-origin.ts` and
  ENGINE-PROTOCOL/ARCHITECTURE must be updated to match (lane e's report).
- **Docs (integration step):** Firefox stops an idle SW after about 30 s even while engine hosts run; a double controller
  revive then lost an in-flight request (fixed in lane b). Record it in ENGINE-PROTOCOL and ARCHITECTURE §5.4.

## Wave B inputs from the session-4 integration checks
Each item needs an owner lane in `docs/WAVE-B.md`. Full reports: `~/.claude/projects/-home-duderucool-gnome/dd256ece-be77-4b53-a635-25f83fe68d31/handoff/reports/integrate-{stack,contracts}.json`.
- Engine-host CSP and bare-mux worker CSP from the spike work on the real gnome-server
  (`tests/e2e/stack/engine-on-gnome-server.mjs`) but are not backend defaults yet. Make them the proxy role's defaults
  (worker policy for the worker scripts under `/vendor/`), with the custom-Wisp opt-in from the decisions log.
- The ticket probe answers 426 even when the route's upstream is down (the upgrade then fails with 502). The probe should
  answer 503 `wisp_upstream_unavailable` with `Retry-After` while the health job marks that route's upstream down, and
  the engine host must back off after a 426 followed by a failed upgrade instead of rebuilding in a loop. VPN location
  status comes from the app (`/api/vpn/locations`).
- The ticket renewal margin must scale with the TTL: the spike's fixed 5-minute margin never renews at a 60 s TTL. The app
  queues and coalesces `needTicket` requests (`POST /api/wisp/ticket` allows 30/min/session) instead of dropping them.
- Still open from the spike: WebRTC kill switch; explicit apply step for a waiting `/sw.js` (Firefox); SW→host signals
  through `client.postMessage`, never the public `gnome-engine` BroadcastChannel; engine iframe without `allow-popups*`.
- Not yet run on the real stack: `code` and `accounts` access modes, HTTPS with two hostnames, a real VPN tunnel, the
  perf suite.
- **No permissive realm on the proxy origin** (orchestrator review of the contract draft): escaped code can open ANY same-origin document in a hidden frame and run `fetch`/`WebSocket`/`new Image()` from that realm, which obeys that document's CSP, not the proxied page's. So every response the proxy role serves (`/engine/`, `/api/health`, `/api/filters*`, `/assets/*`, `/vendor/**`, the 404 and engine-prefix 503 pages, error pages) needs a CSP at least as strict as the proxied-document policy, `default-src 'none'` where nothing is rendered; the SW adds the hard-wired policy to every document it creates or passes through (its own hold/503 pages included); and no URL parameter may widen a policy. Lane e (backend) and lane b (SW) own this; the e2e attack suite must prove it by borrowing each kind of proxy-origin document.
- Real-stack harnesses to reuse: `tests/e2e/stack/stack-qa.mjs` (95 route/header/cookie/CSRF/Wisp checks) and
  `tests/e2e/stack/engine-on-gnome-server.mjs` (the spike engine host on the real gateway).
- Stale comments (low): `services/holywisp/gnome.conf`'s header says the gateway terminates TLS (the reverse proxy does);
  the header and `bus:disable-leak-csp` message of `tests/e2e/spike-engine-host/suites/attack.mjs`;
  `crates/catalog/src/blocklist.rs:227` (no `start:` prefix).

## Deferred items (to schedule in Wave D/E)
- Per-account sync storage quota (bytes) — today only entry counts bound it (100k history, 20k bookmarks); decide default + API error.
- Global/per-IP concurrent HTTP connection cap and `LimitNOFILE=` in the gnome-server systemd unit (core review; since
  2026-11-11 the server raises its soft `RLIMIT_NOFILE` to the hard limit at startup).
- `GET /api/sync/bookmarks` pagination for very large accounts.
- ~~Home background images from https: URLs load directly (reveals IP to that host) — Settings must say so or prefer uploaded images.~~ — done 2026-11-11 (Settings → Appearance says so; uploaded pictures stay in the browser).
- Wave C backend: app CSP `frame-src` from `gnome_catalog` `embed_hosts()` after each import (Playgama embeds from developer hosts), not a fixed list; OSS fetch step into `GNOME_OSS_GAMES_DIR` + serve `/oss/<slug>/` on the proxy origin; add the crate's own settings (`GNOME_GAMEPIX_SID`, publisher IDs, `GNOME_OSS_*`, … ARCHITECTURE §4.2) to `config.rs` `VARS` (API.md/ARCHITECTURE §4.5 already list the crate's additive fields and tables).
- **Cookie flood across the origin boundary (Wave D decision):** escaped code on the proxy origin can plant about 160 KB+
  of cookies that the app origin also receives (dev two-port: same host; production: a proxy hostname under the app's
  domain can set `Domain=<app domain>`), so every app request exceeds hyper's head limit and the app is unusable. Options:
  put the proxy origin on a separate registrable domain (needs a cross-site engine-host test: partitioned SW and storage),
  or a larger head limit for the app role once a per-IP connection cap exists. Lane e review, 2026-11-12.
- **Reverse-proxy error pages (Wave D):** Caddy answers oversized request heads itself (default `max_header_size` 1 MB,
  below Chromium's 2 MB URL limit) with no CSP, which would reopen a permissive realm on the proxy hostname. The
  deployment config must raise the limit above browser limits or add the strict policy to the proxy's own answers.
- **Synced visits with history off (product decision, Wave E):** `applyRemote` stores other devices' visits even when
  `browser.history.enabled` is off on this device. Proposed: don't store or show them while history is off.
- **History byte budget:** history is capped at 100,000 visits, but a long forged visit stream (about 500 MB) can still
  fill a small storage quota; add a byte budget.
- HolyWisp systemd units verified statically only (no real systemd boot); arm64 binaries ran only under QEMU user-mode.

## Decisions log
| Date | Decision | Why |
| --- | --- | --- |
| 2026-11-09 | Keep `logo.png` byte-for-byte; derive cutout/icons from it | Spec: must use existing logo; JPEG-on-white needs a transparent variant for a dark UI |
| 2026-11-09 | Backend in Rust (Axum/Tokio) from the start; Node.js used only as a benchmark baseline | Single small binary suits Raspberry Pi 4; Phase 7 benchmarks compare against an equivalent Node implementation of the hot paths and wisp-js |
| 2026-11-09 | Do not bundle Sapphire code | Repository has no license (all rights reserved); architecture is adapted, not copied |
| 2026-11-09 | Mullvad integration via public APIs and server-side WireGuard egress only; no Mullvad code or branding | Mullvad app is GPL-3.0; avoid implying affiliation |
| 2026-11-09 | **Website only; Rust for the backend only** (user direction) | No native companion, no desktop/extension builds, no Rust/WASM in the frontend. Frontend = TypeScript/Svelte; proxy engines stay JavaScript; HolyWisp stays the (C) Wisp server as specified |
| 2026-11-10 | **Two origins**: app origin (shell + API) and proxy origin (engine host, SW, vendor, `/wisp/`); Wisp auth by HMAC tickets | Both engine research reports: proxied pages can read every proxied cookie and escape Scramjet's sandbox; isolating them from GNOME's storage and authenticated API is the only real boundary. Single-origin mode remains possible with a visible warning |
| 2026-11-10 | Scramjet 2.0.67-alpha.2 + controller 0.0.14 + libcurl 2.0.6/epoxy 3.0.2; UV 3.2.10 (upstream) + bare-mux 2.1.9 + epoxy 2.1.29/libcurl 1.5.2 | Only combinations verified to work; the linked NebulaServices UV fork is Bare-only and cannot reach Wisp |
| 2026-11-10 | Built-in extensions are first-party (no `chrome.*` emulation, no user-installed extensions in v1) | Sapphire is unlicensed; a first-party runtime on Scramjet plugin hooks is verified to work |
| 2026-11-10 | Games: GamePix public feed + curated OSS enabled by default; GD/Playgama/GameMonetize/Famobi need an operator publisher ID; embeds never proxied or ad-blocked; `games.playMode` removed | Network terms (license to registered publishers; proxying = invalid traffic) |
| 2026-11-11 | **Migrations are append-only from the first release on.** Until then, unreleased migrations (core 1–99, catalog 100–199) may still be edited in place | Session 3's catalog review edited migration 100 (new `reached_end` column, wider `catalog_facets`, FTS prefix '3') after dev databases had applied it; the server only warns about changed SQL and never re-applies it, so a released database would silently miss the new columns |
| 2026-11-11 | **Wisp ticket TTL default 1 h** (`GNOME_WISP_TICKET_TTL_S=3600`, max still 7 days). The engine host renews tickets before they expire and after the `/wisp/` probe answers 401 | A ticket is a bearer token that proxied pages can read on the proxy origin. In open and access-code modes it can't be revoked, so a copied ticket kept working for up to 24 h. The engine-host spike proved rotation and proactive renewal with all four engine × transport combinations, and tickets are checked only at the upgrade, so open connections outlive expiry |
| 2026-11-11 | **Engine iframe drops `allow-popups` and `allow-popups-to-escape-sandbox`**; `window.open` and `target=_blank` open a new GNOME tab through `tab.openRequest` | The session-4 attack review showed that escaped page code can open a native, unproxied popup that reveals the user's real IP. Opening such links as GNOME tabs is also the expected behaviour of a browser inside a page. Cost: flows that need a real popup with `window.opener` (some OAuth/payment sign-ins) must fall back to a full-page redirect; opener emulation between GNOME tabs can be added later |
| 2026-11-11 | **The proxy origin is one shared realm** (accepted limitation; amended 2026-11-18: Wave B step 2 measured that an ORDINARY proxied page also reaches the engine host, without any engine bug, through a fresh child realm's native `parent`/`top`/`frameElement` getters — e2e row `host-attack borrow-natives`, expectFail, both engines, both browsers — so everything below applies to any hostile site, not only to escaped code): escaped code in one proxied page can reach the engine host, other proxied tabs, the proxied cookie jars (HttpOnly included), engine storage and the Wisp ticket. The boundary GNOME guarantees is the app origin, so the app validates every engine→app message and asks for a gesture in its own UI before any privileged action | The attack review demonstrated each of these on both engines and both browsers, while every app-origin check held. Every Scramjet/UV deployment shares the limitation; per-site proxy sub-origins would need wildcard DNS + TLS and are out of scope for v1. Tickets stay bounded by the 1 h TTL and per-session caps |
| 2026-11-11 | **Custom Wisp servers need an operator opt-in** (`GNOME_ALLOW_CUSTOM_WISP`, default off; exposed in `/api/config`). Off: the engine host connects only to its own origin's `/wisp/`, and Settings explains why the custom-server editor is unavailable. On: the proxy role adds `ws: wss:` to the engine-host and bare-mux-worker `connect-src`, and Settings warns that custom servers bypass the gateway, its access rules, VPN profiles and part of the leak protection | The session-4 integration check showed that the strict engine-host CSP (`connect-src 'self'`), which keeps escaped code in the engine-host realm from reaching the network natively, also blocks user-chosen Wisp servers. The server sends the CSP, so it can't vary per user: the operator decides. **This supersedes the `?wisp=` engine-host URL parameter in the first Wave B contract draft**: escaped code can load `/engine/?wisp=wss://attacker` in a same-origin frame and use that realm's widened `connect-src` to reach any host natively |
| 2026-11-12 | **Visual redesign after novene (testing.itcode.fyi) and ivy (iv.antitechnocrat.net)** (user direction): near-black neutral chrome, browser-first shell (tab strip + address bar on top, slim icon rail), the start page as a new-tab page with a dark wallpaper and a monochrome mark, ivy-style glass cards with bold Montserrat headings and a mint default accent. Replaces the earthy olive/gold + Fraunces look of `DESIGN.md` v1 | The user didn't like the v1 UI. Only the visual language is taken from the references, never their code, images, logos or names |
| 2026-11-18 | **`README.md` at the repository root is the operator's entry point** (user request: "make a readme.md on how to start it with every feature"): build, start and use GNOME with every feature it has today, each status honest, every command verified by running it. Every later wave that adds or changes a feature updates its README section in the same step | The detailed docs (backend/, services/, crates/ READMEs, ARCHITECTURE, API) are written for developers of one part; an operator needs one tested path from a fresh checkout to every feature |
| 2026-11-19 | **Wave B step 3 D1 — one filter engine per list group** (ads, security, trackers, params, cookies, annoyances); exception, `$badfilter` and non-exception `$redirect-rule` lines go to every group, `$removeparam` filters to `params` (docs/WAVE-B3.md §1) | Per-group global and per-site toggles and per-category counts without rebuilds; measured ~11 µs per request, +13 % serialized size |
| 2026-11-19 | **Wave B step 3 D5 — per-site maps travel scoped**: `allowlist`/`perSite` go to the engine host only for sites it loads or is about to load (budgeted `tab.loading.url` announcements, empty after two compromise signals); `cookieRules` are sent whole while the cookie manager is on | A hostile page learns the rules of sites it already shows plus a small budget, not the user's whole list |
| 2026-11-19 | **Wave B step 3 D6 — the cached filter engines are MAC'd** (HMAC-SHA-256 over the manifest) with a `blockerKey` the app keeps in its own IndexedDB and sends in `init`; rotated on clear-site-data and after a compromise signal; the SW never reads the cache | Proxied pages can write the proxy origin's Cache Storage; a planted engine must not inject CSS or scriptlets |
| 2026-11-19 | **Wave B step 3 D17 — filter lists from local files**: a `GNOME_FILTER_LISTS_FILE` entry may name `file = "/abs/path"` (regular files only, size bound, timeout) | Deterministic e2e lists served by the real server (its fetcher refuses loopback); operators' own lists |
| 2026-11-19 | **Wave B step 3 D19 — the blocker exists only where `blocker` is offered**; e2e builds get it early through `GNOME_ENGINE_TEST_CAPABILITIES=blocker`; production offers it from step 3's integration on | Blocking the user can neither see nor undo would be fake UI by omission. Step-2 findings F2–F6 (WAVE-B3 §11.2) are open in the code (2026-11-18) and are lane x1's first tasks; F1 was fixed in step 2 |
| 2026-11-19 | **Wave C D1 — timing**: Wave C starts after Wave B step 2 integration part 2; lanes g1, g2, v1, v2 and t run beside Wave B step 3; v3, the shared documents and the final matrix wait for step 3's integration (docs/WAVE-C.md §1–§2) | File ownership: step 3's x4 owns the browser, Settings and About files |
| 2026-11-19 | **Wave C D2 — every game is framed through a per-game wrapper document** `/play-frame/<slug>` on the app origin with its own frame policy; the shell keeps `frame-src 'self' <proxy>`, `frame-ancestors 'none'`, `X-Frame-Options: DENY` | A page-wide `frame-src` let hostile game content navigate its frame to GNOME's own pages (Wave C security review, high) |
| 2026-11-19 | **Wave C D3 — app-origin HTML gets `Cross-Origin-Opener-Policy: same-origin` and a deny-list `Permissions-Policy`** | Pop-ups that escape a game's sandbox (ad click-outs) must not keep a handle on the app window |
| 2026-11-19 | **Wave C D4 — embed hosts are decided per game; catalog data never adds a host by itself** (fixed hosts of enabled sources plus operator-approved `GNOME_GAMES_EMBED_HOSTS`; others become link-outs) | A poisoned or hijacked feed must not widen the app's framing policy |
| 2026-11-19 | **Wave C D5 — open-source games run on the proxy origin under `/oss/<slug>/`** with the proxied-document CSP and `frame-ancestors <app origins>`; never in single-origin mode | Untrusted game code must never run on the app origin, which holds the session and account |
| 2026-11-19 | **Wave C D7 — thumbnails go through `/api/thumb/:id` by default** (SSRF-safe client, host allow-list, 2 MiB cap, type sniffing, disk LRU cache) | No third-party requests from the app page; SSRF safety |
| 2026-11-19 | **Wave C D9 — game favorites and recently played stay in this browser** (not synced in Wave C; the page says so) | No sync kind exists yet; adding one would collide with step 3's files |
| 2026-11-19 | **Wave C D12 — `vpn.mode` and `vpn.killSwitch` are device-local**: account sync and settings import never change them | A synced or imported kill switch stranded a device with nothing loading (lane c review) |
| 2026-11-19 | **Wave C D13 — "Connected" rests on the app's own facts** (the route the app chose + the location `up` in `/api/vpn/locations`), never on what the engine host reports | The engine host is reachable by hostile pages (ENGINE-PROTOCOL §1.1) |
| 2026-11-19 | **Wave C D14 — gnome-server checks each VPN location's exit itself** through that location's HolyWisp; a failed check is a warning only and never changes the route; `GNOME_VPN_CHECK_URL` defaults to empty | An exit check from the page could be faked; the check service sees the server, not users |
| 2026-11-19 | **Wave C D16 — VPN providers' terms**: `config check` and startup warn when VPN profiles are offered to anyone (open access, accounts with open registration, a shared access code) unless `GNOME_VPN_EGRESS_SHARED_OK` is set; the docs say the operator must be authorized for shared use | Some providers' terms (e.g. Mullvad's) forbid offering their service to others; GNOME must not present it as allowed |
| 2026-11-19 | **Wave C D23 — Wisp tickets become route-bound** (`w2`): `POST /api/wisp/ticket` takes the route and the gateway refuses a ticket on another route; lands with lane v3 after step 3 | Escaped code could use a ticket on the direct route and bypass the kill switch (Wave C security review, high) |
| 2026-11-19 | **Wave C D24 — a notice before a network's first frame** ("This game loads from <network>…") | Embeds load ads and trackers from third parties; the user is told before the first one loads |
| 2026-11-19 | **Wave D D1 — timing**: the a-parts of all four lanes (benchmarks, build pipeline, deployment, audits) own only new files and start on Wave B step 3's day one; the b-parts that touch the server core and shared frontend files wait for step 3's or Wave C's integration (docs/WAVE-D.md §1–§2) | No file is contended while step 3 and Wave C run |
| 2026-11-19 | **Wave D D2 — benchmark baselines**: a Node 26 built-ins-only implementation of gnome-server's three hot paths (Wisp gateway, static serving, session/ticket API) with the same rules, and the pinned wisp-js server, each checked for equivalence before timing | The brief asks to benchmark Rust against the original; GNOME was Rust from the start, so the baseline is an equivalent Node implementation |
| 2026-11-19 | **Wave D D5/D6 — release profile and allocator**: keep fat LTO, one codegen unit, strip, `panic = "unwind"`; the system allocator stays unless mimalloc wins by ≥ 10 % without costing more than 5 % memory | Measured choices only; a panicking request stays contained |
| 2026-11-19 | **Wave D D8/D9 — precompression and source maps**: release builds write .br/.gz siblings (vendor files .br only); GNOME's own code never has source maps; vendored engines' maps are removed from release builds | Smaller transfers; nothing leaks through served maps |
| 2026-11-19 | **Wave D D10 — no obfuscation (PENDING USER CONFIRMATION)**: GNOME's own code is AGPL-3.0-only and minified only; third-party code is never touched. Alternative offered to the user: an opt-in, off-by-default obfuscation step for GNOME's own code | Under AGPL every operator must offer users the source, so obfuscation protects nothing and costs size and speed; this drops a brief item, so the user decides |
| 2026-11-19 | **Wave D D11/D27 — third-party notices and Corresponding Source**: release builds carry THIRD-PARTY-NOTICES.txt, and the release offers the source of every shipped copyleft/MPL package and of GNOME itself (AGPL §13) | License obligations of a network service |
| 2026-11-19 | **Wave D D13–D17 — release artifact and deployment**: reproducible `scripts/release.sh` (x86_64 + aarch64, static musl, checksums); a FROM-scratch multi-arch gnome-server image cross-built without binfmt; compose with Caddy as the only published service; a Caddy config with `max_header_size 4MB` and the strict CSP on Caddy's own answers; a hardened systemd unit (DynamicUser, LimitNOFILE=65536) | The deferred reverse-proxy and LimitNOFILE items; no host binfmt changes ever |
| 2026-11-19 | **Wave D D18 — connection caps**: `GNOME_MAX_CONNECTIONS` (default 4096), a per-address cap at accept, a per-client in-flight cap (503) | The deferred global/per-IP connection cap |
| 2026-11-19 | **Wave D D19 — cookie flood across the origin boundary**: sibling hostnames stay the supported default and gnome-server tolerates the flood (1 MiB heads only from trusted proxies, cookie hygiene in the app); a separate registrable domain stays an option, never the default | The deferred Wave D decision, with evidence rows CF1–CF7 |
| 2026-11-19 | **Wave D D20 — per-account sync storage quota**: `GNOME_SYNC_QUOTA_MB` (default 64), exact via SQLite triggers, 413 `quota_exceeded`, history trimming, a usage endpoint, bookmark paging | The deferred quota, history byte budget and bookmark paging items |
| 2026-11-19 | **Wave D D23–D26 — secrets from files, audits, Raspberry Pi 4, budgets**: `_FILE` twins for the three secrets; `scripts/audit.sh` (cargo deny + npm audit, shipped vs build-only); 64-bit Pi OS only, arm64 cross-compiled and run under QEMU user-mode only where no host change is needed; budgets in `scripts/budgets.json`, report-only until baseline-1 | Operations hygiene; nothing claimed for hardware that was not measured |
