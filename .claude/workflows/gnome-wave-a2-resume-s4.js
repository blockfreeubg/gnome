export const meta = {
  name: 'gnome-wave-a2-resume-s4',
  description: 'Session 4: resume the 4 cut-off Wave A2 steps + backend follow-ups for Wave B, then parallel integration checks',
  phases: [
    { title: 'Backend', detail: 'net+filters review (resumed) ∥ gateway follow-ups (probe 401/426, ticket URL forms, RLIMIT_NOFILE, ticket TTL 1 h, catalog sources default)' },
    { title: 'Frontend', detail: 'Settings + About pages review (resumed)' },
    { title: 'Proxy', detail: 'spike verify + assemble (resumed) ∥ isolation attack (resumed)' },
    { title: 'Integrate', detail: 'real two-origin stack + gates ∥ contracts/docs consistency' },
  ],
}

const SP = '/tmp/claude-1000/-home-duderucool-gnome/dd256ece-be77-4b53-a635-25f83fe68d31/scratchpad'
const OLD_SP = '/tmp/claude-1000/-home-duderucool-gnome/1d2e1573-d9e9-4d46-9fd5-fb4b891e3432/scratchpad'
const HO = '/home/duderucool/.claude/projects/-home-duderucool-gnome/dd256ece-be77-4b53-a635-25f83fe68d31/handoff'
const ROOT = '/home/duderucool/gnome'
const HW = `${ROOT}/services/holywisp/build/x86_64`
const TGT = '/home/duderucool/.cache/gnome-targets'
const FAST = 'high'

const BUILD = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    features_done: { type: 'array', items: { type: 'string' } },
    features_partial: { type: 'array', items: { type: 'object', properties: { feature: { type: 'string' }, reason: { type: 'string' } }, required: ['feature', 'reason'] } },
    verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    interfaces_for_other_teams: { type: 'array', items: { type: 'string' }, description: 'APIs, extension points, file paths, env vars other teams must use' },
    open_issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'features_done', 'features_partial', 'verification', 'interfaces_for_other_teams', 'open_issues'],
}

const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'pass_after_fixes', 'fail'] },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, area: { type: 'string' }, description: { type: 'string' }, fixed: { type: 'boolean' } }, required: ['severity', 'area', 'description', 'fixed'] } },
    verification: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    remaining_issues: { type: 'array', items: { type: 'string' } },
    interfaces_for_other_teams: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'findings', 'verification', 'remaining_issues', 'interfaces_for_other_teams'],
}

const SAFETY = `HOST SAFETY (non-negotiable): never run privileged containers (docker run --privileged, --cap-add SYS_ADMIN, systemd-in-Docker), never mount host /proc/sys, /sys or /dev into a container, and never change host kernel state (sysctl, binfmt_misc, kernel modules, core_pattern). In session 2 a privileged systemd container rewrote the host's binfmt entries and core_pattern. Test systemd units with systemd-analyze verify and static checks only. Unprivileged containers, read-only source mounts and --network none builds are fine. Never use sudo. If something you did may have changed host state, say so in open_issues/remaining_issues; never try to work around a denied command.`

const RESOURCES = `SHARED MACHINE: up to 5 agents run at once on 12 cores / 14 GB RAM, next to the user's own desktop apps (about 9 GB is free). Run cargo with CARGO_BUILD_JOBS=4. /tmp is a small RAM-backed tmpfs: NEVER put a CARGO_TARGET_DIR (or any multi-GB output) under /tmp or the scratch dir — extra cargo target dirs go under ${TGT}/<name> (on disk), exactly as your task specifies. Close every browser you launch.`

const LEFTOVERS = `LEFTOVER PROCESSES: two orphaned gnome-server dev servers from session 3's cut-off agents are still running — pid 320484 on 127.0.0.1:20700-20702 (binary ${ROOT}/target/debug/gnome-server, data dir under ${OLD_SP}/work-backend-r2/d1) and pid 328891 on 127.0.0.1:21301-21303 (binary ${TGT}/fe-review/debug/gnome-server, data dir ${TGT}/fe-review/qa-data). The orchestrator is not permitted to stop them; the user will. Leave them alone: don't kill them, never bind those ports, never reuse those data dirs (rebuilding over their binaries is fine on Linux). Port 20241 belongs to something else on the machine, and ports 8080/8081 to the user's other project's Docker containers — never touch processes or containers you didn't start.`

const PRE = `You are a senior engineer on GNOME — a self-hostable, production-quality web proxy + in-browser browser + games platform. Project root: ${ROOT}.
READ FIRST: ${ROOT}/docs/PROGRESS.md (wave plan + decisions log), ${ROOT}/docs/ARCHITECTURE.md (v0.3 — note §4.6: TWO ORIGINS (app origin vs proxy origin) and Wisp tickets), ${ROOT}/docs/API.md, ${ROOT}/docs/DESIGN.md (frontend work), ${ROOT}/docs/ENGINE-PROTOCOL.md (draft app⇄engine-host contract). The Phase-1 research reports are complete in ${ROOT}/docs/research/ (scramjet.md, ultraviolet.md, holywisp.md, sapphire.md, mullvad-vpn.md, games-sources.md, content-blocking.md). They are long; grep and read the sections relevant to your task.
PRODUCT RULES (non-negotiable): GNOME is a WEBSITE ONLY (no native/desktop apps, no browser-extension builds). RUST IS USED FOR THE BACKEND ONLY; the frontend is TypeScript + Svelte 5; proxy engines stay JavaScript; HolyWisp stays the C Wisp server. No fake UI or nonfunctional controls; no placeholder implementations for core features; no TODO comments for major features; don't claim something works unless you tested it; never modify or replace ${ROOT}/logo.png, ${ROOT}/frontend/public/brand/** or ${ROOT}/frontend/public/logo.png; don't expose secrets; respect licenses (Sapphire has no license: never copy its code).
${SAFETY}
${RESOURCES}
${LEFTOVERS}
ENVIRONMENT: Linux x86_64, node 26 / npm 12, cargo/rustc 1.99 (edition 2024; no rustup), gcc/clang/cmake, python3, docker (local images gnome-holywisp:0.1.0-e0a0f15, gnome-hw-scratch:test and gnome-hw-toolchain:{debian,bookworm,alpine,cross-arm64,cross-armhf,cross-i386}), sqlite3, curl, ab, brotli. Network available (crates.io, npm, GitHub). Playwright browsers cached at ~/.cache/ms-playwright (chromium-1248, chromium_headless_shell-1248, firefox-1555); drive them with playwright-core from npm. HolyWisp (the C Wisp server, packaged in services/holywisp/, pinned e0a0f15) — static x86_64 binaries at ${HW}/holywisp and ${HW}/holywisp-client; the maintained hardened config is ${ROOT}/services/holywisp/gnome.conf (copy it into your scratch dir to override the port or log level; never weaken the project copy). Untrusted third-party code you clone must be built/run inside unprivileged Docker containers, not on the host.
SCRATCH: ${SP}/work-<your label>/ for small throwaway files — never write scratch files into the project. Anything worth keeping (test harnesses, fixtures) belongs in the project (tests/ or the owning module).
PORTS: use only the port range given in your task; stop every process you start and confirm with ss -ltnp before finishing.
COORDINATION: several engineers work in parallel, some in the same directories. Only modify files you own (listed in your task). When your task lets you touch a file someone else is also editing, re-read it immediately before each edit, keep the edit small and targeted, and never reformat or rewrite it. If a build or test fails because of someone else's in-progress change (files you don't own), wait a minute and retry instead of "fixing" their work; report it if it persists. Record needs from other teams in interfaces_for_other_teams / open_issues. Keep the docs in sync when you add/rename env vars, endpoints or settings keys.
HISTORY: sessions 1 (2026-11-09), 2 (2026-11-10) and 3 (2026-11-11 afternoon) were each cut off by a usage limit while agents were mid-task; this is session 4 (2026-11-11 evening). Session 3's workflow finished 11 of its 15 steps; four were cut off at 21:47–21:49 UTC (16:47–16:49 local; transcript timestamps are UTC) and the two integration steps never started. Reports (JSON) of every finished step are in ${HO}/reports/; condensed transcripts of the four cut-off steps are in ${HO}/resume/ (each lists every Edit/Write in order, the agent's reasoning text and its last 120 tool calls with truncated results — changes made through shell commands are NOT in the Edit/Write list, so look for them in the tool calls). Session 3's scratch dir ${OLD_SP} still exists as a read-only reference; write new scratch files under ${SP}. Never assume interrupted work is complete or correct — verify it. State at the start of session 4: \`cargo check --workspace --all-targets\` is clean; in frontend/, npm run check is clean (0 errors, 0 warnings) and npm test passes 22 files / 333 tests. The project is NOT a git repository, so there's no known-good state to diff against: read a file fully before rewriting it. A session can be cut off at any time, so work in small increments and get the tree back to compiling and test-green often; never leave a large rewrite half-applied.`

// ======================= Backend =======================
const R2_FOCUS = `- gnome-net: IpPolicy completeness vs HolyWisp (IPv6 forms, mapped/embedded v4, 0.0.0.0, ::), DNS-rebinding resistance (connect-to-vetted-IP, redirect re-validation), body limits while streaming, timeouts, TLS without OpenSSL.
- Filter lists: atomic replace, conditional GET, ETag strength, size limits, offline startup, registry licenses/URLs actually correct (curl -I them), served on both roles, CLI + admin refresh, metrics.
- Run: cargo clippy --all-targets -- -D warnings; cargo test; cargo build --release.`

const R2 = `${PRE}

TEAM: backend — label backend:net-filters-review — ports 20710-20999 (20700-20702 are taken by an orphaned server, see LEFTOVER PROCESSES), scratch ${SP}/work-backend-r2, cargo uses the default target dir (${ROOT}/target). INDEPENDENT REVIEW & HARDENING of the gnome-net crate and the filter-list service (RESUMED).
The builders' reports: ${HO}/reports/backend-gnome-net.json and ${HO}/reports/backend-filter-lists.json — read both fully. Do NOT trust them. Read the actual code and contracts (docs/ARCHITECTURE.md §4, docs/API.md filters sections, docs/research/content-blocking.md, docs/research/holywisp.md IP policy), then verify by running things.
A previous reviewer worked on this for about 21 minutes in session 3 and was cut off. Its condensed transcript is at ${HO}/resume/s3-backend-net-filters-review.md — read it first. It changed files only through shell commands (its Edit/Write list is empty): it moved crates/net/tests/client.rs (and possibly the backend filter tests) to kernel-assigned ephemeral ports, and at 21:39 UTC it APPENDED a new test \`replacing_a_list_while_it_is_served\` to backend/tests/filters.rs. The cargo test run that followed had not finished after 600 s when the session was cut off, so that test may hang, deadlock or be far too slow: investigate it FIRST (run it alone under \`timeout\`), then fix the test or the code it exposes. Before the cut-off it also checked the debug binary by hand (filters refresh; /api/filters on both roles; ETag/304; immutable ?v=; HEAD), and what it saw looked right; its scratch data is in ${OLD_SP}/work-backend-r2/. Verify all of it yourself.
Another backend engineer (backend:gateway-followups, CARGO_TARGET_DIR=${TGT}/r1) works at the same time on backend/src/{gateway/**, origins.rs, auth/**, security/**}, the startup path and a few config.rs defaults (Wisp probe semantics, ticket URL forms, RLIMIT_NOFILE, ticket TTL default, GNOME_CATALOG_SOURCES default). Don't edit those files; follow the shared-file rules for config.rs/router.rs/state.rs/cli.rs/admin/**, Cargo.toml, README and docs.
OWNERSHIP: crates/net/**, backend/src/filters/**, backend/tests/filters.rs, [workspace.dependencies] in ${ROOT}/Cargo.toml (the follow-ups engineer may add a feature there too — re-read right before each edit), and targeted fixes in the shared backend files. Don't edit crates/catalog/**.
FIX every real problem you find. Don't rewrite working code for taste.
Focus areas:
${R2_FOCUS}
Report every finding (including what the previous reviewer found that you verified) with severity and whether you fixed it; list anything you could not fix in remaining_issues.`

const B4 = `${PRE}

TEAM: backend — label backend:gateway-followups — ports 20300-20699, scratch ${SP}/work-backend-followups, CARGO_TARGET_DIR=${TGT}/r1 (warm from the gateway review). TASK: the backend follow-ups that session 3's gateway review and the two-origin engine-host spike handed to the backend; Wave B's engine host depends on them.
Read first: backend/README.md and backend/src/{gateway/**, origins.rs, config.rs, auth/**}; ${HO}/reports/backend-origins-gateway.json and ${HO}/reports/backend-gateway-review.json (what was built and reviewed); ${HO}/reports/proxy-spike-transport-fallback.json and docs/research/spike-engine-host/transport-fallback-perf.md (item 5: the ticket/reconnect findings and the exact probe recommendation — another engineer may merge that section file into docs/research/spike-engine-host.md while you work; read whichever exists); docs/API.md (Wisp, POST /api/wisp/ticket, error envelope/codes); docs/ARCHITECTURE.md §4.2/§4.6; the decisions log in docs/PROGRESS.md.
1. PROBE SEMANTICS (spike recommendation): today upgrade() answers 426 to every plain (non-Upgrade) GET before it checks the ticket, so the engine host can't tell a rejected or expired ticket from a valid one and never asks for a new one. A plain GET on /wisp/ or /wisp/p/:id/ (proxy role) must verify the ticket first: 401 JSON (API.md's error envelope; add specific documented codes, e.g. wisp_ticket_missing / wisp_ticket_invalid / wisp_ticket_expired, or reuse existing ones if API.md already defines them) for a missing, malformed, forged, expired or revoked ticket, and 426 for a valid one. The probe must NOT require Origin (browsers don't send Origin on same-origin GET fetches), but real upgrades keep requiring the exact proxy Origin. Rate-limit the probe (the per-IP upgrade limiter or its own class; justify), never let it take concurrency slots, and make sure it can't mint, extend or otherwise change ticket state. Tests for every case, plus an unknown profile id (404 stays 404).
2. TICKET URL FORMS: libcurl (both generations) refuses a Wisp URL that doesn't end in '/', so the canonical client form is wss://<proxy origin>/wisp/?t=<ticket>&/ (and /wisp/p/<id>/?t=<ticket>&/). Also accept '?t=<ticket>/' by stripping exactly ONE trailing '/' from the t value before parsing (tickets are w1.<exp>.<ref>.<mac b64url> and never contain '/'); make sure the ticket never reaches HolyWisp in any form. Tests for '?t=X', '?t=X&/', '?t=X/', '?t=X//' (reject), extra parameters and percent-encoding. Document the canonical form in docs/API.md and ARCHITECTURE §4.6.
3. RLIMIT_NOFILE: the server keeps the inherited soft limit (often 1024) while a spliced Wisp connection costs about 6 fds, so about 150 concurrent proxied connections hit EMFILE. At startup raise the soft limit to the hard limit (cap at 1,048,576), log before/after once, expose both in /admin/diagnostics, and keep running with a warning if raising fails. Use what the tree already has (rustix with its 'process' feature added in [workspace.dependencies], or libc); justify. Unit-test the helper (including hard == soft). Also check that accept() errors such as EMFILE back off instead of spinning if the accept loop is ours.
4. TICKET TTL DEFAULT (orchestrator decision, logged in docs/PROGRESS.md): GNOME_WISP_TICKET_TTL_S default 86400 → 3600 (max stays 604800; still clamped to the session's expiry). Update the config default, /api/config wisp.ticket_ttl_s, tests, backend/README.md, ARCHITECTURE §4.2/§4.6 and API.md. Also document in §4.6 that tickets are checked only at the upgrade, so open connections outlive ticket expiry (lazy renewal relies on it).
5. GNOME_CATALOG_SOURCES default 'gamedistribution,gamemonetize' → 'gamepix,oss' per the 2026-11-10 games decision (config.rs, README, ARCHITECTURE §4.2). Don't build the Wave C catalog jobs.
OWNERSHIP: backend/src/{gateway/**, origins.rs, auth/**, security/**}, the startup path (server.rs / main.rs / cli.rs as needed), the config.rs defaults named above, admin/** diagnostics fields for item 3, backend tests for these items, [workspace.dependencies] (item 3 only) and the doc sections named above. Another reviewer (backend:net-filters-review, default target dir) is hardening crates/net/** and backend/src/filters/** at the same time and may make targeted fixes in the shared backend files (config.rs, router.rs, state.rs, cli.rs, admin/**, Cargo.toml, README, docs): follow the shared-file rules. Don't edit crates/**, frontend/** or tests/e2e/**.
VERIFY: CARGO_TARGET_DIR=${TGT}/r1 cargo clippy --workspace --all-targets -- -D warnings; cargo test --workspace; the ignored real-HolyWisp tests with HOLYWISP_BIN=${HW}/holywisp; cargo build --release. Then a real check on your ports: HolyWisp (scratch copy of services/holywisp/gnome.conf) + gnome-server with GNOME_PROXY_BIND: mint a ticket, probe it with curl (valid → 426, forged/expired → 401, no Origin header), connect through the gateway with both URL forms and fetch https://example.com with a Wisp client, and check that the startup log shows the raised fd limit.`

// ======================= Frontend =======================
const F3 = `${PRE}

TEAM: frontend — label frontend:pages-review — ports 21400-21999 (21301-21303 are taken by an orphaned server, see LEFTOVER PROCESSES), scratch ${SP}/work-frontend-r2, CARGO_TARGET_DIR=${TGT}/fe-review (warm). INDEPENDENT REVIEW & HARDENING of the Settings + About pages + account sync, and a final check that the foundation review's fixes and the pages fit together (RESUMED). You are the only frontend engineer now.
Reports: ${HO}/reports/frontend-foundation-review.json, ${HO}/reports/frontend-settings.json and ${HO}/reports/frontend-about.json — read them fully. Do NOT trust them. Read the actual code and contracts (docs/ARCHITECTURE.md §5.3, docs/API.md, docs/DESIGN.md), then verify by running things.
A previous reviewer worked on this for about 28 minutes in session 3 and was cut off. Its condensed transcript is at ${HO}/resume/s3-frontend-pages-review.md — read it first. Its edits are in the tree and unverified: Edit/Write on src/settings/{sync.ts, sync.test.ts, account.svelte.ts, store.svelte.ts, store.test.ts}, src/pages/settings/AccountPanel.svelte and src/pages/about/about.test.ts; new files src/settings/{account.test.ts, features.ts}, src/pages/settings/Group.svelte, scripts/rust-crates.mjs and ${ROOT}/tests/e2e/about/about-qa.mjs; plus in-place Python edits (e.g. src/pages/about/licenses.ts) that appear only in its tool calls. Its last npm run check was clean and npm run build passed; it was in the middle of About visual QA against a real server. Finish what it started, and check that each of its changes is complete and correct.
Leads from the earlier reports — verify each, fix the real ones: (a) every signed-out page load logs a 401 from GET /api/auth/me in the console (prefer an endpoint that answers signed-out visitors with 200, e.g. GET /api/session — check API.md and the backend code); (b) startup JS grew about 17 kB because account sync loads at startup (split a tiny account-state module from a lazily loaded sync module); (c) the About page's RUST_CRATES list is a snapshot, and the backend has since linked gnome-net/reqwest/rustls/brotli — regenerate it from \`cargo tree -p gnome-server -e normal\` (scripts/rust-crates.mjs was being written for that; make it reproducible and make the test catch additions as well as removals); two backend engineers are changing the tree right now, so regenerate near the end of your work and say so; (d) the Account section's bookmarks/history 'not stored by this build yet' notes aren't reactive; (e) toasts render below modal dialogs.
You own frontend/** (except the fixed brand assets), tests/e2e/about/** and tests/e2e/settings/**. FIX every real problem you find. Don't rewrite working code for taste. Never edit backend files (two backend engineers are changing the backend now: build it with CARGO_TARGET_DIR=${TGT}/fe-review and retry later if it doesn't compile). Run the real server with a NEW data dir under your scratch dir and GNOME_STATIC_DIR pointing at a fresh build in your scratch dir (vite --outDir), on your ports; restart it after each rebuild (it serves what it read at startup).
Focus areas:
- Every Settings control is wired to a real key and has a real effect; nothing decorative. Search covers every row. Reset works. Import validates input.
- Account flows against the real backend; sync conflict handling correctness.
- Filter lists / VPN locations / proxy isolation rows against the real backend endpoints (check docs/API.md and the backend code for what exists now) and graceful degradation when they are absent.
- About page licenses complete and accurate (check actual package licenses in node_modules, services/holywisp/licenses and docs/research).
- Visual QA screenshots dark/light, desktop/mobile; fix inconsistencies with DESIGN.md; refresh docs/screenshots/settings/ and docs/screenshots/about/ when your fixes change what they show.
- Run: npm run check, npm test, npm run build.
Report every finding (including what the previous reviewer found that you verified) with severity and whether you fixed it; list anything you could not fix in remaining_issues.`

// ======================= Proxy =======================
const SPIKE_REPORTS = `${HO}/reports/proxy-spike-core.json, ${HO}/reports/proxy-spike-isolation-leak.json and ${HO}/reports/proxy-spike-transport-fallback.json`

const HARNESS_ISSUES = `Known harness issues the spike engineers reported (they are done; the harness is now shared only by proxy:spike-verify and proxy:spike-attack): servers/target.mjs still hardcodes port 22090 in /attack (topnav), /nested (cross-site child), /ws-page (default ws URL) and /csp-probe (WebSocket check), which gives wrong URLs to runs on other SPIKE_TARGET_PORT values; tests/e2e/README.md must document every suite and SPIKE_* env var (including SPIKE_GATEWAY_STRICT, SPIKE_GATEWAY_PROBE, SPIKE_PERF_RUNS, SPIKE_PERF_REPEAT and SPIKE_TRACE, which the transport lane documented only in its section file); playwright-core + Firefox can hang on frame.evaluate of tab iframes after location.replace navigations (lib/drive.mjs readOut/bodyText), which can stall a whole suite; --parallel must not be combined with the transport suite (it restarts the shared proxy server) or perf; web/proxy/sw.js takes its UV CSP setting from the gnome-engine BroadcastChannel, which proxied pages can join; spike-core replaced the Firefox body polyfill in web/proxy/sw.js after the other lanes' runs, so their Firefox POST results may predate that change.`

const PV1 = `${PRE}

TEAM: proxy — label proxy:spike-verify — ports 22000-22499 (set every SPIKE_* port inside this range), scratch ${SP}/work-proxy-verify (put SPIKE_RESULTS_DIR there). TASK: ASSEMBLE and ADVERSARIALLY VERIFY the two-origin engine-host spike before Wave B builds on it (RESUMED: the previous verifier ran for only about 5 minutes in session 3 before the cut-off. It read the reports and the harness and made a clean copy of tests/e2e at ${OLD_SP}/work-proxy-verify/clean, where npm ci produced node_modules identical to the project's with 0 vulnerabilities; it changed nothing. Its condensed transcript: ${HO}/resume/s3-proxy-spike-verify.md. Start your runs fresh.)
Three engineers split the spike's items and wrote section files under docs/research/spike-engine-host/ (core.md, isolation-leak.md, transport-fallback-perf.md). Their reports: ${SPIKE_REPORTS} — read them fully. The harness is tests/e2e/spike-engine-host/ (README: tests/e2e/README.md); background: docs/ARCHITECTURE.md §4.6/§5.4/§5.5, docs/ENGINE-PROTOCOL.md, and the relevant parts of docs/research/scramjet.md, ultraviolet.md and holywisp.md.
Another engineer (proxy:spike-attack, ports 22500-22999) is hunting isolation holes in parallel and writes docs/research/spike-engine-host-attack.md plus a new suite; follow the shared-file rules for harness files.
${HARNESS_ISSUES} Fix these (small and additive; behind a flag where a fix would change default behaviour other runs rely on) and list what you changed.
1. Assemble ONE doc, docs/research/spike-engine-host.md: verified results table (all items × engine × transport × browser), the exact wiring code for engine host + SW + postMessage skeleton (copy-pasteable — Wave B's starting point), leak root cause + chosen mitigation, recovery recipes, every limitation (with repro), and recommended changes to ARCHITECTURE §4.6/§5.4 and docs/ENGINE-PROTOCOL.md (listed; don't edit those docs). Then delete the three section files (their content now lives in the main doc).
2. Do NOT trust the reports or sections — try to refute them: re-run the harness from a clean state exactly as tests/e2e/README.md says (npm ci; every suite in both browsers), twice, on ports in your range — do it in a clean copy under your scratch dir so the project's tests/e2e/node_modules stays untouched while spike-attack uses it. Which results reproduce? Which are flaky? For each table row, read the test code and check it actually tests what the row claims (an isolation "pass" really attempts the read and asserts the failure; the leak test detects native requests rather than assuming; a reconnect "pass" really kills the socket). Attack the key conclusions: leak root cause and mitigation (does the CSP really stop the leak on the measured sites? what breaks?), ticket preservation on reconnect, the recovery and fallback recipes, SW control in the sandboxed iframe across reloads, download handling. Check the doc's wiring code matches the harness code that passed.
You own tests/e2e/spike-engine-host/** and tests/e2e/README.md (shared with spike-attack) and docs/research/spike-engine-host.md (+ the section files). Fix wrong claims and add missing tests; add a "Verification (session 4)" section listing what you re-ran, what reproduced and what changed. Stop all processes.
Report every finding with severity and whether you fixed it (fixed = the doc/harness now states and tests the truth); list anything unresolved in remaining_issues, and in interfaces_for_other_teams the concrete requirements Wave B's engine host and the backend must meet.`

const PV2 = `${PRE}

TEAM: proxy — label proxy:spike-attack — ports 22500-22999 (set every SPIKE_* port inside this range), scratch ${SP}/work-proxy-attack (put SPIKE_RESULTS_DIR there). TASK: ADVERSARIAL ISOLATION REVIEW of the two-origin engine-host design, acting as a malicious proxied website (RESUMED: the previous attacker ran for only about 5 minutes in session 3 before the cut-off; it read the harness and was studying bare-mux's SharedWorker/getPort handshake (node_modules/@mercuryworkshop/bare-mux/dist/index.js) as an attack surface, and changed nothing. Its condensed transcript: ${HO}/resume/s3-proxy-spike-attack.md.)
The spike engineers' reports: ${SPIKE_REPORTS} — read them fully.
Read docs/ARCHITECTURE.md §4.6/§5.4/§5.5, the harness (tests/e2e/spike-engine-host/) and the section files under docs/research/spike-engine-host/ (proxy:spike-verify may merge them into docs/research/spike-engine-host.md while you work — read whichever exists). proxy:spike-verify is also re-running the suites and fixing known harness issues in parallel; follow the shared-file rules for harness files, and put your tests in a NEW suite (suites/attack.mjs, registered in run.mjs with a minimal edit).
${HARNESS_ISSUES}
From a proxied page (served through the proxy via the TEST-ONLY HolyWisp config), try — in Chromium AND Firefox, Scramjet AND UV — to: register its own service worker on the proxy origin, or unregister/replace GNOME's /sw.js; read or poison engine-host storage (IndexedDB incl. Scramjet's cookie store and UV's __op store, Cache Storage, localStorage), BroadcastChannel (including the gnome-engine channel's SW config) and storage events; hijack bare-mux's SharedWorker/MessagePort handshake (getPort) to swap or observe the transport; reach other tabs' proxied documents; obtain or replay the Wisp ticket and open its own Wisp connections (and what the per-session caps then allow); forge engine-host → app postMessages (does the app check BOTH event.origin AND event.source? can a proxied frame make the app navigate, show UI or run commands?); escape via window.open + opener, allow-popups-to-escape-sandbox, top navigation, downloads or fullscreen/pointer-lock abuse; break out of Scramjet's/UV's rewriting to reach the network natively (with and without the proposed CSP mitigation); read what /api/health, /api/filters and other proxy-origin endpoints expose.
Also settle what the isolation lane left open: (1) WebRTC from proxied pages reaches the network directly — prove a kill switch in proxied windows and in the engine-host realm against escaped code; (2) popups opened by escaped code escape the sandbox — test the engine host WITHOUT allow-popups / allow-popups-to-escape-sandbox, with window.open routed through an engine-host → app tab-open message, and record what breaks (e.g. OAuth-style popups); (3) Chromium's speculative preconnect for tab-frame navigations the engine-host CSP blocks; (4) the dev two-port loopback setup, where the proxy origin shares the app host's cookie jar because cookies are not port-isolated: which app cookies can a proxied page read or send, and do the app's CSRF/Origin checks stop credentialed requests to the app API, including simple form POSTs without custom headers? Use the real gnome-server as the app for (4) (build with CARGO_TARGET_DIR=${TGT}/attack; the backend is being changed right now, so retry if it doesn't compile; never edit backend files) and confirm the cookies it sets in production carry no Domain attribute.
For each attack record: works / blocked / partially, evidence, severity, and the concrete mitigation (engine-host code, SW logic, CSP/Permissions-Policy, sandbox flags, backend behaviour).
Write docs/research/spike-engine-host-attack.md (attack table + mitigations + requirements for Wave B's engine host and the backend). You own tests/e2e/spike-engine-host/** (shared with spike-verify) and that file. Stop all processes.
Report every finding with severity; fixed=true only when the harness now demonstrates a working mitigation; list the rest in remaining_issues and the requirements in interfaces_for_other_teams.`

// ======================= Integration =======================
const BRIEF_FILE = `${HO}/brief-finished-11.json`

const I1 = (brief) => `${PRE}

TEAM: integration — label integrate:stack — every lane has finished; one other engineer (integrate:contracts) is fixing docs/contract mismatches at the same time (shared-file rules apply to code you both touch). Ports 24000-24999, scratch ${SP}/work-integrate, cargo uses the default target dir. You may touch any project file to fix real problems (except the fixed brand assets and services/holywisp/gnome.conf's security settings).
TASK: CROSS-LANE INTEGRATION CHECK of Wave A2 before Wave B starts. Lane summaries: the 11 steps that finished in session 3 are summarized in ${BRIEF_FILE} (full reports in ${HO}/reports/) — read it fully. The steps that finished in this session:
${JSON.stringify(brief, null, 1)}
Do NOT trust the summaries. Verify by running things:
1. Full gates: cargo clippy --workspace --all-targets -- -D warnings; cargo test --workspace (plus the ignored HolyWisp tests with HOLYWISP_BIN=${HW}/holywisp); cargo build --release (report the binary size); in frontend/: npm ci, npm run check, npm test, npm run build (report bundle sizes); in tests/e2e/: npm ci and every spike suite once in Chromium + Firefox (perf may be skipped; report pass/fail counts; distinguish flaky third-party-site failures from real ones).
2. Real two-origin stack: run HolyWisp (scratch copy of gnome.conf on a 24xxx port), then gnome-server with GNOME_STATIC_DIR=frontend/dist, an app listener and GNOME_PROXY_BIND on 24xxx ports, GNOME_WISP_UPSTREAM pointing at HolyWisp and a temp GNOME_DATA_DIR. With Playwright (Chromium + Firefox) and curl check: the app shell loads with no console errors; /api/config reports proxy.isolated=true, the proxy origin and wisp.ticket_ttl_s=3600; per-role route sets (app role: no /wisp/; proxy role: no SPA, /api/auth, /api/sync, /api/session or /api/wisp/ticket); per-role security headers (frame-ancestors, X-Frame-Options, frame-src containing the proxy origin); cookies the app sets are host-only (no Domain attribute); a ticket minted on the app origin opens a Wisp connection through the proxy origin's /wisp/ and fetches a real page, with BOTH URL forms ?t=<ticket>&/ and ?t=<ticket>/; a plain GET probe answers 426 for a valid ticket and 401 for a forged or expired one, without an Origin header; missing/forged tickets and a wrong Origin are rejected before the upgrade; the startup log shows the raised open-file limit; /api/filters lists the registry on both roles and serves a fetched list with ETag/304; /api/vpn/locations behaves with and without GNOME_VPN_PROFILES; the Settings page shows the real filter lists, VPN locations and the proxy-isolation row; register → login → settings sync → logout works through the UI; About shows the version from /api/config.
3. Cross-lane mismatches: frontend calls vs backend shapes; the proxy lane's requirements for Wave B (interfaces in the summaries, docs/research/spike-engine-host.md and docs/research/spike-engine-host-attack.md) vs what the backend serves on the proxy role today (fix small backend gaps; list the rest).
Fix every real problem you can (small, targeted fixes; re-run the affected gates). Stop every process you start. Report every finding with severity and whether you fixed it; list what remains in remaining_issues.`

const I2 = (brief) => `${PRE}

TEAM: integration — label integrate:contracts — no ports needed (if you must run something, 25000-25099), scratch ${SP}/work-contracts, CARGO_TARGET_DIR=${TGT}/contracts for any cargo command. Every lane has finished; one other engineer (integrate:stack) is running the full gates and the real two-origin stack and may fix code at the same time (shared-file rules apply).
TASK: CONTRACT & DOCS CONSISTENCY of Wave A2 before Wave B starts. Lane summaries: the 11 steps that finished in session 3 are summarized in ${BRIEF_FILE} (full reports in ${HO}/reports/) — read it fully. The steps that finished in this session:
${JSON.stringify(brief, null, 1)}
1. Every GNOME_* env var read in the code (grep backend/ and crates/) appears in docs/ARCHITECTURE.md §4.2 with the right default and meaning, and vice versa; same for backend/README.md and crates/*/README.md.
2. Every route in the routers (both roles, admin listener) appears in docs/API.md with matching request/response shapes, status codes, error codes, rate limits and per-role availability; every API.md route exists.
3. Settings keys in frontend/src/settings/schema.ts + defaults match ARCHITECTURE §5.3; frontend API calls match API.md.
4. services/holywisp/*, services/vpn/* and docs/research/mullvad-vpn.md agree with each other and with the backend's VPN profile config.
5. Spike docs: merge docs/research/spike-engine-host-attack.md into docs/research/spike-engine-host.md (as an "Adversarial isolation review" section; then delete the attack file) and make sure the main doc's requirements for Wave B are consistent; list (don't apply) the recommended ARCHITECTURE §4.6/§5.4 and ENGINE-PROTOCOL.md changes in your report.
6. docs/PROGRESS.md: update the Phase checklist items Wave A2 completed (only what the code proves), keeping the existing style; leave the "▶ RESUME HERE" section and the decisions log alone (the orchestrator maintains them).
Fix docs directly. For code-side contract mismatches, fix them only if the fix is small and local (re-run the affected tests with CARGO_TARGET_DIR=${TGT}/contracts / npm test); otherwise report them. Report every finding with severity and whether you fixed it; list what remains in remaining_issues.`

// ======================= Orchestration =======================
phase('Backend')
phase('Frontend')
phase('Proxy')

const backendLane = Promise.all([
  agent(R2, { label: 'backend:net-filters-review', phase: 'Backend', schema: REVIEW }),
  agent(B4, { label: 'backend:gateway-followups', phase: 'Backend', schema: BUILD, effort: FAST }),
])
const frontendLane = agent(F3, { label: 'frontend:pages-review', phase: 'Frontend', schema: REVIEW })
const proxyLane = Promise.all([
  agent(PV1, { label: 'proxy:spike-verify', phase: 'Proxy', schema: REVIEW }),
  agent(PV2, { label: 'proxy:spike-attack', phase: 'Proxy', schema: REVIEW }),
])

// Barrier: the integration checks need every lane's final state.
const [[r2, followups], f3, [verify, attack]] = await Promise.all([backendLane, frontendLane, proxyLane])

const pick = (r, keys) => r ? Object.fromEntries(keys.filter(k => r[k] !== undefined).map(k => [k, r[k]])) : null
const B = ['summary', 'open_issues', 'interfaces_for_other_teams']
const R = ['verdict', 'remaining_issues', 'interfaces_for_other_teams']
const missing = [['backend:net-filters-review', r2], ['backend:gateway-followups', followups], ['frontend:pages-review', f3], ['proxy:spike-verify', verify], ['proxy:spike-attack', attack]].filter(([, r]) => !r).map(([l]) => l)
if (missing.length) log(`No result from: ${missing.join(', ')} — integration runs without their summaries`)
const brief = {
  backend: { netFiltersReview: pick(r2, R), gatewayFollowups: pick(followups, B) },
  frontend: { pagesReview: pick(f3, R) },
  proxy: { verify: pick(verify, R), attack: pick(attack, R) },
  missingResults: missing,
}

phase('Integrate')
const [stack, contracts] = await Promise.all([
  agent(I1(brief), { label: 'integrate:stack', phase: 'Integrate', schema: REVIEW }),
  agent(I2(brief), { label: 'integrate:contracts', phase: 'Integrate', schema: REVIEW }),
])

return { backend: { r2, followups }, frontend: { f3 }, proxy: { verify, attack }, integration: { stack, contracts } }
