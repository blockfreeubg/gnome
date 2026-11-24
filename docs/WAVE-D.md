# Wave D module plan (performance + production)

> **Outcome (2026-11-24, lean run `wf_88dddedd-f89`).** The user asked for a quick, low-usage finish, so the wave
> ran as four steps (`d-harden` = d4, `d-ship` = d2 + d3, `d-bench` = d1a, `d-final` = §10 lean) without d1b's
> optimization loop and without the long measurement campaigns. Built: §6 M1–M3 and the audits (d-harden), §4 and §5
> (d-ship), the §3.1–§3.4 harness with one dev-smoke run (d-bench), and the §10/§11 integration with
> `START-GUIDE.md` (d-final). Where the code differs from this plan, the lane reports say why; the main points are in
> PROGRESS's decisions log (rows of 2026-11-24): D10 settled as minify only; a bad sync cursor answers 400, not 422;
> a quota-stopped kind retries after any local change; untrusted heads over 64 KiB get an exact 431; reproducibility
> uses the default builder with `--no-cache` (no privileged BuildKit); `Origin-Agent-Cluster` not adopted; the deploy
> suites (DC/DP/OP), the P-rows, CF5–CF8, the record run, the allocator check and D12 were not done. Everything open is
> listed in PROGRESS "Deferred items" ("Wave D open items").

> Status: plan for Wave D, written 2026-11-18 (`wave-d:plan`, doc-only) while the UI restyle's final gate was running,
> before Wave B step 2's integration part 2, Wave B step 3 and Wave C. It builds on the code as it stood that evening:
> the Rust workspace (`Cargo.toml`: release profile `lto = "fat"`, `codegen-units = 1`, `strip = true`,
> `panic = "unwind"`), the static index with precompressed siblings (`backend/src/static_files.rs`), the Wisp gateway
> and its `splice(2)` relay (`backend/src/gateway/**`), the accept loops and hardened automatic answers
> (`backend/src/server.rs`), the frontend build (`frontend/{package.json,vite.config.ts,vite.sw.config.ts}`,
> `frontend/scripts/copy-vendor.mjs`), the HolyWisp packaging (`services/holywisp/**`) and the VPN recipes
> (`services/vpn/**`). Re-read every file named here before editing it: part 2, step 3 and Wave C change details.
> Inputs: the user's product brief (Rust performance, code protection and lightweight distribution, performance
> targets, security/production, delivery), `docs/PROGRESS.md` (Phases 7–9, the "Deferred items (to schedule in Wave
> D/E)" list, which binds this plan, and the decisions log), `README.md` ("Production notes", "Turning on every
> feature"), `docs/ARCHITECTURE.md` §3, §4 (§4.2 env table, §4.4, §4.6), §8, §9, `backend/README.md`,
> `services/holywisp/README.md` (+ its Dockerfile, units, `fetch-build.sh`, `tests/syscalls.sh`),
> `services/vpn/{README.md,compose.example.yml}`, `docs/research/holywisp.md` §8, `docs/WAVE-B3.md` §2, §10, §13 and
> `docs/WAVE-C.md` §1–§3 (both define who owns which file while this wave may run).
> Plan-fix 2026-11-19 (`wave-d:plan-fix`): the findings of the security/operations and the completeness reviews are
> applied (each rejected or deferred finding is named with its reason in §12 or in the decision it touches). Before
> Wave D starts, the orchestrator confirms D10 (no obfuscation) with the user and enters the (log) rows of §1.

Wave D makes GNOME measurable and deployable. It ships what the README still lists as "not built" for production:
benchmarks of the Rust backend and HolyWisp against Node.js baselines with the optimizations the numbers justify, the
production build pipeline (precompressed assets, no public source maps, budgets, third-party notices, a reproducible
release with checksums), the deployment files for `gnome-server` (Docker image, a compose file for the whole stack, a
Caddy configuration, a systemd unit, Raspberry Pi 4 notes, an operations guide), dependency audits, and the deferred
hardening items (connection caps, the cookie-flood decision, the reverse proxy's own error pages, the per-account sync
quota, the history byte budget, bookmark paging). Four lanes build it: **d1** benchmarks + optimization, **d2** build
pipeline + release, **d3** deployment, **d4** security hardening + audits. Each lane has an **a** part that owns only
new files and runs beside Wave B step 3 and Wave C, and a **b** part that edits files another wave owns until that
wave's integration step (§2).

Measured for this plan (2026-11-18, this machine: AMD Ryzen 5 5600G 6C/12T, 15 GB RAM, Linux 7.3.1-cachyos, Node
26.13, Rust 1.99.1; scripts in the session scratchpad `work-wave-d-plan/scripts/`, throwaway): the restyled release
build (`ui:final`'s `dist/`) is 29.2 MiB in total, of which 5.0 MiB are 15 vendored `.map` files (Scramjet 3.8 MiB,
Ultraviolet 1.2 MiB, the Scramjet controller 0.1 MiB); its text files without maps are 21.8 MiB raw, 8.9 MiB as gzip -9
and 7.2 MiB as brotli 11. The app's startup set (`index.html`'s scripts, module preloads and style sheets, 33 files)
is 154.2 KB gzip / 134.5 KB brotli (JS 138.9 KB + CSS 15.3 KB gzip; 106.6 KB of JS before the restyle); the engine
host's own startup JS is 55.2 KB gzip and the unmodified engine scripts it loads at start another 208.9 KB gzip. The
glibc release binary `target/release/gnome-server` of 2026-11-18 is 10,535,736 bytes; `cargo tree -p gnome-server -e
normal` lists 167 crates. No benchmark, profiling or audit tool is installed (no oha, wrk, cargo-deny, cargo-audit,
cargo-bloat, strace, perf); Docker 29.9 with buildx is; `kernel.perf_event_paranoid` is −1, so a user-space sampling
profiler (samply) works without root.

## 0. Rules for every lane

- **Product rules** (decisions log; non-negotiable): GNOME is a website only; Rust for the backend only; the frontend
  stays TypeScript + Svelte 5; Scramjet, Ultraviolet, bare-mux and the transports stay JavaScript and are served
  **byte for byte as their packages ship them** (never bundled, minified, rewritten or obfuscated; their licenses and
  attribution stay with them); HolyWisp stays the C Wisp server at its pin; nothing is claimed without a measurement
  or a test; no privileged container in any deliverable; the admin listener is never public.
- **Benchmark-only code is not product code.** The Node.js baselines (`bench/node/`, decisions log 2026-11-09: "Node.js
  used only as a benchmark baseline"), the pinned wisp-js server (`bench/wispjs/`) and the load generator
  (`bench/loadgen/`, Rust, its own Cargo workspace) are never built into a release, an image or `dist/`, and nothing
  in the product imports them. The load generator is a measuring tool like the e2e runner, not a GNOME component.
- **Host safety.** No `--privileged`, no systemd in Docker, no host `/proc/sys` or `/sys` mounts, no `docker.sock`
  mounts, no sysctl, no kernel modules, no `sudo`, and **no binfmt_misc registration**: arm64 code runs only under
  QEMU user-mode *inside* a build container, as `services/holywisp/` does (a session-1 agent's privileged container
  rewrote the host's binfmt entries and `kernel.core_pattern`). Containers run with `--cap-drop ALL
  --security-opt no-new-privileges` and a read-only root unless a row says otherwise; `--network host` is allowed only
  for the e2e Caddy front and the benchmarks (both unprivileged), `--network none` wherever nothing needs the network.
  systemd units are checked with `systemd-analyze verify`, `systemd-analyze security --offline=true` and syscall traces
  in unprivileged containers (`services/holywisp/tests/syscalls.sh` is the pattern); they are never booted here.
- **Loopback only.** This machine is shared and its LAN is not trusted. Every listener a Wave D benchmark, suite or
  script starts binds `127.0.0.1` (or `::1`), never a wildcard: gnome-server with `GNOME_BIND`, `GNOME_PROXY_BIND`
  and `GNOME_ADMIN_BIND` = `127.0.0.1:<lane port>` (the admin default 9091 collides with other agents' servers; empty
  where no row needs it), the Node baseline and wisp-js with `listen(port, '127.0.0.1')`, the loadgen echo on
  `127.0.0.1`, test Caddy with `CADDY_BIND=127.0.0.1` and `admin off` (DC6 alone uses a Unix admin socket in the
  scratch directory, mode 0600, never a TCP port), images published only as `-p 127.0.0.1:<p>:<p>`, QEMU and trace
  containers with `--network none`. `bench/lib/servers.mjs` and `deploy-lib.mjs` enforce it: after every start they
  list the started processes' listening sockets (`ss -ltnpH`, or `/proc/<pid>/net/tcp{,6}` with the process's socket
  inodes) and abort the run, stopping everything, when one is not on `127.0.0.1` or `::1`; `deploy-lib.mjs` refuses
  to start Caddy when `CADDY_BIND` is unset. Reason: the bench runs HolyWisp with loopback destinations allowed and
  gnome-server with rate limits off; on a wildcard address any LAN host could open Wisp streams to every loopback
  service of this machine.
- **Machine etiquette.** Cargo with the lane's own `CARGO_TARGET_DIR=~/.cache/gnome-targets/wave-d-<lane>` and
  `CARGO_BUILD_JOBS=3`; Docker builds of `deployment/Dockerfile` pass `--build-arg CARGO_BUILD_JOBS=3` (BuildKit's cargo
  would otherwise use all 12 threads). The host's Rust is Arch's package (rustc 1.99.1, target
  `x86_64-unknown-linux-gnu` only, no rustup, no musl toolchain): every static musl build (D6, B1, R1, the runtime
  budgets, SD1, the artifacts) comes from d3a's Dockerfile target `server-out`; until that target exists d1's numbers
  are glibc builds, labelled so. Tools are installed per user into `~/.cache/gnome-tools/<tool>-<version>/` (`cargo
  install --locked --version <v> --root <dir>`, pinned images by digest), never system-wide. Ports come from the
  lane's range (§0, last item). Benchmark **record runs** happen only in a quiet window the orchestrator grants (no
  other workflow running, §3.4); development runs may happen at any time but are never quoted in a document.
- **No internet from test servers.** Every gnome-server a Wave D benchmark, suite or script starts sets
  `GNOME_FILTERS_REFRESH_HOURS=0`, `GNOME_CATALOG_REFRESH_HOURS=0` and `GNOME_OSS_FETCH=manual` (the values Wave C's
  runner uses; unknown variables are ignored by older snapshots), unless a row needs the network and says so.
- **The About crate list.** `npm test` runs `src/pages/about/licenses.test.ts`, which compares About's generated Rust
  crate list with `Cargo.lock` and `cargo tree`. Any Wave D step that changes `Cargo.lock` regenerates that list in
  the same step (`node frontend/scripts/rust-crates.mjs`), as WAVE-C §0 requires; only d1b changes `Cargo.lock` and it
  owns the generated block for that reason (§2.1, §2.2).
- **One working tree, no git** (as in Waves B and C): edit only the files your lane owns (§2.1) and only in the
  window §2.2 gives; no stub modules in another lane's paths; land changes in small compiling steps; every increment
  keeps `cd frontend && npm run check && npm test` green and, for Rust changes, `cargo test --workspace --locked`,
  `cargo clippy --workspace --all-targets --locked -- -D warnings` and `cargo fmt --all --check`. A lane that needs a
  change in another lane's file writes the exact diff and the reason in a change request (`report.change_requests`);
  the owner applies it within its next step, or the Wave D integration step does.
- **Documents.** The shared documents (`README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `backend/README.md`,
  `docs/PROGRESS.md`, `tests/e2e/engine/README.md`, `services/*/README.md`) are edited **only by the Wave D integration
  step** (§11), because Wave C's integration edits them too. Lane-owned new documents are the exception:
  `docs/BENCHMARKS.md` and `bench/README.md` (d1), `docs/DEPLOYMENT.md` and `deployment/README.md` (d3),
  `docs/AUDIT.md` (d4), and this file (the plan-fix step). Each lane's report carries the exact rows and paragraphs the
  integration step must add to the shared documents.
- **Numbers.** Every number in a document names the machine, the build (path, profile, target), the command and the
  date. Estimates say "estimate" and their basis. Raspberry Pi 4 numbers are estimates until measured on a Pi (§5.6).
  A test that disproves a statement of this plan changes the plan through the lane's report; the code never ships as
  if the statement held.
- **Ports** (the orchestrator may move them): d1 17000–17299, d2 17300–17399, d3 17400–17699, d4 17700–17899, the
  Wave D integration step 17900–17999. They stay below Linux's outgoing range (32768–60999 here; PROGRESS: "Ports now
  stay below 32768"), so W3/W4's tens of thousands of outgoing loopback connections and the browsers cannot hold a
  port a later listener needs, and they overlap neither part 2's 23000–27999, the runner's default `E2E_PORT_BASE`
  27500 (+0…+229) nor Wave B's 28000–29999. Suites take their base from the environment (`BACKEND_E2E_PORT_BASE`
  for standalone suites under the runner, as `backend-https.mjs` does).

## 1. Decisions this plan settles

Rows marked (log) go into the PROGRESS decisions log when Wave D starts.

| # | Decision | Why |
| --- | --- | --- |
| D1 (log) | **When Wave D runs.** The **a** parts of all four lanes start on Wave B step 3's day one, beside step 3 and Wave C (they own only new files, §2.3), after step 2's integration part 2 has finished (part 2 rebuilds and reruns everything in `frontend/` and `tests/e2e/`). **d2b** starts after step 3's integration step (lane x1 owns `frontend/package.json`, its lock, both Vite configs and `tests/e2e/engine/suites/build.mjs` until then). **d1b, d3b, d4b** start after Wave C's integration step and its review fixes (Wave C's lane g1 owns `Cargo.toml`, `Cargo.lock`, `backend/Cargo.toml` and `backend/src/{lib,config,module,server,router,cli,static_files}.rs`, `security/{csp,headers,rate_limit}.rs` until then; WAVE-C §2.1). d2b has a second window after Wave C's integration for the startup-set work of §4.6. Benchmark record runs wait for quiet windows; §3.4 states how many hours of them the wave needs. The Wave D integration step follows the four b parts | Disjoint files are the only way three waves share one working tree; optimizations need a fixed "before" (baseline-1 = the tree after Wave C's integration), or Wave C's changes would be counted as Wave D's effect |
| D2 (log) | **Baselines.** The Node baseline is `bench/node/`: one Node 26 program using only built-ins (`node:http`, `node:net`, `node:crypto`, `node:zlib`, `node:fs`, `node:cluster`) that implements gnome-server's three hot paths with the same rules: the `/wisp/` gateway (Origin, HMAC ticket, per-IP/per-session caps, the reconstructed upgrade, the `101` relay, then `pipe()` both ways), static serving (the same index rules, strong ETags, `.br`/`.gz` negotiation, `304`, the same cache and CSP headers) and the session/ticket API (anonymous HMAC session cookie, CSRF header, `POST /api/wisp/ticket`, `GET /api/config`, `GET /api/session`). It runs as one process and as a 4-worker cluster. The Node Wisp server baseline is the pinned `@mercuryworkshop/wisp-js` server (`bench/wispjs/`). HolyWisp alone is the floor. The comparison is between stacks: gnome-server + HolyWisp, Node gateway + HolyWisp, Node gateway + wisp-js, HolyWisp direct, wisp-js direct. Before any timing, `bench/run.mjs --check` proves that the Node baseline answers a fixed request list like gnome-server (status and every response header except the values of `Date` and `x-request-id`, ETag form, `TCP_NODELAY` on both legs of both gateways) and that both gateways deliver identical byte streams (echo checksums). The baseline is written against baseline-0 and **re-synced to the tree after Wave C's integration before the baseline-1 record run** (Wave C's route-bound `w2` tickets with mint time, the route refusals, the 15 s session re-check, the new app headers; WAVE-C D3, D23), §3.2 | The decisions log (2026-11-09) promises an equivalent Node implementation of the hot paths and wisp-js; "equivalent" must be checked, not asserted; built-ins only keeps the baseline idiomatic and free of supply-chain noise |
| D3 | **Load generators.** Wisp traffic comes from `bench/loadgen` (Rust; its own `[workspace]` and `Cargo.lock`, never shipped): a WebSocket client that sends `Origin` and the ticket URL, speaks Wisp v1 (CONNECT, DATA, CONTINUE flow control, CLOSE) and has the modes `tp` (bulk), `rtt` (64 B ping-pong), `churn` (connections or streams per second), `idle` (hold N connections) and `echo` (a counting TCP echo on loopback), with HDR histograms. HTTP load comes from `oha` (pinned, `cargo install --locked`). HolyWisp's own `bench/pump` (pinned source) may cross-check the direct-HolyWisp numbers against upstream's | No load tool is installed; HolyWisp's `pump` cannot send `Origin` or a ticket, which the gateway requires; a Node client tops out near the numbers being measured (upstream measured the wisp-js client at 1,156–2,551 MiB/s, research §8), which would hide differences between the servers |
| D4 | **Method** (§3.4): server processes on 4 dedicated physical cores (`taskset`, SMT siblings left idle where the topology allows; `GNOME_WORKERS=4`, HolyWisp `workers = 4`, Node cluster 4 workers: the Raspberry Pi 4 has 4 cores), the load generator on the other cores; a quiet gate before every repeat; 5 s warm-up, 20 s measured, 5 repeats for budgeted cells and 3 for the rest, configurations interleaved; medians with the interquartile range; a change is significant only when medians differ by more than max(3 %, the larger IQR); `run.mjs --plan` prints cells × repeats × time before a run starts | The machine is shared with other agents; interleaving and the gate turn background noise into visible spread instead of bias |
| D5 (log) | **Release profile.** Keep `opt-level = 3`, `lto = "fat"`, `codegen-units = 1`, `strip = true`, `debug = false`, `incremental = false` and **`panic = "unwind"`** (measure `panic = "abort"`'s size difference once and record it; a panicking request stays contained). No `target-cpu` (one binary per architecture runs on every CPU of it). Release builds (`scripts/release.sh`, `deployment/Dockerfile`) add `--remap-path-prefix` for the source tree, `$CARGO_HOME` and the rustc sysroot, so binaries carry no build paths or user names. Profiling uses environment overrides (`CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=none`), not a new profile | ARCHITECTURE §8 already justifies unwind; panic messages embed absolute source paths (privacy, reproducibility) |
| D6 (log) | **Allocator.** The system allocator stays unless measured otherwise: on the static musl release build, if `mimalloc` beats musl's allocator by ≥ 10 % on H1/A1 throughput or p99 latency **and** its RSS in R1 and W4 is not worse by more than 5 % (RB1 and RB3 still met), or it beats it by ≥ 15 % on RSS in W4 without losing throughput, it becomes the allocator **of musl targets only** (`[target.'cfg(target_env = "musl")'.dependencies]` + `#[global_allocator]` in `main.rs`); glibc builds keep the system allocator. jemalloc is not considered: its page size is fixed at build time and such builds fail on 16 KiB-page arm64 kernels (Raspberry Pi 5's default; documented upstream issue, not measured here) | Release binaries are static musl (D14), whose allocator is known to be slow under multi-threaded allocation; the rule makes the choice a measurement |
| D7 | **Dependency trimming.** A crate or feature is removed only with evidence (`cargo bloat --release --crates`, `cargo tree -i`) and green tests; the candidates are in §3.6; nothing is removed for less than 64 KiB of binary unless it also removes a supply-chain item (a crate that reads the system's certificate store, a C dependency, a duplicate) | "Remove unnecessary dependencies" with numbers, not taste |
| D8 (log) | **Precompression.** `frontend/scripts/postbuild.mjs` writes `.br` (brotli quality 11, window 24) and `.gz` (gzip level 9) siblings for every text file of `dist/` (`.js .mjs .css .html .json .svg .webmanifest .txt .wasm`, `LICENSE*`) of at least 1 KiB whose sibling saves at least 10 %, except `engine/*.html` (templated, gnome-server never serves their siblings) and `.map` files; in **release** builds files under `vendor/` get only the `.br` sibling (every HTTPS browser accepts brotli; a client that asks only for gzip gets the identity file, which `static_files.rs` already handles), GNOME's own files get both; Node's built-in `zlib` only (no new dependency); every sibling is decompressed and compared with its file before the step succeeds; output is deterministic. gnome-server already serves the siblings (`static_files.rs`) | Measured: the text files compress from 21.8 MiB to 7.2 MiB (brotli) / 8.9 MiB (gzip), of which 8.5 MiB of gzip copies are vendor files (`ui:final` dist, gzip -9: vendor 8,711 KiB of 9,080 KiB), so the vendor rule keeps 8.5 MiB out of every image and artifact. Brotli is what HTTPS browsers ask for; gzip serves fronts and clients that ask only for gzip |
| D9 (log) | **Source maps.** GNOME's own code never has source maps in any build (`sourcemap: false` today; release row BR1 proves it, including no `sourceMappingURL` comment in GNOME's files). The vendored engines' `.map` files (15 files, 5.0 MiB) are **left out of release builds and images** and kept in development and e2e builds. The engines' files stay byte-identical, so their `sourceMappingURL` comments point at a `404`, which browsers request only while DevTools is open. License compliance relies on the verified upstream revisions and the third-party source archive (D27), not on maps | The brief: "keep source maps out of public production deployments"; the maps describe public upstream code, so dropping them costs nothing and saves 5 MiB per image |
| D10 (log; **needs the user's confirmation before Wave D starts**, because it drops an item of the brief) | **No obfuscation.** GNOME is AGPL-3.0-only (`Cargo.toml` `license`, the About page; the integration step adds the missing decisions-log row "GNOME's own code is AGPL-3.0-only") and has no proprietary code. Obfuscated JavaScript would be object code: allowed only together with the Corresponding Source, which AGPL §13 offers to every user of the service, so it would protect nothing while adding bytes, CPU and a build dependency. Wave D ships **minification only** (Vite/rolldown's minifier with identifier mangling, as today). `obfuscate.mjs` (ARCHITECTURE §3) and `GNOME_OBFUSCATE` (§8) are removed from the documents, and the README's "opt-in obfuscation" text with them. Third-party code is never obfuscated. If the user still wants obfuscation, it becomes an opt-in step limited to GNOME's own chunks that ships together with the Corresponding Source offer (D27), never on vendored code | The brief asks to obfuscate "proprietary application code where appropriate" and never "at the expense of functionality"; there is no such code, and minified code already loses names and comments |
| D11 (log) | **Third-party notices.** Release builds carry `dist/licenses/THIRD-PARTY-NOTICES.txt` (served on the app origin as a plain file): every `node_modules` package whose code is in GNOME's chunks, its Vite worker bundles or `sw.js` (from the chunk graphs, which d2b makes every build write: main, `worker.plugins` and `vite.sw.config.ts`), with its name, version, repository, npm tarball URL and license text, plus the fonts' OFL texts. The release artifact carries the full bundle (§4.4): Rust crates for the union of the release targets, the Rust standard library's notice (`std`, `core`, `alloc`: MIT OR Apache-2.0) and musl's `COPYRIGHT` for gnome-server's static binary (neither appears in `cargo tree`), npm packages, the vendored engines' `LICENSE` and `THIRD-PARTY-LICENSES.txt` (copied unchanged), HolyWisp (ISC) and its musl (MIT), SQLite's public-domain notice, the fonts, GNOME's AGPL-3.0 text and the source offer; a root `LICENSE` (the AGPL text) is added to the tree | MIT, ISC, Apache-2.0 and OFL-1.1 require their notices to accompany copies; minified chunks drop license comments |
| D12 | **Images.** Only lossless, pixel-identical recompression of GNOME's own derived PNGs (`frontend/public/brand/**`, `brand-v2/**`), applied once and committed, only if it saves ≥ 10 KiB in total; `logo.png` is never touched (decisions log 2026-11-09); WebP/AVIF files are left as they are. A first-load image budget applies (§7) | The images on first load are a favicon, the mark and the wallpaper (≈ 30 KB); the rest are PWA icons and the v1 mark (≈ 1 MiB in `dist/`) |
| D13 (log) | **Release artifact.** `scripts/release.sh` builds, from one source tree, `gnome-<version>-linux-<arch>.tar.gz` for `x86_64` and `aarch64` (static musl `gnome-server`, HolyWisp at its pin, the release `dist/`, example configuration, the licenses bundle, `BUILDINFO`, an inner `SHA256SUMS`), plus `gnome-<version>-src.tar.gz` (the Corresponding Source, built from an **allow-list** of source paths and deny-scanned for secrets, §4.5), `gnome-<version>-third-party-src.tar.gz` (D27; on by default for a published release) and an outer `SHA256SUMS`, signed with `--sign <key>` (an SSH key file or a GnuPG key id) into `SHA256SUMS.sig` (OpenSSH 10.6 `ssh-keygen -Y sign` and GnuPG 2.4.9 are installed here; the key and its policy are the maintainer's; an `allowed_signers` file is committed once a key exists). Reproducible by construction: `GNOME_BUILD_ID=<version>+<first 12 hex of the source tarball's SHA-256>`, `SOURCE_DATE_EPOCH` from the newest allow-listed source file, `--remap-path-prefix`, `umask 022`, sorted tar members with fixed owner, mode and mtime, `gzip -n`, the Alpine build packages recorded and checked against pins; `--verify-reproducible` builds a second time in a separate directory **without any cache** (a throwaway buildx builder with `--no-cache`, `fetch-build.sh --no-cache`, fresh cargo and npm caches) and compares the checksums | The brief: "a reproducible release ... versioned artifact with checksums and a third-party licenses bundle"; the AGPL source offer needs the exact source of what runs |
| D14 (log) | **gnome-server image.** Multi-stage `deployment/Dockerfile`: the frontend built once on the build platform, `gnome-server` cross-compiled per target as a **static musl** binary with clang through `tonistiigi/xx` (as `services/holywisp/Dockerfile` does, so `linux/arm64` builds on an amd64 host without binfmt), arm64 binaries checked under QEMU user-mode inside the build stage, runtime `FROM scratch`: the binary, the release `dist/`, the licenses, an empty `/tmp`, `/var/lib/gnome` (a volume), `USER 65532:65532`, no shell. Run read-only with a tmpfs `/tmp` | The smallest image that runs one static binary; the same build recipe produces the artifact's binaries (§4.5), so the image and the release cannot drift |
| D15 (log) | **Compose topology.** `caddy` (the only service with published ports, 80 and 443; `edge` is dual-stack with a ULA IPv6 subnet so IPv6 clients keep their address instead of arriving as the bridge gateway through `docker-proxy`; every service has `mem_limit` and `pids_limit`) → `gnome` (app listener `:8080`, proxy listener `:8081` via `GNOME_PROXY_BIND`, network `edge`) → `holywisp` (its own container on network `wisp`, started with `--host 0.0.0.0 --trusted-proxy <gnome's wisp address>/32`); fixed addresses so `GNOME_TRUSTED_PROXIES` names Caddy alone; the VPN egress of `services/vpn/` recipe A is an optional override file, `deployment/compose.vpn.yml` (not a Compose profile, §5.2). The admin listener stays on the `gnome` container's loopback and is reached with `docker compose exec gnome gnome-server admin get /admin/diagnostics` (§5.5); nothing else is published | HolyWisp in its own network namespace survives a `gnome` restart (a shared `network_mode: service:gnome` namespace disappears when its owner restarts); the Wisp port has no authentication, so only the gateway may reach it; an admin listener bound only to the container's loopback cannot be routed by mistake |
| D16 (log) | **Caddy** (the deferred reverse-proxy item). Two site blocks; global `servers { max_header_size 4MB }`, above what browsers send (Chromium's 2 MiB URL limit plus ≈ 740 KB of cookies, D19), so Caddy never writes a `431`/`400` of its own for a browser request and gnome-server's hardened answers apply; `handle_errors` on both hostnames gives every answer Caddy writes itself (`502`/`503`/`504` when gnome-server is down) `Content-Security-Policy: default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`; `protocols h1 h2` (HTTP/3 stays off until a row covers it); no `encode` (static files come precompressed); Caddy's default `X-Forwarded-*` handling; `request_header -Cookie` on the proxy hostname (no proxy-role route reads a cookie: Wisp authenticates with `?t=` tickets, `/engine/`, `/vendor/` and Wave C's `/oss/` are static), so a cookie flood never reaches the proxy listener; upstream `dial_timeout 3s` and `response_header_timeout 35s` (longer than gnome-server's 30 s request timeout), so a full or stopped gnome-server gives Caddy's strict `502`/`504` instead of a hang; Caddy's logger filtered (no client address, no headers, the URI reduced to its path, so no `?t=` ticket is logged) and access logs off; Caddy runs **non-root without capabilities** (a three-line derived image owns `/data` and `/config` and drops the binary's file capability; internal ports 8080/8443 mapped from 80/443; explicit `http://` redirect sites because the internal HTTPS port is not 443) | Go's HTTP server answers oversized heads before any Caddy handler runs, so `handle_errors` cannot add a policy to them: the limit is the only fix for those; a policy-less same-origin document on the proxy hostname is a permissive realm (ARCHITECTURE §4.6) |
| D17 (log) | **systemd unit for gnome-server** (`deployment/systemd/gnome-server.service`): `DynamicUser=yes`, `StateDirectory=gnome` (the data dir), `LimitNOFILE=65536`, the admin listener on `127.0.0.1:9091`, secrets through `LoadCredential=` and the `_FILE` variables (D23), `ExecStartPre=gnome-server config check`, `RestartPreventExitStatus=2`, `TimeoutStopSec=20s`, the sandbox of `holywisp.service` adjusted to what a syscall trace of gnome-server shows (`AF_UNIX` is needed: tokio's signal driver and the splice probe use socket pairs), `SocketBindAllow=` for the configured ports only; the admin-token credential is part of the documented first install (without a token any local user can read `/admin/diagnostics` and refresh filter lists); every key's minimum systemd version is stated (`SocketBind*` 249, `RestartSteps`/`RestartMaxDelaySec` 254; Debian 12 and Raspberry Pi OS bookworm ship 252); checked statically with systemd 262 and with Debian 12's 252 (§5.4) | The deferred item asks for `LimitNOFILE=`; the HolyWisp units set the hardening bar |
| D18 (log) | **Connection caps** (deferred item). `GNOME_MAX_CONNECTIONS` (default 4096, 16–1,000,000): connections on the public and proxy listeners together; at the cap the listeners keep accepting from the 512-descriptor reserve, answer the hardened `503` with `Retry-After: 1` and close (at most 256 such answers at once; beyond that the loops pause, and only then does the kernel's backlog hold connections), so a front behind which gnome-server is full fails fast instead of hanging; the admin listener has its own cap of 64, so operators always get in. At startup the effective cap is lowered to (soft `RLIMIT_NOFILE` − 512) ÷ 6 when the descriptor limit cannot carry it (logged, `/admin/diagnostics` `connections`). `GNOME_MAX_CONNS_PER_IP` (default 256, per IPv4 address or IPv6 /64) applies at accept to peers outside `GNOME_TRUSTED_PROXIES` and closes the excess at once. `GNOME_MAX_INFLIGHT_PER_IP` (default 256) bounds concurrent HTTP requests per client address as `ClientInfo` resolves it (the real client behind a trusted proxy): beyond it `503 unavailable` + `Retry-After: 1`. **IPv6 prefix tiers**: the per-client Wisp-connection and in-flight caps also apply per /56 at 4× and per /48 at 16× the /64 limit (an attacker with a /48 cannot fill the Wisp share with idle connections), the refusal naming the tier. Wisp upgrades are refused with `429 too_many_connections` once Wisp connections reach 90 % of the effective cap, so plain HTTP keeps headroom. Metrics `gnome_http_connections_refused_total{reason}` and `gnome_http_inflight_refused_total` | Behind a reverse proxy every TCP peer is the proxy, so a per-IP cap at accept protects only direct exposure; the in-flight cap is the per-client bound there. 4096 connections × 6 descriptors (a spliced Wisp connection: two sockets plus two pipes of two descriptors each) fit `LimitNOFILE=65536`; the kernel's per-user pipe budget (`fs.pipe-user-pages-soft`, 16384 pages here: 1,024 pipes of 64 KiB, then 8 KiB pipes) binds earlier than descriptors, which §3.3 measures and O9 addresses. The default `GNOME_MAX_INFLIGHT_PER_IP` stays 256 (a review proposed 64): the app's startup set is 33 parallel requests, so 64 would refuse users who share one NAT address; memory is bounded by D19's head budget instead |
| D19 (log) | **Cookie flood across the origin boundary** (the deferred Wave D decision): **sibling hostnames stay the supported default and gnome-server tolerates the flood.** (1) **App listener**: request heads up to **1 MiB on connections whose socket peer is in `GNOME_TRUSTED_PROXIES`** (the reverse proxy, which forwards complete heads it has already bounded; loopback by default, which covers development); other peers keep 64 KiB (§6.3: every deployment that serves browsers beyond localhost needs a TLS front, which must be trusted for `X-Forwarded-Proto` anyway). **Proxy listener**: 64 KiB for every peer except loopback peers (development's two ports on one host share every cookie; route B's local Caddy strips cookies anyway); the shipped Caddyfile removes `Cookie` on the proxy hostname, which needs none (D16). **The admin listener** keeps 64 KiB. Hyper's `414` for request targets of 64 KiB or more and the hardened automatic answers of `server::ConnIo` are unchanged, so a head over the limit still gets the strict `431`. **Wisp upgrades** whose head exceeds 64 KiB are refused with the hardened `431` unless the socket peer is loopback (development's flooded cookies reach the proxy port too), and the relay releases hyper's read buffer (`client_rest`) once it is written upstream, so no upgraded connection keeps a head buffer for its lifetime (hyper hands the upgraded connection over with `read_buf.freeze()`, which shares the allocation the head was split from; `relay.rs` held it until the connection ended). A browser cannot send more cookies than its per-domain limits allow (Chromium and Firefox keep at most 180 cookies of ≤ 4,096 bytes per registrable domain: ≈ 740 KB; row CF1 measures what each browser really sends; WebKit only where a Playwright WebKit build runs here), so planted cookies no longer make GNOME unusable. (2) GNOME's session cookies get `Priority=High` (Chromium evicts lower-priority cookies first when a domain passes 180; row CF3). (3) In two-origin mode the app removes foreign cookies at start and every 5 minutes (§6.4), but only host-only cookies and cookies of domain levels at or below the longest common parent of the app and proxy hostnames that is not the registrable domain (for `gnome.example.com` + `p.gnome.example.com`: `gnome.example.com`); `Domain=<registrable domain>` cookies, which other sites of the operator legitimately set, are cleared only when `document.cookie` exceeds 32 KB or the operator opts in (`/api/config` `proxy.cookieHygiene`). (4) **Memory is bounded by bytes, not by request counts**: a request whose head exceeds 64 KiB needs room in a global large-head budget (`GNOME_MAX_INFLIGHT_HEAD_MB`, default 64; a head counts twice its size, because hyper may overshoot by one read) and is one of at most 4 such requests per client key; without room it gets the hardened `503` with `Retry-After: 1` at once. The in-flight cap alone would allow 4096 × 2 MiB = 8 GiB, far above the stack's `mem_limit` (row CF5 measures RSS under the attack shape). (5) A proxy hostname on a **separate registrable domain** stays a supported option, never the default. It stops the flood in the browser and puts the engine host in another renderer process, but it partitions all engine state under the app's site (spike §8.1, measured 2026-11-11) and needs a second domain. The sibling default has security costs of its own, which `docs/DEPLOYMENT.md` "Choosing hostnames" lists next to the option's costs: SameSite gives the app's cookies no protection against proxied pages (only the CSRF header and the absence of CORS do); Chromium's site isolation locks app and engine host into one renderer process, so a renderer exploit or Spectre-class leak in a hostile proxied page reaches the app origin's data without crossing a process boundary (row CF7 records it, with and without `Origin-Agent-Cluster: ?1`, which d4b adopts if it separates them at no functional cost); the `__Host-` cookie names depend on a trusted `X-Forwarded-Proto` (§6.3). Rows CF6 measure the option in Chromium with third-party cookies blocked and with its default settings (storage partitioned), Chromium Incognito, Firefox `network.cookie.cookieBehavior` 1 and 5 and a private window, and Playwright WebKit where it runs here (recorded as WebKit, not Safari); `docs/DEPLOYMENT.md` lists what breaks in which browser | The development topology (two ports on one host) shares every cookie, and single-domain operators have no second registrable domain, so the server-side tolerance is needed in every topology; the cross-site option alone fixes neither; the per-IP caps (D18) are the precondition the lane-e review named, and the byte budget is what actually bounds memory behind a front |
| D20 (log) | **Per-account sync storage quota** (deferred item). `GNOME_SYNC_QUOTA_MB` (default 64, 1–4096). Stored bytes per account = Σ over its bookmarks and history rows of (URL + title + ids + 64 bytes) (a tombstone counts 64) + the settings document; kept exact by SQLite triggers in the new append-only migration `database/migrations/0002_sync_quota.sql` (one byte column per kind on `users`, backfilled; §6.5). History uploads are never refused: after a batch the server deletes the account's oldest visits until it fits (as it already keeps the newest 100,000). A bookmark or settings upload that would grow the total past the quota is refused whole with **`413 quota_exceeded`** (one that does not grow it always applies, so an account over a lowered quota can shrink) (`used_bytes`, `quota_bytes` in the error body); the client stops that kind's sync and shows "Sync storage on this server is full". `GET /api/sync/usage` → `{used_bytes, quota_bytes, history_bytes, bookmarks_bytes, settings_bytes}`. A **server-wide cap** `GNOME_SYNC_TOTAL_MB` (default 1024, 16–1,048,576) is kept exact from the same columns through a one-row aggregate maintained by the same triggers: growth past it gets `413 quota_exceeded` with `"scope": "server"`, and history batches are then refused rather than trimmed. `.env.example` and `gnome.env.example` set `GNOME_REGISTRATION=closed` with a comment, and `config check` warns about open registration while accounts are on | Entry counts alone let one account store ≈ 750 MB (100,000 visits and 20,000 bookmarks with 4,096-byte URLs and 512-character titles: API.md limits), so a few accounts fill a Pi's SD card; a heavy real account (100,000 visits of ≈ 180 B) needs ≈ 20–30 MB. Open registration allows ≈ 600 accounts per hour per address (Auth class, 10/min), so the per-account quota alone still fills a card in about an hour; the server-wide cap needs no `statvfs`. A 4xx keeps clients from retrying a condition that does not pass by itself |
| D21 | **History byte budget** (deferred item, client side). The history store (`src/library/history.ts`) keeps visits within **64 MiB** of estimated stored size (2 × (URL + title) characters + 96 bytes per visit; a running total in the store's metadata, recomputed at start), besides `MAX_VISITS`; the oldest go first, checked together with the count cap; the existing `QuotaExceededError` eviction stays | 100,000 forged visits of maximal size are ≈ 500 MB (PROGRESS), enough to fill a small storage quota and break the app's other stores |
| D22 | **Bookmark pulls are paged and every sync answer is bounded** (deferred item): `GET /api/sync/bookmarks?since=&limit=&cursor=` is keyset-paged like history (`limit` 1–1000, history's cap; a page also ends once its JSON reaches 1 MiB, whichever comes first, with a `next_cursor`). A request **without** `limit` (a still-open old app during an upgrade) gets one page that ends on a `synced_at` boundary, with `server_time` set to that boundary, so the old client fetches the rest with `since=` on its next sync (one `synced_at` group is at most one upload batch, ≤ 2 MiB of body). GNOME's client always sends `limit` (1000). Answer bodies over 1 MiB hold room in a fixed 64 MiB "large answer" byte budget until fully written, and an account runs at most 2 sync pulls at once; without room: `503` + `Retry-After: 1` | 20,000 bookmarks + 50,000 tombstones in one answer is several MB of JSON built in memory on a Pi; at the API limits one unpaged answer can reach the 64 MiB quota, and the in-flight cap stops counting at the response head while the write-stall timeout lets a slow but steady reader hold a buffered body indefinitely |
| D23 (log) | **Secrets from files.** `GNOME_SECRET_KEY_FILE`, `GNOME_ADMIN_TOKEN_FILE`, `GNOME_ACCESS_CODE_FILE` (setting a variable and its `_FILE` twin is a configuration error, exit 2); one trailing newline is stripped; a file that others can read logs a warning (owner- or group-readable is the documented form: Compose ignores a file secret's owner and mode outside Swarm, so the stack uses mode 0640 plus `group_add`, measured in §5); `config check` shows "from file <path>", never the value. systemd hands them over with `LoadCredential=` (`$CREDENTIALS_DIRECTORY`), compose with a read-only mount of `deployment/secrets/` at `/run/secrets/`; an empty `_FILE` variable counts as unset. `deployment/init-secrets.sh` writes `GNOME_SECRETS_GID` into `deployment/.env` itself (rootless Docker: `0`, because the operator's IDs map to root in the container) and refuses a group that has other members (unless `--allow-shared-group`), offering a dedicated group instead; an unreadable secret file names that fix in its error. Without `GNOME_SECRET_KEY*`, `secret.key` in the data directory stays the default | Environment values show up in `docker inspect`, `/proc/<pid>/environ` and shell history; files with tight modes do not |
| D24 (log) | **Audits.** `scripts/audit.sh` runs `cargo deny check` (advisories from RustSec, licenses, bans, sources; policy `deny.toml`) on the workspace and `npm audit` on `frontend/`, `tests/e2e/` and `bench/`, classifying each npm finding as *shipped* (a `dependencies` package, a `VENDOR_PACKAGES` pin, every package in a vendored package's transitive dependencies (copy-vendor's list: `libcurl.js`, `@mercuryworkshop/epoxy-tls`, …), or a package in GNOME's chunks, worker bundles or `sw.js`) or *build-only*. Shipped high/critical fails; every ignore entry has a reason and an expiry date ≤ 90 days ahead; `--offline` uses the cached advisory database and reports "skipped", never "pass". The C and Rust code compiled into the vendored wasm (curl, Mbed TLS, nghttp2 and the CA bundle in libcurl.js; rustls and webpki-roots in epoxy-tls) is recorded with its versions and the CA bundle's date, and epoxy-tls's `Cargo.lock` at its mapped revision (D27) is checked with `cargo deny check advisories`; the pinned Caddy and gluetun binaries are checked with a pinned `govulncheck -mode=binary`, at least every 30 days (`release.sh` refuses a release whose image audit is older). `npm ci --ignore-scripts` everywhere Wave D installs packages. A release needs a passing audit or a recorded `--skip-audit "<reason>"` | cargo-deny's advisories check uses the same RustSec database as `cargo audit` and adds the license, ban and source policies in one tool; the vendored engines are devDependencies that ship, so `--omit=dev` would hide them |
| D25 (log) | **Raspberry Pi 4.** 64-bit OS only (aarch64; HolyWisp has no 32-bit build at its pin). The release's aarch64 binaries are cross-compiled; in this plan they run only under QEMU user-mode inside build containers (functional checks, never timings). No default changes for the Pi without a Pi measurement; `GNOME_ARGON2_MEMORY_KIB` stays 19456 (t = 2, p = 1; at most CPUs/2 = 2 concurrent hashes on a Pi 4 ≈ 38 MiB). Memory budgets measured on x86_64 transfer to aarch64 (same 64-bit build, same allocator, 4 KiB pages on a Pi 4), CPU numbers do not | No Pi 4 is available; the README must not promise more than was run |
| D26 (log) | **Budgets.** §7 lists them. Build-time budgets are **report-only until baseline-1** (step 3's blocker and Wave C's games land first and were budgeted by their own plans); d1a then sets "today" and the ceilings from baseline-1, adopts WAVE-B3 §10.2's limits for the blocker chunk, the builder Worker and `sw.js` as their own rows, and records the rebase in the decisions log. `scripts/budgets.json` is the one source of truth (`build.mjs` reads it after step 3's integration, through a change request the Wave D integration step applies). From then on a build-time budget that is exceeded fails the release build suite (`build-release.mjs`) and stops `scripts/release.sh`; `--allow-budget-overrun "<reason>"` records the reason in `BUILDINFO` and needs a decisions-log row with the new measured value. Runtime budgets are checked by `bench/compare.mjs` against the record run (a regression beyond noise fails). No lane closes with an unexplained overrun | "Use profiling and benchmarks rather than unsupported performance claims" needs a rule for when the numbers say no |
| D27 (log) | **Corresponding Source of what GNOME conveys.** (1) Third-party: a reviewed `scripts/third-party-sources.json` maps every shipped copyleft or MPL `package@version` (the vendored engines and transports, `libcurl.js`, `@mercuryworkshop/epoxy-tls`, `@ghostery/adblocker` after step 3) to its repository, an exact commit or signed tag and that commit's git tree hash, plus build notes for its wasm parts (the curl, Mbed TLS and nghttp2 versions inside libcurl.js; epoxy-tls's Rust build). d2a builds it by matching upstream tags or commits against the published files. `release.sh --third-party-source` (on by default for a published release) fetches each by commit and verifies the tree hash, as `fetch-build.sh` does (GitHub archive tarballs are not byte-stable), and always adds the integrity-checked npm tarballs GNOME ships. It fails when a copyleft vendored component has no verified entry, unless `--allow-missing-source "<reason>"` is given, which needs a decisions-log row. Ultraviolet is treated as AGPL-3.0 (its `LICENSE` file), although its `package.json` says MIT. (2) GNOME's own: release builds compile in a default `GNOME_SOURCE_URL` (`option_env!("GNOME_DEFAULT_SOURCE_URL")`, set by `release.sh` and the Dockerfile to the release's source and third-party source archives), the example files set it, OCI labels point at both archives, and `config check` warns when it is empty on a non-loopback deployment | Measured 2026-11-19: none of the 8 vendored packages, nor libcurl.js or epoxy-tls, records `gitHead`, and bare-mux and both `-bare` transports have no `repository` field, so the earlier `gitHead` route identified no revision; every default deployment conveys minified AGPL JavaScript and AGPL/LGPL wasm while its About page says no source link is published |

## 2. Lanes, ownership and timing

### 2.1 Ownership

| Lane | Owns (directories and files) | Provides | Consumes |
| --- | --- | --- | --- |
| **d1a** benchmark harness (new files) | `bench/**`: `README.md`, `run.mjs`, `compare.mjs`, `lib/**`, `node/**` (the Node baseline), `wispjs/{package.json,package-lock.json,server.mjs}`, `loadgen/{Cargo.toml,Cargo.lock,src/**}`, `results/<id>/{results.json,results.md}` (raw logs go to the already ignored `bench/results/raw/`; `$HOME` is written as `~` and no user name is stored); `scripts/budgets.json` (every ceiling of §7, read by d2's and d3's checks); `docs/BENCHMARKS.md`; `tests/e2e/engine/suites/perf-frontend.mjs` (new standalone suite, P-rows) | the harness and its record-run preset, the budgets file, baseline-0 (today's tree) and baseline-1 (after Wave C) numbers, `compare.mjs`, the P-rows | a frozen copy of the tree (§3.4); d2a's release `dist/` (H1, P-rows); d3a's image (I-rows) and its `server-out` target (every static musl build); d3a's derived Caddy image (`rust+caddy`); HolyWisp from `services/holywisp/build/` |
| **d1b** optimizations (after Wave C's integration) | root `Cargo.toml` (`[profile.*]`, `[workspace.dependencies]` features), `Cargo.lock`, `backend/Cargo.toml`, `crates/net/Cargo.toml`; `backend/src/main.rs` (allocator; also the `alloc-count` wrapper, because `lib.rs` forbids unsafe code), `backend/src/static_files.rs`, `backend/src/gateway/{relay,upstream}.rs` (`relay.rs` after d4b's M2 change to `client_rest`), `backend/src/observability.rs`, `backend/src/metrics.rs` (after d4b's M2 counters), `backend/src/api/meta.rs` (after d4b's M1 field), `backend/src/filters/store.rs` (startup verification only, if O1 shows it matters); `server.rs`/`router.rs` only after d4b reports M2 landed, each edit named in the report; **the generated block** between `// BEGIN RUST_CRATES` and `// END RUST_CRATES` in `frontend/src/pages/about/licenses.ts` (plus any new license id in its `LICENSES`) and `frontend/scripts/rust-crates.mjs` (the crate list for the union of the release targets: gnu and both musl triples), rewritten in the same step as every `Cargo.lock` change (§0) | the measured optimizations with before/after, the allocator decision (D6), the release-profile record (D5), the dependency trims (D7) | d4b's configuration variables (requested by change request; d4 owns `config.rs`); d3a's `server-out` target with its build arguments (§5.1) |
| **d2a** build pipeline (new files) | `frontend/scripts/{postbuild.mjs,postbuild.test.ts,bundle-report.mjs,third-party-notices.mjs,third-party-notices.test.ts}`; `scripts/{release.sh,third-party-licenses.mjs,third-party-sources.json}`, `scripts/lib/{release-lib.sh,source-allowlist.txt}`; the root `LICENSE` (new: a byte copy of `frontend/scripts/licenses/AGPL-3.0.txt`); `tests/e2e/engine/suites/{build-release.mjs,release-lib.mjs}` (new standalone suite, BR-rows; the release smoke flow d3a reuses); the `/release/` and `/tests/e2e/engine/results/` lines in `.gitignore`; GNOME's derived PNGs under `frontend/public/brand/` and `frontend/public/brand-v2/` (D12 only, after `ui:final`) | the release `dist/` (precompressed, no maps, notices), `bundle-report.mjs`, the licenses bundle, the release artifacts, checksums and signature, the third-party source archive (D27), the build-time budget check | `npm run build` and copy-vendor's output as they are; d3a's `deployment/Dockerfile` (target `server-out`) for the static binaries; `services/holywisp/fetch-build.sh`; d4a's `scripts/audit.sh` (`--skip-audit` until it exists); d4b's `GNOME_DEFAULT_SOURCE_URL` hook (M1) |
| **d2b** shared frontend build files (after step 3's integration) and the startup set (after Wave C's integration) | `frontend/package.json` (scripts `build:release` and `release:check` only; no new dependency), `frontend/vite.config.ts` and `frontend/vite.sw.config.ts` (only the options of §4.6, including the chunk graph of worker bundles and `sw.js`); after Wave C's integration, the import structure (static → dynamic imports, preload hints) of the app files its report names before editing them (§4.6) | `npm run build:release`; complete chunk graphs; the startup-set result (cut or justified) | bundle-report, the P-rows (d1a) |
| **d3a** deployment (new files) | `deployment/**`: `Dockerfile`, `Dockerfile.dockerignore`, `compose.yml`, `compose.vpn.yml`, `compose.test.yml` (the e2e override), `.env.example`, `Caddyfile`, `caddy/{Dockerfile,tls-acme.caddy,tls-files.caddy}`, `systemd/{gnome-server.service,gnome.env.example,gnome-server.service.d/credentials.conf.example}`, `systemd/route-b.env.example`, `systemd/holywisp.service.d/egress-deny.conf.example`, `init-secrets.sh`, `check.sh`, `tests/{syscalls.sh,image.sh,arm64.sh,egress-probe.sh}`, `README.md`; the `/deployment/secrets/` and `/deployment/.env` lines in `.gitignore`; `docs/DEPLOYMENT.md`; `tests/e2e/engine/suites/{deploy-lib.mjs,deploy-caddy.mjs,deploy-compose.mjs}` (DC- and DP-rows) | the gnome-server image (both architectures), the stack, the Caddy and systemd files, the static checks, the deployment and operations guide, Raspberry Pi 4 notes | the HolyWisp image (`fetch-build.sh --image`) and units as they are; d2a's postbuild (the image's `dist/`) and `third-party-licenses.mjs`; d4b's `_FILE` variables; d3b's CLI |
| **d3b** operational CLI (after Wave C's integration) | `backend/src/cli.rs` (subcommands `health`, `admin get`, `db backup`, §5.5), `backend/tests/cli_ops.rs` (new); `services/vpn/compose.example.yml` (the real `GNOME_SERVER_IMAGE`; the gluetun control-server key moved into an auth-config file, in both VPN recipes in one change marked [unproven]); the HEALTHCHECK and secrets wiring in its own `deployment/` files | `gnome-server health`, `gnome-server admin get <path>`, `gnome-server db backup <file>` | d4b M1 |
| **d4a** audits and client-side hardening (new and unowned files) | `deny.toml`, `scripts/audit.sh`, `scripts/audit/{npm-audit.mjs,npm-policy.json,embedded.mjs}`, `docs/AUDIT.md`; `tests/e2e/engine/suites/{flood-lib.mjs,cookie-flood.mjs}` (CF-rows; gated by `GNOME_E2E_FLOOD=1` until the Wave D integration step; rows that need d4b's M2 detect it by probing and are `expectFail` until it lands, so nobody edits them when it does); `frontend/src/lib/cookie-hygiene.ts` + `cookie-hygiene.test.ts` (wired in d4b); `frontend/src/library/history.ts` + `history.test.ts` (D21; after part 2, which may touch `history.test.ts`) | the audit policy and script, the first audit report, the flood suite, the hygiene module, the history byte budget | — |
| **d4b** server-side hardening (after Wave C's integration) | `backend/src/{config,server,router,lib,state}.rs`, new `backend/src/limits.rs`, `backend/src/metrics.rs` (M2's counters, before any d1b edit), `backend/src/admin/mod.rs` (the diagnostics additions of §6.3 and §6.5), `backend/src/gateway/{mod,caps}.rs`, `backend/src/gateway/relay.rs` (M2: only the release of `client_rest`, before any d1b edit), `backend/src/auth/{cookies,extract}.rs`, `backend/src/security/headers.rs` (only `Origin-Agent-Cluster`, and only if row CF7 adopts it), `backend/src/api/meta.rs` (M1: only the `proxy.cookieHygiene` field of `/api/config`, before any d1b edit), `backend/src/api/sync/**` (incl. the usage route), `backend/src/db/migrate.rs`, `database/migrations/0002_sync_quota.sql` (new); new tests `backend/tests/{conn_caps,head_limit,proxy_trust,sync_quota,sync_paging,secrets_file}.rs` and the existing tests that assert the 64 KiB head limit (`backend/tests/server.rs`); `tests/e2e/engine/suites/backend-proxy.mjs` (part `oversized` only); `frontend/src/main.ts` (one import and call); the bookmark pull and the `413` handling in `frontend/src/settings/sync.ts` (`httpRecordTransport`) and the quota message in `frontend/src/settings/account-sync.ts` (+ their tests) | M1 the new variables (D18, D19, D20, D23, D27's source-URL default), M2 caps + head limits and budget + `Priority=High` + proxy-trust warning, M3 quota + server cap + usage + paging + answer budget | d1's knobs requests |
| **Wave D integration** (after the four b parts) | the shared documents (§11), `frontend/src/pages/about/**` (the known-limitations texts; not d1b's generated crate block), `docs/PROGRESS.md`, the change request that makes `tests/e2e/engine/suites/build.mjs` read `scripts/budgets.json` | the record run, the final matrix (§10), the README sections | everything |

Directory map (ARCHITECTURE §3 already names `deployment/`, `scripts/` and `bench/`; this is what they hold):

```
bench/                   d1: run.mjs compare.mjs lib/ node/ wispjs/ loadgen/ results/ README.md
deployment/              d3: Dockerfile compose*.yml .env.example Caddyfile caddy/ systemd/ init-secrets.sh check.sh tests/ README.md
scripts/                 d1: budgets.json   d2: release.sh third-party-licenses.mjs third-party-sources.json lib/   d4: audit.sh audit/
frontend/scripts/        d2: postbuild.mjs bundle-report.mjs third-party-notices.mjs (+ tests)
tests/e2e/engine/suites/ d1: perf-frontend.mjs  d2: build-release.mjs release-lib.mjs  d3: deploy-*.mjs  d4: cookie-flood.mjs flood-lib.mjs
docs/                    d1: BENCHMARKS.md  d3: DEPLOYMENT.md  d4: AUDIT.md
```

### 2.2 Shared files: who edits them, and when

| File | Owner before Wave D may edit | Wave D owner | Window |
| --- | --- | --- | --- |
| `frontend/package.json`, `package-lock.json`, `vite.config.ts`, `vite.sw.config.ts` | step 3 lane x1 | d2b | after step 3's integration step; no dependency is added (D8, D11 use Node built-ins) |
| app files of the startup set (entry, routes, layout; named in d2b's report before editing) | Wave C lanes g2/v1/v3 (their own files), part 2 | d2b (import structure only, §4.6) | after Wave C's integration; d4b's one line in `main.ts` is merged first |
| `frontend/tsconfig*.json`, `tests/e2e/engine/suites/build.mjs` | step 3 lane x1 | nobody | Wave D adds `build-release.mjs` instead of touching `build.mjs` |
| `tests/e2e/engine/{run.mjs,lib/**}` | part 2, then step 3 lane x5 | nobody | Wave D suites are new files the runner discovers (`discoverSuites()`, `export const standalone = true`); heavy suites gate themselves with an environment switch (§9) |
| `tests/e2e/engine/suites/backend-proxy.mjs` | part 2, Wave C lane t (profile-path tickets) | d4b (part `oversized`) | after Wave C's integration |
| root `Cargo.toml`, `Cargo.lock`, `backend/Cargo.toml` | Wave C lane g1 | d1b | after Wave C's integration; d3b and d4b need no new crate (if one does: change request to d1) |
| `frontend/src/pages/about/licenses.ts` (the generated `RUST_CRATES` block and new `LICENSES` ids only), `frontend/scripts/rust-crates.mjs` | Wave C lane g1 (its declared exception), step 3 lane x4 | d1b | after Wave C's integration, in the same step as each `Cargo.lock` change; the rest of `about/**` is the integration step's |
| `backend/src/{config,server,router,lib}.rs` | Wave C lane g1 | d4b (`server.rs`, `router.rs` also d1b after d4b's M2) | after Wave C's integration |
| `backend/src/state.rs` | Wave C lane g1 (`prepare_modules`) | d4b (`limits` in `AppState`) | after Wave C's integration |
| `backend/src/cli.rs` | Wave C lane g1 | d3b | after Wave C's integration |
| `backend/src/static_files.rs` | Wave C lane g1 | d1b | after Wave C's integration |
| `backend/src/module.rs`, `backend/src/security/{csp,rate_limit,client}.rs` | Wave C lane g1 (`client.rs`: nobody) | nobody | — (no Wave D change needs them) |
| `backend/src/security/headers.rs` | Wave C lane g1 | d4b (only `Origin-Agent-Cluster: ?1`, only if CF7 adopts it) | after Wave C's integration |
| `backend/src/gateway/mod.rs` | Wave C lane v3 (route-bound tickets, with `ticket.rs`) | d4b | after Wave C's integration (needs `config.rs`) |
| `backend/src/gateway/caps.rs` | nobody | d4b | after Wave C's integration |
| `backend/src/gateway/relay.rs` | nobody | d4b (M2: release of `client_rest` only), then d1b | d4b after Wave C's integration; d1b after d4b reports M2 landed |
| `backend/src/gateway/upstream.rs`, `{observability,main}.rs` | nobody | d1b | after Wave C's integration (a fixed baseline) |
| `backend/src/api/meta.rs` | nobody | d4b (M1: `proxy.cookieHygiene` only), then d1b (O6) | d4b after Wave C's integration; d1b after d4b reports M1 landed |
| `backend/src/metrics.rs` | nobody | d4b (M2's counters), then d1b | d4b after Wave C's integration; d1b after d4b reports M2 landed |
| `backend/src/admin/mod.rs` | Wave C lane g1 (`catalog` placeholder, `config` keys) and step 3 lane x5 (filter lists), each inside its function (WAVE-C §2.2) | d4b | after Wave C's integration |
| `backend/src/{auth/cookies.rs,auth/extract.rs,api/sync/**,db/**}`, `database/migrations/` (core) | nobody | d4b | after Wave C's integration (needs `config.rs`) |
| `backend/src/filters/**` | step 3 lane x5 | d1b (`store.rs` only) | after Wave C's integration |
| `frontend/src/main.ts` | Wave C lane g2 | d4b (one import and call) | after Wave C's integration |
| `frontend/src/library/**` | part 2 | d4a (`history.ts`) | after part 2 |
| `frontend/src/settings/sync.ts` | Wave C's v1 (`withDeviceSettings()` only) | d4b (`httpRecordTransport`: bookmark paging, `413`) | after Wave C's integration |
| `frontend/src/settings/account-sync.ts` | — (Wave C's v1 owns `settings/{local-vpn,store.svelte,sync}.ts`, not this file) | d4b | after Wave C's integration |
| `frontend/public/brand/**`, `brand-v2/**` | UI restyle | d2a (D12 only) | after `ui:final` |
| `services/vpn/compose.example.yml` | nobody (Wave C's v2 owns that directory's README and profiles example) | d3b | after Wave C's integration |
| `services/holywisp/**` | nobody | nobody | Wave D uses the image, units and `fetch-build.sh` as they are |
| `.gitignore` | nobody | d2a (adds `/release/` and `/tests/e2e/engine/results/`), d3a (adds `/deployment/secrets/`, `/deployment/.env`) | any time (one line each, no other change) |
| root `LICENSE` (new) | — | d2a | any time |
| shared documents (§0) | Wave C's integration step | the Wave D integration step | after the four b parts |

### 2.3 Wave D beside Wave B step 3 and Wave C

| Part | Runs beside step 3 and Wave C | Why it can |
| --- | --- | --- |
| d1a | yes, from step 3's day one; **record** runs only in quiet windows | `bench/**`, `docs/BENCHMARKS.md` and a new suite belong to no other lane; it builds gnome-server from a frozen copy of the tree in its scratch directory (§3.4), never from the moving tree, and only reads the tree |
| d2a | yes, from step 3's day one | new files only; `copy-vendor.mjs`, `package.json` and the Vite configs are read, never edited; until d2b, `scripts/release.sh` calls `node frontend/scripts/postbuild.mjs` directly after `npm run build` |
| d3a | yes, from step 3's day one | `deployment/**`, `docs/DEPLOYMENT.md` and new suites belong to no other lane; images are built from a frozen copy of the tree; the HEALTHCHECK and `_FILE` secrets come in d3b (until then the compose file has no gnome healthcheck and the generated `secret.key` in the data volume is the key; no placeholder is shipped) |
| d4a | yes, from step 3's day one (`history.ts` after part 2) | new files, plus `src/library/history.ts`, which no step-3 or Wave C lane owns (WAVE-B3 §2, WAVE-C §2.1); `cookie-flood.mjs` records one `skip` row unless `GNOME_E2E_FLOOD=1` and uses the Node front unless `GNOME_E2E_DEPLOY=1`, so other waves' gates neither build Caddy images nor see half-built rows |
| d2b | **no: after step 3's integration step** (the startup-set part after Wave C's integration) | lane x1 owns `package.json`, its lock and both Vite configs until then; after it, no Wave C lane edits them (WAVE-C §2.2, g2 adds no frontend dependency); the app's entry and route files belong to running lanes until Wave C's integration |
| d1b, d3b, d4b | **no: after Wave C's integration step and its review fixes** | Wave C's lane g1 owns `Cargo.toml`, `Cargo.lock`, `backend/Cargo.toml`, `config.rs`, `server.rs`, `router.rs`, `lib.rs`, `cli.rs`, `static_files.rs` until then; every b part needs one of them, and optimizations need baseline-1 |

### 2.4 Order inside the wave

```
part 2 done
 └─ step 3 day one ─────────────────────────── step 3 integration ─── v3 ─── Wave C integration + fixes ──┐
    d1a: harness → Node + wisp-js baselines → loadgen → --check → baseline-0 (dev numbers, glibc) → P-rows │
    d2a: postbuild + notices → bundle-report → build-release suite → third-party-sources.json            │
         → release.sh (x86_64, then aarch64)                                                              │
    d3a: Dockerfile (amd64, then arm64 cross) → compose + Caddy (+ derived image) → systemd → check.sh    │
         → deploy-caddy suite → DEPLOYMENT.md draft                                                       │
    d4a: deny.toml + audit.sh + first audit → AUDIT.md → cookie-flood suite (gated, CF rows expectFail)   │
         → cookie-hygiene.ts → history byte budget (after part 2)                                          │
                                     d2b: package.json scripts + Vite options (after step 3 integration)   │
                                                                                                           ↓
    d1a: re-sync bench/node to the Wave C tree (w2 tickets, route refusals, re-check, headers) → --check
    d1: baseline-1 record run on a frozen copy (quiet window) — before any b-part edit of Rust code
    d4b: M1 variables (+ `_FILE`, source-URL default) → M2 caps + head limits + budget + relay `client_rest`
         + Priority=High + proxy trust (CF rows flip) → M3 quota + server cap + usage + paging + answer budget
    d1b: profiles → one optimization at a time (before/after on adjacent snapshots) → release profile, allocator,
         trims (About crate list in the same step as each Cargo.lock change); edits of server.rs, router.rs,
         metrics.rs and relay.rs only after d4b reports M2
    d2b: startup set (bundle-report → cut or justify; P1/P2 against baseline-1)
    d3b: CLI ops (after M1) → HEALTHCHECK + secrets wiring → deploy-compose suite (needs d2a, d4b M1)
    → Wave D integration: record run (quiet window), release both arches (--verify-reproducible), images, matrix (§10),
      documents (§11) → review (security and operations ∥ completeness) → fixes
```

Dependencies between Wave D lanes: d1a's H1 and P-rows use d2a's release `dist/` (until it exists they use a plain
`npm run build`, labelled so); d1a's static musl builds and d2a's `release.sh` binaries come from d3a's Dockerfile
target `server-out` (until it exists d1a measures glibc builds, labelled so); d2a's `release.sh` preflight runs d4a's
`scripts/audit.sh` (`--skip-audit "<reason>"` until it exists); d3b's secrets wiring needs d4b's M1; the DC-rows that
send a cookie flood through Caddy (DC4) need d4b's M2 to pass (before it they record the expected `431`); every d1b
"before" is a snapshot taken after the last d4b or d1b change.

**Quiet-window demand** (for the orchestrator's schedule; `run.mjs --plan` prints the exact figure): the record
preset is ≈ 190 cells; at 5 repeats for budgeted cells and 3 for the rest, 5 s + 20 s per repeat plus the gate and
process start, one full record run takes ≈ 5 h (estimate). The wave needs baseline-1 (full), the final run (full),
AC6's repeatability run (only the configurations that did not change: ≈ 2 h), one targeted subset per d1b candidate
(≈ 0.5 h each, O1–O10 and the allocator: ≈ 5 h), the P-rows and CF5 (≈ 1 h): ≈ 18 h of quiet windows in total, in
blocks of at most 5 h.

## 3. Lane d1: benchmarks, profiling, optimization

### 3.1 The harness (d1a)

`node bench/run.mjs [--preset dev|record] [--scenarios W1,H1,…]
[--configs rust,rust-ctr,rust-copy,rust+caddy,node1,node4,wispjs,wispjs4,holywisp] [--repeats N] [--duration S]
[--warmup S] [--server-bin PATH] [--dist DIR] [--out bench/results/<id>] [--check] [--smoke] [--plan]
[--cpus servers=LIST,loadgen=LIST]` (`--cpus` overrides the topology-derived CPU sets, e.g. on a
Raspberry Pi 4, §5.6) starts and stops every process itself, pins them (§3.4), runs the load generators, samples `/proc` and
writes `results.json` (meta + every run) and `results.md` (tables) into `bench/results/<date>-<label>/`; raw logs and
histograms go to `bench/results/raw/` (already in `.gitignore`). `node bench/compare.mjs <before> <after>` prints the
noise-aware comparison of two result sets (§3.4) and exits 1 on a significant regression of a budgeted metric (§7).

| File | What |
| --- | --- |
| `bench/lib/{cpusets,quiet,proc,stats,servers,equivalence}.mjs` | topology and CPU sets, the quiet gate, `/proc` sampling, medians/IQR/significance, process start/stop with ready checks, the `--check` request list |
| `bench/lib/no-splice.json` | a seccomp profile (Docker's default minus `splice`) for the `rust-copy` configuration: the same binary in an unprivileged container (`--network host`, `--cpuset-cpus` = the server CPUs) fails its startup splice probe and relays by copying, so the copy path is measured without a code switch. `rust-ctr` is the same binary in an identical container with Docker's default profile, so "copy vs splice" compares `rust-copy` with `rust-ctr`, like with like; `rust` (the binary on the host, every other scenario's configuration) against `rust-ctr` gives the container's own cost |
| `bench/node/{server,static,api,gateway,tokens}.mjs` (+ `*.test.mjs`) | the Node baseline (D2), built-ins only; `--workers N` runs it under `node:cluster` |
| `bench/wispjs/{package.json,package-lock.json,server.mjs}` | the pinned `@mercuryworkshop/wisp-js` server (the newest release when d1a starts, recorded; AGPL-3.0 to be verified at pin time; bench-only, never shipped) with loopback targets allowed and its limits off, listening on `127.0.0.1` only; `npm ci --ignore-scripts`; `wispjs4` runs it as a 4-worker `node:cluster` (the primary pinned to the server CPUs and its CPU counted), so it meets HolyWisp's 4 workers on equal terms |
| `bench/loadgen/` | `gnome-bench` (D3): `wisp` with the modes `tp`, `rtt`, `churn` (spread over several `127.0.0.x` source addresses), `idle`, and `echo` (on `127.0.0.1`), plus `fadvise <paths…>` (`posix_fadvise(POSIX_FADV_DONTNEED)` for S1 (b), which Node does not expose); tickets are minted through the server's real `POST /api/wisp/ticket` with an anonymous session first, then the WebSocket URL is the canonical `…/wisp/?t=<ticket>&/` with `Origin` = the proxy origin |
| `oha` | HTTP load (pinned, installed under `~/.cache/gnome-tools/`) |
| `rust+caddy` | the deployed path: d3a's derived Caddy image (`--network host`, `CADDY_BIND=127.0.0.1`, admin off, TLS from the throwaway CA, `--cpuset-cpus` = the server CPUs) in front of `rust`; recorded for W1, W2 and H1 (a) without a budget, with each process's share of CPU, so BENCHMARKS.md can say whether the gateway or the front limits the deployed stack |

Bench configuration of the servers (only in `bench/lib/servers.mjs`, never in a product default):
gnome-server with `GNOME_WORKERS=4`, `GNOME_RATE_LIMIT_SCALE=0` (rate limits off in every configuration),
`GNOME_MAX_WS_PER_IP`/`GNOME_MAX_WS_PER_SESSION` at their maximum (W3/W4 come from one address), and, for every
snapshot (older ones ignore unknown variables), `GNOME_MAX_CONNECTIONS=100000`, `GNOME_MAX_CONNS_PER_IP`,
`GNOME_MAX_INFLIGHT_PER_IP` and `GNOME_MAX_INFLIGHT_HEAD_MB` at their maximum, so d4b's caps never make baseline-1
and the final run differ (one recorded W4 row runs with the default caps, to show what a default install admits;
before W4 the harness checks that `/admin/diagnostics` `connections.effective` is at least the cell's N);
`GNOME_LOG=warn` (H1 also with `info`), the no-internet variables of §0, two origins (`GNOME_BIND` +
`GNOME_PROXY_BIND`, both on `127.0.0.1`), `GNOME_ADMIN_BIND` on a lane port of `127.0.0.1`, a scratch data
directory; HolyWisp with `services/holywisp/gnome.conf` plus `--port <p> --workers 4 --allow-loopback on` and its
connection limits raised by flags (the echo target is on loopback, which `gnome.conf` refuses; the harness refuses
to start this HolyWisp on anything but `127.0.0.1`). Every listener is checked to be on loopback after start (§0).
Each configuration's command line is stored in `results.json` with `$HOME` written as `~`.

### 3.2 Baselines and the equivalence check

The Node baseline (D2) copies the rules from `docs/API.md` and ARCHITECTURE §4.4/§4.6, not the code: the same static
index (strong ETag = first 16 bytes of SHA-256 in base64url, `-br`/`-gz` suffixes for siblings, `immutable` for
`/assets/`, `no-cache` elsewhere, the proxy-origin CSP strings read from `backend/tests/fixtures/proxy-origin-csp.json`),
the same anonymous session token and ticket formats (HMAC-SHA256, `w1.<exp>.<session_ref>.<mac>` at baseline-0), the
same gateway checks in the same order, the same reconstructed upgrade request and `TCP_NODELAY` on both legs (Node's
`net` does not set it by default; gnome-server sets it in `server.rs` and `gateway/upstream.rs`). The static server
follows gnome-server's memory rule (files ≤ 256 KiB in memory up to a 32 MiB budget, larger files read from disk).
It runs without rate limits, like gnome-server in the bench. **Re-sync after Wave C** (a d1a step of §2.4, before the
baseline-1 record run): `bench/node` follows the tree after Wave C's integration (route-bound `w2` tickets with mint
time, the route refusals, tickets minted before the process started refused, the 15 s session re-check that closes
connections, the new app headers), and `--check` gains a ticket-format and a route-refusal case. `bench/run.mjs
--check` sends ≈ 40 fixed requests to both servers and compares status and every response header except the values
of `Date` and `x-request-id`, and the ETag form (assets in br/gz/identity, `304`, SPA
fallback, `/engine/`, `/sw.js`, a vendor file, a `404`, a reserved-prefix JSON `404`, ticket mint, the ticket probe's
`401`/`426`, an upgrade without `Origin`, an upgrade that succeeds), then pushes 64 MiB of random bytes through each
gateway to the echo and compares SHA-256s. A difference fails the check and blocks record runs. Known, accepted
differences (each listed in `bench/README.md` with its reason): Node relays by copying (`pipe()`); the measured API
paths do not touch the database in either server (anonymous sessions are stateless HMAC tokens in both). Node 26 has a
working `node:sqlite`, so an optional database-backed scenario (one sync pull page, A1 (d)) may be added with it;
without it, BENCHMARKS.md says the database paths were not compared.

### 3.3 Scenarios

| ID | Scenario | Configurations | Metrics |
| --- | --- | --- | --- |
| W1 | Wisp bulk throughput to a counting echo on loopback: 1 conn × 1 stream, 1 × 10, 8 × 4, 64 × 4, and 768 × 1 (more than 512 spliced connections moving data at once, past the per-user pipe budget, D18) | rust (gateway on the host, splice → HolyWisp), rust-ctr (in a container), rust-copy (same container, no splice), rust+caddy (1 × 10 and 8 × 4 only), node1, node4 (Node gateway → HolyWisp), node4 → wisp-js, holywisp direct, wispjs and wispjs4 direct | MiB/s in one direction at the echo, CPU-seconds per GiB per server process, peak RSS, load-generator CPU (a cell where it exceeds 90 % of its cores is marked load-generator-bound) |
| W2 | Wisp latency: 64-byte ping-pong on one stream, idle and while W1 8 × 4 runs | as W1 | p50, p99, p99.9, max |
| W3 | Wisp setup churn: (a) ticket probe + WebSocket upgrade + CONNECT + 1-byte echo + close, 32 in flight; (b) stream open/close inside one connection | as W1 ((b) direct servers only) | operations/s, setup p50/p99 |
| W4 | Connection scaling: hold N = 1,000, 5,000, 10,000 idle Wisp connections (one idle stream each), then let 1,000 of them move 128 KiB/s each for 20 s; one extra row with the default caps (§3.1) | rust, node4 → HolyWisp, holywisp direct, wispjs direct | RSS and PSS per connection (gnome-server and HolyWisp separately), descriptors, pipes below 64 KiB and `F_SETPIPE_SZ` failures (from d1b's counters once they exist, §3.5), CPU % idle and at the rate |
| H1 | Static serving: (a) a hashed asset from memory with `Accept-Encoding: br`, (b) gzip, (c) identity, (d) `304`, (e) a large vendor file streamed from disk (`vendor/libcurl-transport/index.js`, brotli sibling ≈ 700 KB), (f) SPA fallback `/browse`, (g) `/engine/` on the proxy listener; closed loop c = 1, 16, 64, 256 (keep-alive, 20 s; node1 without c = 1 and 16) and a fixed 5,000 req/s for latency (`oha -q 5000 --latency-correction`) | rust, node1, node4; rust+caddy for (a) | req/s, p50/p99/p99.9, CPU µs per request, RSS |
| A1 | API: `POST /api/wisp/ticket` (anonymous session, `X-GNOME-Request: 1`), `GET /api/config`, `GET /api/session`; c = 64 closed loop and a fixed 2,000 req/s | rust, node1, node4 | as H1 |
| S1 | Startup: exec → first `200` from `/api/health` (connect + GET every 2 ms), 30 runs: (a) existing data dir, warm page cache; (b) "cold": `gnome-bench fadvise` (`posix_fadvise(POSIX_FADV_DONTNEED)`) on the gnome-server binary, HolyWisp, every file of `dist/` and the data dir before each run (drops our own clean cached pages without root; a real cold boot cannot be produced without root and is not claimed); (c) a fresh data dir (migrations, key generation); each with the release `dist/` and with a plain build | rust, node1 | ms p50/p90/max, plus the server's own startup timings once d1b logs them |
| R1 | Memory at rest: RSS/PSS 10 s after S1's first `200`, after 60 s of H1 at c = 64, after W4 N = 1,000 closed | rust (glibc and static musl), node1, node4, HolyWisp | MiB |
| B1 | Sizes: stripped `gnome-server` for x86_64 glibc, x86_64 musl, aarch64 musl; once each with `panic = "abort"` and `opt-level = "s"` (recorded, not adopted, D5); with and without mimalloc (D6); `cargo bloat --release --crates -n 30`; crate count. Image and artifact sizes come from d3 and d2 (I1) | — | bytes |
| P1–P5 | Frontend (`perf-frontend.mjs`, both browsers, the release `dist/` behind an HTTPS front so browsers ask for brotli): P1 app first load cold/warm (requests, transferred bytes by type, DOMContentLoaded, load, FCP/LCP in Chromium); P2 route transitions Home → Settings → History → Bookmarks → Home, 10 rounds, time to the target page's first content; P3 engine-host init (`InitResult.timings`); P4 a first proxied page (local fixture) cold/warm, both engines; P5 every request during 60 s idle on `/browse` (polling, ticket probes, service-worker update checks: the evidence for "reduce unnecessary network requests") | gnome-server only | counts, bytes, ms |

### 3.4 Method

- **Snapshots.** Every measured build comes from a frozen copy of the tree (`rsync` without `target/`,
  `node_modules/`, `dist/`, `data/` into the lane's scratch directory), identified by the SHA-256 of its sorted file
  list and file hashes, built with the lane's own target directory (glibc) and through d3a's `server-out` target
  (static musl; `--build-arg CARGO_BUILD_JOBS=3`, `CARGO_FEATURES`, `CARGO_PROFILE_RELEASE_*` for the A/B builds of
  §3.6, recorded per build). baseline-0 = the tree when d1a starts;
  baseline-1 = the tree after Wave C's integration (§2.4), recorded before any Wave D Rust change; each optimization is
  measured on two adjacent snapshots.
- **Machine record** (`results.json` `meta.machine`): CPU model, cores, SMT layout
  (`/sys/devices/system/cpu/cpu*/topology/thread_siblings_list`), cpufreq governor and boost (read only; nothing is
  changed), kernel, memory, swap, Docker, rustc, Node, oha, loadgen and wisp-js versions, the SHA-256 of every binary,
  the snapshot id, and (read only) `fs.pipe-user-pages-soft`/`-hard`, `fs.pipe-max-size`, `ip_local_port_range`,
  `tcp_tw_reuse` and `net.core.somaxconn`, plus how many pipes the servers' UID holds before the run (the per-user
  pipe budget is shared with everything else that UID runs; the record runs use a UID that holds no others where the
  orchestrator can provide one, otherwise the count is recorded and AC6 compares runs with similar counts).
- **Loopback limits.** Per cell the harness counts `EADDRNOTAVAIL` errors, `TIME_WAIT` sockets and accept-queue
  overflows (`ListenOverflows` from `/proc/net/netstat`); an affected cell is marked, never quoted as a server number.
  W3 and the W4 ramps spread their connections over `127.0.0.2`–`127.0.0.9` as source addresses.
- **CPU sets.** Servers on 4 logical CPUs of 4 distinct physical cores with their SMT siblings left unused, the load
  generator on the remaining physical cores (on this machine: servers `0-3`, siblings `6-9` idle, load generator
  `4,5,10,11`), through `taskset -c` (containers: `--cpuset-cpus`). A two-process stack (gateway + Wisp server)
  shares the 4 server CPUs, as on a Pi 4; a `node:cluster` primary is pinned to them too and its CPU is counted.
- **Quiet gate.** Before every repeat, 2 s of `/proc/stat`: every CPU of both sets ≥ 95 % idle and the 1-minute load
  average ≤ 2; otherwise wait 30 s, up to 20 times, then run and mark the repeat `noisy`. Noisy repeats are left out of
  medians; a record run fails when a budgeted cell has fewer than 3 clean repeats or another cell fewer than 2.
- **Timing.** 5 s warm-up (discarded), 20 s measured, 5 repeats per cell that has a budget in §7 and 3 for every
  other cell, configurations interleaved round-robin per repeat. `run.mjs --plan` prints cells × repeats × time
  before a run; the record preset takes ≈ 5 h (estimate, §2.4, which also gives the wave's total quiet-window
  demand); d1b's before/after runs are targeted subsets (the candidate's scenario plus every budgeted metric that
  `compare.mjs` checks); the dev preset (1 × 5 s, no gate) takes a few minutes and is never quoted.
- **Sampling.** Every 100 ms `VmRSS`/`VmHWM` from `/proc/<pid>/status`; at the end `Pss` from `smaps_rollup`,
  `utime + stime` from `/proc/<pid>/stat` (CPU-seconds over the window), the descriptor count; for every server process
  and the load generator.
- **Statistics.** Median with min, max and IQR per metric; latency percentiles from the merged HDR histograms of a
  cell's clean repeats; a difference is significant only when the medians differ by more than max(3 %, the larger IQR
  as a share of the "before" median). Units: MiB/s (2²⁰ B), KiB/MiB for memory and binaries, KB (1000 B) for web
  transfer sizes, as the UI gate reports them.

### 3.5 Profiling and the optimization loop (d1b)

Tools: samply (pinned; works here because `kernel.perf_event_paranoid` is −1) on a release build with
`CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=none`; an allocation counter behind a
non-default Cargo feature `alloc-count` of `gnome-server` (a counting wrapper around the system allocator, which
lives in `main.rs` because `lib.rs` has `#![forbid(unsafe_code)]`; it registers a read function with `metrics.rs`
for `gnome_alloc_calls_total`/`gnome_alloc_bytes_total` on `/admin/metrics`; never in a release build, row BR6); syscall
counts from samply's kernel stacks, or from `strace -c` in the unprivileged trace container of §5.4. The loop:
profile the scenario → write the hypothesis → change one thing → before/after (§3.4) → keep it only if significant and
nothing else regresses → a row in `docs/BENCHMARKS.md` (what, the profile evidence, the numbers).

Candidates (hypotheses from reading the code; each needs its profile first):

| # | Hypothesis | Options | Scenario |
| --- | --- | --- | --- |
| O1 | Startup waits for SHA-256 of every identity static file (≈ 24 MiB without maps; siblings are read but not hashed, `static_files.rs`) and for the verification of every stored filter list, one file after another | hash on several blocking threads; trust postbuild's manifest (`dist/.gnome/files.json`: size, mtime, SHA-256) when size and mtime match, with postbuild setting every file's mtime to `SOURCE_DATE_EPOCH` (tar `--mtime` and BuildKit's `rewrite-timestamp` would otherwise change them on both production routes, so the shortcut would never apply there) and the full hashes verified in the background after the listeners are up (a mismatch is logged and that file re-indexed); verify filter lists after the listeners are up (lists answer `503` until verified, as they do while missing). The Pi 4's Cortex-A72 has no SHA-2 instructions (estimate: about 10× slower hashing than SHA-NI here) | S1 |
| O2 | The in-memory budget (files ≤ 256 KiB, 32 MiB in total) now also holds gzip and brotli siblings | keep identity and brotli in memory, stream gzip from disk; or a smaller budget on small hosts | R1 vs H1 |
| O3 | Large files stream in 64 KiB chunks from disk | 256 KiB chunks; or keep the brotli siblings of the vendor files a cold engine host loads (≈ 2–3 MB) in memory | H1 (e) |
| O4 | Each relayed chunk costs `readable().await` + splice in + `writable().await` + splice out | first (a prerequisite, kept regardless): counters for pipes created below 64 KiB and for `F_SETPIPE_SZ` failures in `/admin/diagnostics` and `/admin/metrics`; then try the splice out at once and wait for writability only on `EAGAIN`; a larger pipe for bulk streams (`F_SETPIPE_SZ` 256 KiB through rustix, which fails with `EPERM` once the UID passes `fs.pipe-user-pages-soft` and must fall back silently; every enlarged pipe uses up the budget of later connections faster, so the trade-off is reported); fewer `Instant::now()` calls. W2's tail latency must not get worse | W1 (incl. 768 × 1), W2, W4 |
| O9 | Every spliced connection holds two 64 KiB pipes from its start to its end, so the per-user pipe budget (1,024 full pipes here) is spent by ≈ 512 connections, idle or not; later connections get 8 KiB pipes (8× the syscalls per byte) | lazy or pooled pipes: a connection takes a pipe from a process-wide pool only while bytes are in flight and returns it once the pipe is empty (HAProxy's pipe pool works this way); an idle connection then holds 2 descriptors instead of 6 (D18's ÷ 6 and RB3's basis are updated with the measured result) | W1 768 × 1, W4 |
| O10 | Compiler PGO (cargo-pgo / llvm-profdata) | measure one PGO build on H1 and W1 and record a decision; likely not adopted, because a reproducible release would need committed profiles and a more complex build | H1, W1 |
| O5 | Allocations per request in the middleware stack (request id, span, access-log line, header values) | prebuilt `HeaderValue`s, no intermediate `String`s | H1, A1 (alloc-count) |
| O6 | `/api/config` (every app load) is serialized per request | cache the bytes; rebuild when a module's public config changes | A1 |
| O7 | The `info` access log line costs throughput | format without intermediate allocations | H1 `info` vs `warn` |
| O8 | Reader-pool size and SQLite caches for API reads and sync pulls | measure only; defaults change only with evidence | A1, sync pull |

Not candidates: pooling connections to HolyWisp (each browser WebSocket is one Wisp session; nothing to share across
clients), `sendfile(2)` (hyper's body path does not use it, and TLS is terminated by Caddy, which copies anyway).

### 3.6 Release profile, allocator, dependencies (d1b)

- **Release profile** (D5): record B1's sizes for the variants; keep the profile; add `--remap-path-prefix` to the
  release builds (d2's `release.sh`, d3's Dockerfile: d1 gives them the exact flags) and prove it with row RL4.
- **Allocator** (D6): H1, A1 and W4 on the static musl build with musl's allocator and with mimalloc, glibc for
  reference; apply the rule; record the numbers either way.
- **Dependencies** (D7), each with `cargo bloat` and `cargo tree -i` evidence:

| # | Candidate | Expected effect | Check |
| --- | --- | --- | --- |
| C1 | `tracing-subscriber`'s `env-filter` → `filter::Targets` | drops `regex-automata`, `regex-syntax`, `matchers` | `GNOME_LOG`'s documented form (`info,gnome_server=debug`) keeps working (test); span/field directives stop working (documented by the integration step) |
| C2 | reqwest 0.13 pulls `rustls-platform-verifier`, `rustls-native-certs` and `openssl-probe`, although gnome-net configures rustls with `webpki-roots` itself. In reqwest 0.13.5 the feature GNOME uses, `rustls-no-provider`, is itself `["dep:rustls-platform-verifier", "__rustls"]`: no public feature avoids it | choose one, with a decisions row: (a) record only (the verifier is linked but never called, because gnome-net passes its own rustls config; `cargo bloat` gives its size); (b) the private `__rustls` feature with an exact pin `reqwest = "=0.13.5"` and a test that fails when the platform verifier reappears; (c) gnome-net on hyper-util's client, which needs `crates/net/src/**` (no Wave D lane owns it: the integration step would assign it first). Default (a) | gnome-net's TLS tests and the filter-list fetch test pass; the `deny.toml` bans of §6.1 on these crates are added only if (b) or (c) lands |
| C3 | duplicates `tower-http` 0.6/0.7 (reqwest) and `getrandom` 0.2/0.4 (ring) | record only, unless a version bump removes them | `cargo tree -d` |
| C4 | features of `tokio`, `hyper-util`, `axum`, `serde_json` (`raw_value`), `clap` | keep the minimum the code uses | build + tests |
| C5 | `gnome-catalog` (with `quick-xml`) | required by Wave C: size recorded, nothing removed | B1 |

Every `Cargo.lock` change (a trim, a bump, mimalloc) regenerates the About page's crate list **in the same step**
(`node frontend/scripts/rust-crates.mjs`, which d1b first extends to the union of the release targets: the gnu and
both musl triples, so a musl-only allocator is listed), or `npm test` turns red for every running lane (§0).

### 3.7 Deliverables and acceptance

- `docs/BENCHMARKS.md`: the machine and the method; how to reproduce (`npm ci` in `bench/wispjs`, `cargo build
  --release` in `bench/loadgen`, `node bench/run.mjs --preset record`); Rust vs Node per scenario; HolyWisp vs wisp-js;
  every kept optimization with before/after; sizes (binary per target, crates, `dist/`, image, artifact); the
  frontend P-rows; a Raspberry Pi 4 section (estimates, each labelled with its basis, and what was not measured);
  the history (baseline-0, baseline-1, final).
- Acceptance: **AC1** `bench/run.mjs --check` passes; **AC2** a record run of every scenario × configuration on the
  final tree (a missing cell names its reason, e.g. a feature wisp-js lacks); **AC3** each kept optimization is
  significant on its target and regresses nothing, with tests green; **AC4** D5/D6/D7 recorded with numbers;
  **AC5** the runtime budgets of §7 are met, or a decisions-log row changes them; **AC6** repeatability: a second
  record run of only the configurations that did not change (Node, HolyWisp direct, wisp-js) agrees with the first
  within the noise band, otherwise the method is fixed before any number is quoted; **AC7** the cargo gates and the e2e runner's `build`,
  `host-smoke`, `shell-browse` and `backend-proxy` suites stay green after every d1b change.

### 3.8 Tests

- `cargo test` in `bench/loadgen`: WebSocket accept key and client masking, Wisp v1 frame encode/decode (CONNECT,
  DATA, CONTINUE, CLOSE), flow control (never past the CONTINUE window), histogram merge.
- `node --test bench/node/*.test.mjs`: token and ticket format, ETag form, encoding negotiation, path rules.
- `node bench/run.mjs --check` and `--smoke` (each scenario 2 s, no gate): run by d1 after every harness change and by
  the integration step.
- `node --test bench/lib/*.test.mjs`: the loopback guard aborts a run when a started process listens on a
  non-loopback address (a fixture server on `0.0.0.0`), the CPU-set derivation, the `--plan` arithmetic.
- `cargo check -p gnome-server --features alloc-count` (the feature compiles); row BR6 (a release binary does not
  contain it).
- `perf-frontend.mjs` P-rows, both browsers (under the runner only with `GNOME_E2E_PERF=1`; otherwise the suite
  records one `skip` row with the reason, so the default e2e run stays fast).

## 4. Lane d2: production build pipeline and release

What `npm run build` already does (README "Production build optimisation", `vite.config.ts`): Vite 8/rolldown
minifies and tree-shakes GNOME's code (target `es2022`, Lightning CSS, hashed `/assets/`, `sourcemap: false`), the
service worker is a separate classic build, and `copy-vendor.mjs` copies the pinned engines byte for byte with their
licenses. d2 adds what happens after that build and the release around it, without changing the build itself until
d2b.

### 4.1 `frontend/scripts/postbuild.mjs` (d2a)

`node frontend/scripts/postbuild.mjs [--dist DIR] [--release] [--check] [--allow-budget-overrun "<reason>"]`
(`--dist` defaults to `GNOME_DIST_DIR` or `frontend/dist`), in this order:

1. **Maps** (`--release` only, D9): delete `vendor/**/*.map` and record each removed path; fail if any other `.map`
   file exists (GNOME's own code has none).
2. **Precompression** (D8) on worker threads (one per core, at most 6): brotli quality 11 with
   `BROTLI_PARAM_LGWIN = 24` and `BROTLI_PARAM_SIZE_HINT`, gzip level 9; eligible = text extensions of D8 and
   `LICENSE*` files ≥ 1 KiB, not `engine/*.html`, not `.map`, not already `.br`/`.gz`; a sibling is kept only if it
   saves ≥ 10 %; with `--release`, files under `vendor/` get only the `.br` sibling (D8); each sibling is
   decompressed and compared with its file; an existing sibling that does not match its
   file is an error (a stale `.br` from an older build would otherwise be served under the new file's ETag, because
   gnome-server derives sibling ETags from the identity file). Measured for D8: ≈ 30 s single-threaded for the whole
   `dist/`, so a few seconds on six workers (estimate).
3. **Manifests** (directories starting with a dot are never served): with `SOURCE_DATE_EPOCH` set (release builds),
   every file's mtime is first set to it (so tar and BuildKit keep the mtimes O1 may trust); then
   `dist/.gnome/files.json` (sorted: path → size, mtime, SHA-256, sibling sizes; deterministic) and
   `dist/.gnome/build.json` (build id, removed maps, budget results).
4. **Notices** (D11): `dist/licenses/THIRD-PARTY-NOTICES.txt` from `frontend/scripts/third-party-notices.mjs`.
5. **Budgets** (§7, build-time rows): the table is printed; an overrun exits 1 unless `--allow-budget-overrun` is
   given, whose reason goes into `build.json`. Until d1a rebases the ceilings on baseline-1 (D26), `budgets.json`
   marks them `"enforce": false` and overruns are only reported.

`--check` verifies an existing release `dist/` (steps 1–5 as assertions, nothing written): used by the release script
and by row BR3.

`node frontend/scripts/bundle-report.mjs [--dist DIR] [--json]` prints both startup sets (the files `index.html` and
`engine/index.html` load at start: `<script src>`, `<link rel=modulepreload>`, `<link rel=stylesheet>`; vendor files
listed separately) with raw, gzip -9 and brotli 11 sizes, every lazy chunk, and the modules of each chunk from
`.vite/gnome-chunks.json` (module sizes once d2b adds them, §4.6). It is the measuring tool for the first-load budgets
and replaces the throwaway `size.py` of the UI gate (same definition: per-file gzip level 9, KB = 1000 B).

### 4.2 Source maps and obfuscation (D9, D10)

- No map is generated for GNOME's code in any build (`sourcemap: false` in both Vite configs stays); row BR1 proves it
  for release builds, including the absence of `sourceMappingURL` comments in GNOME's own files.
- The vendored engines' 15 `.map` files (5.0 MiB) stay in development and e2e builds (debugging the engines) and are
  removed from release builds, images and artifacts by step 1; their JavaScript stays byte-identical (row BR2).
- No obfuscation step exists or is added (D10). The integration step removes `obfuscate.mjs` from ARCHITECTURE §3,
  `GNOME_OBFUSCATE` from §8 and "opt-in obfuscation" from README and PROGRESS (Phase 8 item reworded: "minify,
  tree-shake, precompress, optimize GNOME's images, no public source maps; no obfuscation (D10)").

### 4.3 Images (D12)

d2a measures lossless recompression of GNOME's derived PNGs (`frontend/public/brand/*.png`,
`frontend/public/brand-v2/*.png`; never `logo.png`) with `oxipng -o max --strip safe` (pinned, in the lane's tool
directory; no `--alpha`, which may change the colour of transparent pixels). If the total saving is ≥ 10 KiB, the
optimized files replace the originals once (after `ui:final`), each verified pixel-identical by decoding both to
RGBA in the lane's scratch tools (nothing is added to `package.json`); otherwise nothing changes and
`docs/BENCHMARKS.md` records the measured saving. The first-load image bytes come from row P1 and have a budget (§7).

### 4.4 Third-party notices and the licenses bundle (D11)

- `frontend/scripts/third-party-notices.mjs`: every module id under `node_modules/` in the chunk graphs (app and
  engine host from `.vite/gnome-chunks.json`; Vite worker bundles and `sw.js` from the graphs d2b makes
  `worker.plugins` and `vite.sw.config.ts` write, a requirement of §4.6; until d2b lands, the notices are marked
  incomplete in `build.json` and BR7 is `expectFail`) → its package root → name, version, repository, the npm
  tarball URL (from the lock), the `license` field and the package's license file text. Vite's own `build.license`
  output (Vite ≥ 7.1) is compared as a cross-check where the installed Vite produces it. A package without a license file or with a license outside
  the allow-list of `scripts/audit/npm-policy.json` (d4) is an error. Fonts come from their `@fontsource-variable/*`
  packages (OFL-1.1 texts). Output sorted by package name.
- `scripts/third-party-licenses.mjs --target <triple> --dist <release dist> --out <dir> [--cargo-metadata <json>
  --crate-src <dir>]` (the two options let the Docker build run it without cargo, §5.1) writes the artifact's
  `share/licenses/`: `GNOME-AGPL-3.0.txt` (the text in `frontend/scripts/licenses/`) and `SOURCE.txt` (the source
  and third-party source tarballs' names and SHA-256s, the default `GNOME_SOURCE_URL` compiled into this build (D27),
  and the rule that operators who modify GNOME must offer that source to their users, AGPL §13);
  `gnome-server/{rust-std.txt,LICENSE.musl}` (the Rust standard library's license notice from the toolchain actually
  used, and musl's `COPYRIGHT` for the static musl binary; the Dockerfile fails when the linked musl version has no
  vendored `COPYRIGHT`, as HolyWisp's Dockerfile does); `rust-crates.txt` (every crate of `cargo tree -p gnome-server -e normal --target
  <triple>` except the `gnome-*` workspace crates, with its license expression and the texts of its `LICENSE*`,
  `COPYING*` and `NOTICE*` files found through `cargo metadata`; a crate that ships no license file gets the SPDX text
  from `frontend/scripts/licenses/` — d2a adds the texts that are missing there, e.g. MIT, Apache-2.0, ISC,
  BSD-3-Clause, Unicode-3.0, CDLA-Permissive-2.0); `npm-bundled.txt` (the notices file); `vendor/<dir>/LICENSE` and
  `THIRD-PARTY-LICENSES.txt` copied from `dist/vendor/`, plus `vendor/<dir>/SOURCE.txt` with the npm tarball URL and
  integrity hash from the lock and the verified repository, commit and tree hash from `scripts/third-party-sources.json`
  (D27; no vendored package records `gitHead`, so the mapping is the only revision record; `--third-party-source`
  fetches those sources, §4.5); `holywisp/{LICENSE,LICENSE.musl,BUILDINFO}` from
  `services/holywisp/build/<arch>/`; `sqlite.txt` (SQLite's public-domain dedication).
- Caddy (Apache-2.0) and gluetun (MIT) are pulled by the compose file, not redistributed in GNOME's artifact;
  `docs/DEPLOYMENT.md` names them and their licenses.

### 4.5 `scripts/release.sh` and the artifact (D13)

`scripts/release.sh [--version V] [--arch x86_64,aarch64] [--out release/] [--image] [--verify-reproducible]
[--allow-budget-overrun "<reason>"] [--skip-audit "<reason>"] [--third-party-source | --no-third-party-source]
[--allow-missing-source "<reason>"] [--sign <ssh-key-file|gpg-key-id>]`; it runs under `umask 022` and
`npm ci --ignore-scripts` everywhere:

1. **Preflight**: Node ≥ 22.12, Docker with buildx; `Cargo.lock` and `frontend/package-lock.json` present; the
   version of `Cargo.toml` (workspace) equals `frontend/package.json`'s (else exit 2); `scripts/audit.sh` passes
   (unless `--skip-audit`, whose reason goes into `BUILDINFO`) and its image audit (D24) is at most 30 days old.
2. **Source tarball** `gnome-<v>-src.tar.gz`, built from the **allow-list** `scripts/lib/source-allowlist.txt`
   (the source directories and top-level files, e.g. `backend/`, `crates/`, `database/`, `frontend/` without
   `node_modules/` and `dist/`, `services/`, `deployment/`, `scripts/`, `bench/` without `results/raw/`, `tests/`,
   `docs/`, `Cargo.*`, `LICENSE`, `README.md`) with anchored excludes that mirror every `.gitignore` of the tree
   (`/tests/e2e/engine/results/`, `/tests/e2e/test-results/`, `/tests/e2e/playwright-report/`,
   `/tests/e2e/spike-engine-host/results/`, `/services/holywisp/build/`, `/deployment/secrets/`, `/deployment/.env`,
   `.claude/`, …). The packed member
   list is then **deny-scanned** by name and content (`secret.key`, `*.db*`, `*.pem`, `*.key`, `.env*` except
   `.env.example`, `-----BEGIN … PRIVATE KEY-----` blocks, `_authToken`, `/home/` strings outside documentation,
   any file over 4 MiB outside `docs/screenshots/`), and any hit fails the release. `SOURCE_DATE_EPOCH` = the newest
   mtime among the allow-listed files; `tar --sort=name --mtime=@$SOURCE_DATE_EPOCH --owner=0 --group=0
   --numeric-owner --mode=u+rwX,go+rX,go-w --pax-option=delete=atime,delete=ctime | gzip -n -9`;
   `GNOME_BUILD_ID=<v>+<first 12 hex of its SHA-256>`.
3. **Everything else is built from that tarball**, unpacked into `release/work/src/` (so the artifact provably comes
   from the published source): `npm ci --ignore-scripts`, `npm run build` (`build:release` after d2b),
   `postbuild.mjs --release`.
4. **Binaries**: `docker buildx build -f deployment/Dockerfile --target server-out --platform linux/<amd64|arm64>
   --build-arg SOURCE_DATE_EPOCH --build-arg GNOME_BUILD_ID --build-arg GNOME_DEFAULT_SOURCE_URL --build-arg
   CARGO_BUILD_JOBS --output type=local,dest=…` per architecture (static musl, the remap flags of D5; the Alpine
   build packages' versions are written to `BUILDINFO` and compared with the pins in the Dockerfile, a drift fails);
   HolyWisp from `services/holywisp/fetch-build.sh --arch all` (its own pin and tree-hash verification).
5. **Licenses** per architecture (§4.4).
6. **Assemble** `gnome-<v>-linux-<arch>/`: `bin/gnome-server`, `bin/holywisp`, `share/gnome/dist/`,
   `share/licenses/`, `etc/` (`gnome.env.example`, `route-b.env.example`, `Caddyfile` and
   `caddy/tls-{acme,files}.caddy`, `holywisp.conf` = `gnome.conf`, `vpn-egress.conf.example`,
   `systemd/{gnome-server,holywisp,holywisp@}.service` and the drop-in examples), `libexec/check-egress`,
   `README.txt` (install pointer to DEPLOYMENT.md), `BUILDINFO` (version, build id, `SOURCE_DATE_EPOCH`, source
   tarball SHA-256, toolchain and Alpine package versions and base-image digests, `RUSTFLAGS`, the Dockerfile build
   arguments, HolyWisp's `BUILDINFO`, the budget table, the audit result or skip reason, any overrun or missing-source
   reason), `SHA256SUMS` (every file inside; for checks after installation only).
7. **Tarballs** with the flags of step 2, an outer `SHA256SUMS` over the artifacts, the source tarball, the
   third-party source tarball and `BUILDINFO-images.txt`.
8. `--image`: the gnome-server images of both architectures through d3's Dockerfile (`--output type=oci` when the
   local Docker cannot load multi-platform images); digests and sizes into `BUILDINFO-images.txt`; OCI labels point
   at both source archives.
9. `--verify-reproducible`: steps 3–7 again in `release/work2/` **without any cache**: a throwaway buildx builder
   (`docker buildx create --name gnome-repro-<pid>`, removed afterwards, also on failure) with `--no-cache`,
   `fetch-build.sh --no-cache`, fresh `CARGO_HOME` and npm caches in the work directory; the outer `SHA256SUMS` must
   be identical; on a difference the script names the first differing file and both hashes. The second pass's
   BuildKit progress output must show no `CACHED` step, which `BUILDINFO` records. (A rebuild in BuildKit's cache
   would compare the first pass's binaries with themselves.)
10. **Third-party source** (D27; default on unless `--no-third-party-source`, which a published release may not
   use): for every shipped copyleft or MPL component, `scripts/third-party-sources.json` gives the repository, commit
   and tree hash; the script fetches by commit (`git fetch --depth 1 <repo> <commit>` into the work directory),
   verifies the tree hash, packs the sources together with the integrity-checked npm tarballs GNOME ships and the
   `SOURCE.txt` files into `gnome-<v>-third-party-src.tar.gz`, and fails on a copyleft component without a verified
   entry unless `--allow-missing-source "<reason>"` (recorded in `BUILDINFO`; needs a decisions-log row).
11. `--sign <key>`: `ssh-keygen -Y sign -n gnome-release -f <key>` (or `gpg --detach-sign` for a GnuPG key id) over
   the outer `SHA256SUMS`, written as `SHA256SUMS.sig`; the key and its policy are the maintainer's (§12 OI1); the
   repository commits the matching `scripts/allowed_signers` once a key exists. `docs/DEPLOYMENT.md` verifies the
   signature, then `sha256sum -c --ignore-missing SHA256SUMS`, **both before unpacking**; the inner `SHA256SUMS`
   travels inside the tarball and proves nothing about it.

### 4.6 Shared frontend files (d2b, after step 3's integration)

- `frontend/package.json` scripts only: `"build:release": "npm run build && node scripts/postbuild.mjs --release"`,
  `"release:check": "node scripts/postbuild.mjs --check"`. No dependency, no version change.
- `frontend/vite.config.ts`: `chunkGraph()` is added to `worker.plugins` too (today it runs only in `plugins`, so
  worker bundles such as step 3's builder Worker are missing from the graph; a requirement, not an option); the
  chunk-graph plugin also writes each module's rendered length (if rolldown exposes it; otherwise bundle-report keeps
  chunk-level sizes); `build.modulePreload: { polyfill: false }` only if
  bundle-report shows the polyfill in the startup set (both tested browsers support `modulepreload` natively);
  license comments out of the chunks only through an option the installed Vite 8.3.7 documents (the notices file
  carries the texts); nothing that changes code splitting or the graph rules of `build.mjs`.
- `frontend/vite.sw.config.ts`: the same license-comment option, and a chunk graph of its own
  (`.vite/gnome-sw-chunks.json`; required, so `sw.js`'s packages reach the notices and the audit classification).
Each change is measured with bundle-report (before/after) and needs `npm run check`, `npm test`, the `build` suite
and BR-rows green.

**Startup set (d2b, after Wave C's integration).** The restyle added 30 % to the app's startup JS (106.6 → 138.9 KB
gzip, PROGRESS: "Wave D budget item"). d2b runs bundle-report against baseline-1, names the modules that grew, and
either cuts them from the startup set (static → dynamic imports, preload hints; only in app files its report names
before editing them, §2.2) or justifies each in a decisions row; P1 and P2 before/after on adjacent snapshots (RB13,
RB14). It also records the vendor revalidations per engine-host start (`/vendor/**` is served `no-cache`, so every
start revalidates each vendor script) and settles them in a decisions row: versioned vendor URLs (a contract change
for the engine host, the service worker and `static_files.rs`, which would then need its owner) or accepting the
revalidations with their measured cost.

### 4.7 Acceptance and tests

- **BR-rows** (`tests/e2e/engine/suites/build-release.mjs`, standalone: builds its own release `dist/` of the tree
  with a fixed `GNOME_BUILD_ID`, or takes `--dist`):
  BR1 no `.map` file anywhere and no `sourceMappingURL` in GNOME's own files; BR2 every vendor file byte-identical to
  `node_modules` and the removed files are exactly the packages' `.map` files; BR3 `postbuild --check` (siblings
  complete, decompress to their files, none for `engine/*.html`); BR4 a real gnome-server on the release `dist/`
  answers `Accept-Encoding: br` with `Content-Encoding: br`, ETag `"<tag>-br"` and `Vary: Accept-Encoding`, the same
  for gzip and identity, `304` per variant, `/engine/` never encoded, `/.vite/…` and `/.gnome/…` `404`; BR5 the
  build-time budgets of §7 (table in the row's notes); BR6 release hygiene: no `e2e-driver/`, no test-only strings,
  no absolute build paths (`/home/`, `/root/`, `/tmp/`), no private-key or token patterns in any served file, and the
  release binary contains neither `gnome_alloc_` nor `/home/`; BR7 the notices file lists every package found in
  GNOME's chunks, its worker bundles and `sw.js` (the three graphs; a package imported by `src/sw/**` or a worker but
  missing from the notices fails), each with its version, repository, tarball URL and license text, every vendor directory has `LICENSE` and `THIRD-PARTY-LICENSES.txt`, the
  fonts' OFL texts are present, the file is served at `/licenses/THIRD-PARTY-NOTICES.txt` on the app origin; BR8 two
  release builds of one snapshot give identical `.gnome/files.json`; BR9 the release `dist/` works in Chromium and
  Firefox behind the HTTPS front: the app loads, the engine badge reads `SJ`, a local fixture page loads through
  Scramjet and through Ultraviolet (no e2e driver: the release build has none).
- **RL-rows** (`scripts/release.sh`, run by d2a and by the integration step): RL1 artifacts and both `SHA256SUMS`
  verify (`sha256sum -c`); RL2 `--verify-reproducible` identical for both architectures, the second pass with no cached step; RL3 the layout and every
  `BUILDINFO` field; RL4 no build paths in the binaries (`strings` finds no `/home/`, `/root/` or registry source
  paths); RL5 the licenses bundle is complete (every crate of the target's graph, `gnome-server/rust-std.txt` and
  `gnome-server/LICENSE.musl`, every bundled npm package, every vendor directory with its verified revision, HolyWisp
  and its musl, SQLite, the AGPL text and `SOURCE.txt`), and the source tarball has the root `LICENSE`; RL6 the artifact runs: unpacked,
  `bin/gnome-server config check` with the example values on loopback, `serve` on lane ports of `127.0.0.1`, `/api/health` ok,
  `/engine/` `200`, a brotli sibling served; `bin/holywisp --version` reports the pin (aarch64: in an unprivileged
  container under QEMU user-mode, `--version` and `config check` only); RL7 signing: with a throwaway SSH key in the
  scratch directory, `SHA256SUMS.sig` verifies against an `allowed_signers` file, and a tarball or `SHA256SUMS` with one
  changed byte fails the documented verification; RL8 source-tarball hygiene: a scratch copy of the tree with one
  planted file of each denied kind (`secret.key`, `gnome.db`, a `*.pem` with a private-key block, `.npmrc` with
  `_authToken`, `deployment/secrets/admin_token`, `tests/e2e/engine/results/x.log`, a `.env`) makes `release.sh` fail
  naming each, and the real tarball contains no ignored or generated path and no `/home/` string outside docs; RL9
  rebuild from the published source tarball in a clean container with `umask 002` gives the same outer
  `SHA256SUMS`; RL10 `gnome-<v>-third-party-src.tar.gz` holds every copyleft and MPL component at its mapped commit
  (tree hashes re-verified) and the shipped npm tarballs (integrity re-verified); a component removed from
  `third-party-sources.json` makes the release fail; the release binary's `GNOME_SOURCE_URL` default points at the
  archives.
- **Unit tests**: `postbuild.test.ts` (eligibility rules, the 10 % rule, determinism, a corrupted sibling fails,
  maps removed only with `--release`, the overrun exit code) and `third-party-notices.test.ts` (packages found from a
  chunk-graph fixture, a missing license file fails) run in `npm test` (Vitest already includes
  `scripts/**/*.test.ts`).
- **Acceptance**: every BR- and RL-row passes on the final tree; `docs/BENCHMARKS.md` "Sizes" has the release `dist/`,
  the startup sets and the artifact sizes from bundle-report and `release.sh`.

## 5. Lane d3: deployment

d3 ships three supported ways to run GNOME in production, all built from the same release recipe: **(A)** the Docker
stack (`deployment/compose.yml`: Caddy → gnome-server → HolyWisp, optional VPN egress), **(B)** the release artifact
with systemd units (`gnome-server.service` here, `holywisp.service`/`holywisp@.service` from `services/holywisp/`) behind
the same Caddy configuration, and **(C)** either of them on a Raspberry Pi 4 (64-bit OS). Every deliverable is checked
statically and, where this machine allows it, run unprivileged (§5.8); nothing boots systemd and nothing registers
binfmt.

Measured for this section (2026-11-18, Docker 29.9.2, Docker Compose 5.6.1; probe in the session scratchpad
`work-wave-d-plan/compose-secrets/`): Compose bind-mounts a file secret with its host owner and mode and **ignores
`uid`, `gid` and `mode` outside Swarm** (it warns); a 0600 secret owned by the operator (UID 1000) is unreadable for a
container user 65532, while `group_add: ["<operator's GID>"]` plus mode 0640 makes it readable for that user and nobody
else in the container. The compose files and D23 are written for that behaviour (§5.2, §6.2).

### 5.1 The gnome-server image (`deployment/Dockerfile`, d3a)

Stages (BuildKit, `# syntax=docker/dockerfile:1`; base images pinned by multi-arch index digest like
`services/holywisp/Dockerfile`; build context = the repository root with `deployment/Dockerfile.dockerignore`, which
admits only what the stages `COPY`: `Cargo.toml`, `Cargo.lock`, `backend/`, `crates/`, `database/`, `frontend/`
without `node_modules/` and `dist/`, `scripts/` and `LICENSE` (not `deployment/`), and denies, also inside admitted
directories, `**/.env*` (except `.env.example`), `deployment/secrets/`, `**/*.pem`, `**/*.key`, `**/secret.key`,
`**/*.db*`, `**/test-results/`, `**/playwright-report/`, `target/`, `data/`, `release/`, `.claude/`,
`services/holywisp/build/`; `.env*` alone would match only at the context root, and Vite would embed the `VITE_*`
values of a `frontend/.env.production.local` into served JavaScript; `check.sh` asserts these lines):

| Stage | Platform | What |
| --- | --- | --- |
| `xx` | build | `tonistiigi/xx:1.10.0` at the digest HolyWisp uses |
| `frontend` | build | Node of the development major (26) on Alpine: `npm ci --ignore-scripts` (network), then with `--network=none` `npm run build` and `node scripts/postbuild.mjs --release` (d2a; `build:release` after d2b); built once, shared by both architectures (the output does not depend on the target) |
| `rust` | build | the Rust toolchain image of the version in use (Alpine), `clang lld` + `xx-apk add musl-dev gcc` for the target sysroot, every Alpine package pinned to an exact version (`apk add pkg=<v>`; the versions go into `BUILDINFO`) and musl's `COPYRIGHT` vendored with a version check, as HolyWisp's Dockerfile does; build arguments passed through to cargo: `CARGO_BUILD_JOBS` (default 3, §0), `CARGO_FEATURES` and `CARGO_PROFILE_RELEASE_*` (d1's A/B builds; I- and RL-rows record the values used), `GNOME_DEFAULT_SOURCE_URL` (D27); `cargo fetch --locked` (network), then with `--network=none` `xx-cargo build --release --locked --offline -p gnome-server` → static musl `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`; `RUSTFLAGS` with the remap flags of D5 (d1 supplies the exact list); `GNOME_BUILD_ID` and `SOURCE_DATE_EPOCH` from build arguments; `xx-verify --static`; for arm64, `qemu-aarch64 ./gnome-server version` inside the stage (QEMU user-mode in the container, never binfmt); writes `cargo metadata --format-version 1 --locked --offline --filter-platform <triple>` and the license files of every crate in the graph for the licenses stage |
| `licenses` | build | Node: `scripts/third-party-licenses.mjs --cargo-metadata <json> --crate-src <dir> --dist <release dist> --out /out` (d2a adds these two flags so the script runs without cargo; §4.4) |
| `server-out` | — | `FROM scratch`: only `/gnome-server` (+ `/BUILDINFO`); what `scripts/release.sh` exports per architecture (§4.5 step 4) |
| `runtime` (default) | target | `FROM scratch`: `/usr/local/bin/gnome-server`, the release `dist/` at `/usr/share/gnome/dist`, the licenses bundle at `/usr/share/licenses/gnome/`, an empty `/tmp` (1777) and `/var/lib/gnome` (65532:65532, 0700, `VOLUME`); `ENV GNOME_DATA_DIR=/var/lib/gnome GNOME_STATIC_DIR=/usr/share/gnome/dist GNOME_BIND=0.0.0.0:8080 GNOME_LOG_FORMAT=json`; `USER 65532:65532`; `EXPOSE 8080 8081`; `ENTRYPOINT ["/usr/local/bin/gnome-server"]`, `CMD ["serve"]`; OCI labels (`title`, `version`, `revision` = `GNOME_BUILD_ID`, `source` = the repository, `licenses` = `AGPL-3.0-only`, and two labels (names chosen by d3a) pointing at the source and third-party source archives of D27); `HEALTHCHECK CMD ["/usr/local/bin/gnome-server","health"]` added by d3b (§5.5) |

Build commands (documented in `deployment/README.md`):

```sh
docker buildx build -f deployment/Dockerfile --platform linux/amd64 --build-arg CARGO_BUILD_JOBS=3 -t gnome-server:dev --load .
docker buildx build -f deployment/Dockerfile --platform linux/amd64,linux/arm64 \
  --build-arg GNOME_BUILD_ID=<id> --build-arg SOURCE_DATE_EPOCH=<s> -t <registry>/gnome-server:<v> --push .
```

Rules: no shell, package manager or CA bundle in the runtime image (gnome-net's TLS uses the compiled-in `webpki-roots`;
C2 removes the code that reads a system store, §3.6); nothing in the image is writable except the volume and the
container's tmpfs; the binary in the image is byte-identical to the artifact's `bin/gnome-server` of the same build id
and architecture (row I6); the image never contains `.map` files, the e2e driver, `bench/` or test fixtures (row I3).
BuildKit `--output …,rewrite-timestamp=true` with `SOURCE_DATE_EPOCH` is used, and row I7 records whether two builds
of one snapshot give the same image digest (recorded, not required: the artifact is the reproducible deliverable).

### 5.2 The compose stack (`deployment/compose.yml`, `compose.vpn.yml`, `compose.test.yml`, `.env.example`)

```
internet ──80/443──▶ caddy (edge 172.30.80.2) ──▶ gnome (edge 172.30.80.10: :8080 app, :8081 proxy role)
                                                    gnome (wisp 172.30.81.10) ──▶ holywisp (wisp 172.30.81.2:6001)
                     optional compose.vpn.yml:      gnome (gnome-egress 172.30.64.10) ──▶ gluetun 172.30.64.2:<port>
                                                    (one HolyWisp per exit inside gluetun's network namespace)
```

| Service | Image / build | Settings |
| --- | --- | --- |
| `caddy` | `${GNOME_CADDY_IMAGE:-gnome-caddy:<v>}`, `build: ./caddy` (§5.3) | the only service with `ports:` (`${GNOME_HTTP_PORT:-80}:8080`, `${GNOME_HTTPS_PORT:-443}:8443`, TCP only); `user: 65532:65532`, `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, `mem_limit: ${GNOME_CADDY_MEM_LIMIT:-512m}`, `pids_limit: 512` (estimates; DC/DP rows record peak use), volumes `caddy-data:/data`, `caddy-config:/config`, the `Caddyfile` and the chosen TLS snippet (`./caddy/tls-${GNOME_TLS_MODE:-acme}.caddy`) read-only; in files mode `./secrets/tls` read-only at `/run/secrets/tls` (`cert.pem`, `key.pem`; directory 0750, files 0640, the same `group_add` as `gnome`); `depends_on: gnome` (`service_healthy` once d3b adds the health check) |
| `gnome` | `${GNOME_SERVER_IMAGE:-gnome-server:<v>}`, `build: {context: .., dockerfile: deployment/Dockerfile}` | `GNOME_BIND=172.30.80.10:8080`, `GNOME_PROXY_BIND=172.30.80.10:8081` (no listener on the `wisp` side), `GNOME_PUBLIC_ORIGINS=https://${GNOME_APP_HOST}`, `GNOME_PROXY_ORIGIN=https://${GNOME_PROXY_HOST}`, `GNOME_TRUSTED_PROXIES=172.30.80.2/32` (Caddy only), `GNOME_WISP_UPSTREAM=172.30.81.2:6001`, `GNOME_HSTS=${GNOME_HSTS:-true}` (every request of the stack is HTTPS: Caddy answers `http://` with a `308`, and serves nothing without a valid certificate; one-year `max-age` without `includeSubDomains`), `GNOME_ACCESS_MODE`, `GNOME_SOURCE_URL` and the rest passed through from `.env`; the admin listener keeps its default `127.0.0.1:9091` (the container's loopback); secrets as files: `./secrets` mounted read-only at `/run/secrets` (outside Swarm a Compose `secrets:` entry is the same bind mount, but it fails when its file is missing, and every secret here is optional) with `group_add: ["${GNOME_SECRETS_GID:-65532}"]` and `GNOME_ADMIN_TOKEN_FILE`, `GNOME_ACCESS_CODE_FILE`, `GNOME_SECRET_KEY_FILE` passed from `.env` with empty defaults (empty = unset, §6.2; d3b after d4b's M1); `user: 65532:65532`, `read_only`, `tmpfs: /tmp:size=16m,noexec,nosuid,nodev`, `cap_drop: [ALL]`, `no-new-privileges`, `ulimits: nofile 65536:65536`, `pids_limit: 1024`, `mem_limit: ${GNOME_MEM_LIMIT:-1g}`, volume `gnome-data:/var/lib/gnome`, `stop_grace_period: 20s` (10 s drain + WAL checkpoint), no `init` (gnome-server handles SIGTERM as PID 1 and starts no children) |
| `holywisp` | `${GNOME_HOLYWISP_IMAGE:-gnome-holywisp:0.1.0-e0a0f15}`, `build: ../services/holywisp` | `command: ["--host", "0.0.0.0", "--trusted-proxy", "172.30.81.10/32"]` (appended to the image's `--config`; HolyWisp README "Docker"); `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, `ulimits: nofile 65536:65536`, `pids_limit: 128`, `mem_limit: 1g`; no `init` (tini would forward SIGHUP, which stops HolyWisp); no health check (the image has no client; gnome-server's `wisp.health` job watches it) |

Networks: `edge` (172.30.80.0/24 plus a ULA IPv6 /64 with `enable_ipv6: true`: caddy, gnome) and `wisp`
(172.30.81.0/24: gnome, holywisp), neither `internal`. `edge` is dual-stack because an IPv4-only bridge makes Docker's
userland proxy forward IPv6 clients (and hairpin traffic) with the bridge gateway's address, so every IPv6 user
would share one client key for the rate limits, the Wisp caps and the in-flight cap; with an IPv6 subnet, Docker
(≥ 27) NATs IPv6 in `ip6tables` and keeps the source address (row DP5 checks what this machine allows; the guide
documents the limitation and the `network_mode: host` alternative for Caddy for hosts that cannot do it). Inside its container Caddy
listens on the wildcard (dual-stack). `GNOME_NET_PREFIX` (default `172.30`) moves every IPv4 subnet and fixed address
of the stack (`<prefix>.80.0/24`, `<prefix>.81.0/24`, `<prefix>.64.0/24` for the VPN override; the VPN override's
HolyWisp exit configuration and `profiles.toml` addresses follow it, which `deployment/README.md` documents and
`check.sh` compares) and `GNOME_NET6_PREFIX` (default a fixed ULA /64) the IPv6 subnet, when the LAN or another
Docker network uses them
(Caddy needs the internet for ACME, HolyWisp for browsing, gnome-server for filter lists and catalog feeds); every
range stays outside `10.64.0.0/10` (Mullvad, `services/vpn/README.md`). HolyWisp's egress policy refuses private
destinations, so it reaches neither Caddy, gnome-server nor the host's LAN; Caddy cannot reach HolyWisp (no shared
network); only gnome-server is on both. All services: `restart: unless-stopped`, `logging: json-file` with
`max-size: 10m`, `max-file: 3` (bounded logs on an SD card).

- **`.env.example`** names every variable the files read, with its default and one line each: `GNOME_APP_HOST`,
  `GNOME_PROXY_HOST`, `ACME_EMAIL`, `GNOME_TLS_MODE` (`acme` · `files`), `GNOME_TLS_CERT_FILE`/`GNOME_TLS_KEY_FILE`
  (files mode; default `/run/secrets/tls/cert.pem` and `key.pem`), `GNOME_HTTP_PORT`, `GNOME_HTTPS_PORT`, the three
  image variables, `GNOME_NET_PREFIX`, `GNOME_NET6_PREFIX`, `GNOME_SECRETS_GID`, `GNOME_MEM_LIMIT`,
  `GNOME_CADDY_MEM_LIMIT`, `GNOME_HSTS=true` (with a comment on the one-year pin), `GNOME_ACCESS_MODE`,
  `GNOME_REGISTRATION=closed` (with a comment: open registration lets anyone store up to the sync quotas, D20),
  `GNOME_SOURCE_URL` (the release's default, D27), `GNOME_LOG`, `GNOME_LOG_IPS`, and the three `_FILE` variables
  (commented, e.g. `GNOME_ADMIN_TOKEN_FILE=/run/secrets/admin_token`). No secret values: secrets live in
  `deployment/secrets/` (directory 0750, files 0640, group `GNOME_SECRETS_GID`; ignored by `.gitignore`, both build
  contexts and the source tarball), created by `deployment/init-secrets.sh [--admin-token] [--secret-key]
  [--access-code] [--tls-cert FILE --tls-key FILE] [--allow-shared-group]` (random values, never printed; it writes
  `GNOME_SECRETS_GID` into `deployment/.env` itself, `0` under rootless Docker, and refuses a group with other members
  unless `--allow-shared-group`, D23); without a secret key file the key generated into the data volume is used.
- **`compose.vpn.yml`** (override, used as `docker compose -f compose.yml -f compose.vpn.yml …`; not a Compose
  profile, because the VPN's required variables would then fail interpolation for every deployment): recipe A of
  `services/vpn/README.md` adapted to the stack (gluetun with `cap_add: [NET_ADMIN]` and `/dev/net/tun` as its
  documented requirement, never `privileged`; gluetun is the **one documented exception** to the container policy:
  Docker's default capabilities plus `NET_ADMIN`, a writable root (it writes its own state), `no-new-privileges:
  true`, `mem_limit` and `pids_limit`; it reads the operator's 0600 WireGuard key as root, which `cap_drop: ALL`
  would prevent; any further hardening goes into both recipes in one d3b change marked [unproven], because gluetun is
  never started here; its control-server key moves from the environment into gluetun's auth-config file mounted from
  `deployment/secrets/`; two example HolyWisp exits with `network_mode: "service:gluetun"`;
  `gnome` joins `gnome-egress` at 172.30.64.10 and reads `GNOME_VPN_PROFILES`). `check.sh` compares the normalized
  `docker compose config` of its gluetun and HolyWisp services with `services/vpn/compose.example.yml`'s (image,
  capabilities, devices, environment keys, read-only, ulimits, network mode; the limits added by the stack are listed
  as the allowed differences), so the two recipes cannot drift. It is
  checked statically only (it needs a VPN account and is never started here, §10).
- **`compose.test.yml`** (the e2e override, d3a's suites only): TLS from files (the throwaway CA of
  `backend-https.mjs` `makeCerts`), Caddy published on `127.0.0.1:<lane ports>`, hostnames `gnome.localhost` /
  `p.gnome.localhost`, locally built images, a `target` fixture service with `network_mode: "service:holywisp"` and
  the spike's test-only allow-loopback overlay mounted into HolyWisp (so a local page is reachable offline through the
  real chain), `GNOME_FILTERS_REFRESH_HOURS=0`, `GNOME_CATALOG_REFRESH_HOURS=0`, `GNOME_OSS_FETCH=manual`, the TLS
  files through the same `secrets/tls` mount as production files mode.
- **`systemd/route-b.env.example`** (route B: the artifact with systemd behind a Caddy on the same host):
  `CADDY_HTTP_PORT=80`, `CADDY_HTTPS_PORT=443`, `GNOME_APP_UPSTREAM=127.0.0.1:8080`,
  `GNOME_PROXY_UPSTREAM=127.0.0.1:8081`, with `gnome.env.example` setting `GNOME_BIND=127.0.0.1:8080` and
  `GNOME_PROXY_BIND=127.0.0.1:8081` (gnome-server's default `0.0.0.0:8080` would collide with the Caddyfile's
  container port 8080); `check.sh` asserts that the examples' ports do not collide.
- Admin access in the stack: `docker compose exec gnome gnome-server admin get /admin/diagnostics` (d3b). Metrics
  scraping is documented in `docs/DEPLOYMENT.md` as an operator variant (the admin listener on an extra `internal:
  true` network shared only with the scraper, `GNOME_ADMIN_ALLOW_REMOTE=true` + `GNOME_ADMIN_TOKEN_FILE`, never
  `ports:`), not shipped as a file.

### 5.3 Caddy (`deployment/Caddyfile`, `deployment/caddy/{Dockerfile,tls-acme.caddy,tls-files.caddy}`)

One Caddyfile serves production and the tests; what differs comes from environment placeholders. Exact properties
(D16; the layout is the builder's):

- **Global options**: `admin {$CADDY_ADMIN:localhost:2019}` (inside Caddy's own container; the tests use `off`, DC6
  a Unix socket in the scratch directory, §0), `http_port {$CADDY_HTTP_PORT:8080}`, `https_port
  {$CADDY_HTTPS_PORT:8443}`, `default_bind` only when `CADDY_BIND` is set (through an imported snippet chosen by the
  environment, like the TLS snippet; unset = Go's dual-stack wildcard inside the container; the test suites set
  `CADDY_BIND=127.0.0.1` and `deploy-lib.mjs` refuses to start without it), `auto_https disable_redirects` (the
  redirect sites below send users to port 443, not to the internal 8443), `email {$ACME_EMAIL}`, the `servers`
  options `protocols h1 h2`, `max_header_size 4MB` and `timeouts` (`read_header 20s`, `idle 5m`), and the default
  logger with a `filter` encoder: `request>remote_ip`, `request>client_ip`, `request>remote_port` and
  `request>headers` deleted (masked with `ip_mask` instead when `GNOME_LOG_IPS=true`), `request>uri` reduced to its
  path with a `regexp` filter (Wisp tickets travel as `?t=`), access logs off. This matches what About tells users
  ("requested paths without query strings; IP addresses only if the operator turns that on").
  `trusted_proxies` stays unset (Caddy replaces client-sent `X-Forwarded-For` with the peer address); a CDN in front
  of Caddy needs it and the guide says how (§5.7).
- **Two HTTPS site blocks**, `{$GNOME_APP_HOST}` → `reverse_proxy {$GNOME_APP_UPSTREAM:172.30.80.10:8080}` and
  `{$GNOME_PROXY_HOST}` → `reverse_proxy {$GNOME_PROXY_UPSTREAM:172.30.80.10:8081}`, each with `import tls` (the
  snippet file chosen by `GNOME_TLS_MODE`: `tls-acme.caddy` defines an empty `(tls)` snippet, `tls-files.caddy`
  `tls {$GNOME_TLS_CERT_FILE} {$GNOME_TLS_KEY_FILE}`), `stream_close_delay 5m` (a Caddy reload keeps open Wisp
  connections for up to 5 minutes instead of closing them at once), the upstream `transport http { dial_timeout 3s;
  response_header_timeout 35s }` (longer than gnome-server's 30 s request timeout; a full or stopped gnome-server
  then gives Caddy's strict `502`/`504` instead of a hang), `header -Server`, Caddy's default `Host` and
  `X-Forwarded-*` handling, no `encode` (static files are precompressed; API answers stay uncompressed, §12), no other
  handler. The proxy hostname's site also has `request_header -Cookie` (D16: no proxy-role route reads a cookie; DC1,
  DP1 and the full runner through Caddy prove nothing breaks, and if a later proxy-role route needs a cookie, only
  its names are kept).
- **Caddy's own answers** on both hostnames: `handle_errors` sets `Content-Security-Policy: default-src 'none';
  form-action 'none'; base-uri 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Cache-Control:
  no-store`, `Referrer-Policy: no-referrer`, `Content-Type: text/plain; charset=utf-8` and a plain-text body
  (`<status> <text>`), plus `Strict-Transport-Security` with gnome-server's value when `GNOME_HSTS=true`; the policy
  string is byte-identical to gnome-server's `AUTOMATIC_ANSWER_HEADERS` (`csp::NOTHING_RUNS_UNFRAMED`), which DC2
  asserts; the `http://` site for both hostnames answers `redir https://{host}{uri} 308` with the same headers. Go answers oversized or unparsable heads before any handler runs, so those carry no policy: the 4 MB limit
  (above Chromium's 2 MB URL limit plus ≈ 740 KB of cookies, D19) keeps every browser request out of that path and in
  gnome-server's hardened answers. This settles the deferred reverse-proxy item for Caddy; rows DC2, DC3 and DC8 prove
  it.
- **WebSockets**: `reverse_proxy` passes `/wisp/` and `/wisp/p/<id>/` upgrades without configuration. If a browser
  uses WebSockets over HTTP/2 to Caddy (extended CONNECT) and that path fails (row DC1), the fallback is `protocols
  h1` for the server (a decisions-log row with the measured cost to the app's first load, P1); h2 stays otherwise.
- **`deployment/caddy/Dockerfile`**: `FROM` the official Caddy 2 image pinned by digest (Apache-2.0); removes the
  binary's file capability (`cap_net_bind_service`, which makes `exec` fail under `cap_drop: ALL`), creates `/data`
  and `/config` owned by 65532, `USER 65532:65532`, internal ports 8080/8443; `caddy version` recorded in its labels.
  Row DC7 proves non-root, no capabilities, read-only root, `getcap` empty.

The guide states the conditions any other front must meet (only Caddy with this file is tested): a request-head limit
above what browsers send, the strict policy above on every answer it writes itself (or no such answers), WebSocket
upgrades passed without an idle timeout shorter than the transports' keep-alive, the original `Host` kept (or
`X-Forwarded-Host` set), `X-Forwarded-Proto` and `X-Forwarded-Host` overwritten (never appended to client copies:
gnome-server reads their first value), its address in `GNOME_TRUSTED_PROXIES` (otherwise, under
`GNOME_COOKIE_SECURE=auto`, gnome-server would see plain HTTP; §6.3 makes all-`https://` origins imply `Secure` and
warns), `Cookie` removed on the proxy hostname, and logs without client addresses or query strings. A **CDN in front
of Caddy**: Caddy's `trusted_proxies` (with `trusted_proxies_strict`) and `GNOME_TRUSTED_PROXIES` both list the CDN's
ranges (otherwise every user becomes the CDN edge's address and shares one client key), and the CDN overwrites
`X-Forwarded-Host` and `X-Forwarded-Proto`. A CDN whose documented header limit is below browser
limits (Cloudflare's proxied mode documents 32 KB of request headers; not tested here) does not meet the first
condition for the proxy hostname.

### 5.4 The systemd unit and its checks (`deployment/systemd/`, `deployment/tests/syscalls.sh`)

`deployment/systemd/gnome-server.service` (D17), for the artifact's static musl binary installed as
`/usr/local/bin/gnome-server` with the release `dist/` at `/usr/local/share/gnome/dist`:

- `[Unit]`: `After=network-online.target holywisp.service`, `Wants=network-online.target holywisp.service`,
  `StartLimitIntervalSec=0`.
- `[Service]`: `Type=exec`; `EnvironmentFile=/etc/gnome/gnome.env` (from `gnome.env.example`: no secrets; installed
  0600 `root:root` by the guide's commands; `config check` warns when a secret arrives as a plain variable while
  `INVOCATION_ID` shows it runs under systemd);
  `Environment=` for `GNOME_DATA_DIR=%S/gnome`, `GNOME_STATIC_DIR=/usr/local/share/gnome/dist`,
  `GNOME_ADMIN_BIND=127.0.0.1:9091` and `GNOME_LOG_FORMAT=json`; secrets through a drop-in the operator enables per
  secret (`deployment/systemd/gnome-server.service.d/credentials.conf.example`:
  `LoadCredential=admin_token:/etc/gnome/credentials/admin_token` with
  `Environment=GNOME_ADMIN_TOKEN_FILE=%d/admin_token`, the same for `access_code` and `secret_key`; a
  `LoadCredential=` whose file is missing stops the unit, so none is on by default, but the admin token is part of
  the guide's **first install**: write `/etc/gnome/credentials/admin_token` (0600 root) and enable its drop-in,
  because without a token any local user or process passes the admin listener's loopback `Host` check and can read
  `/admin/diagnostics` and `POST /admin/filters/refresh`);
  `ExecStartPre=/usr/local/bin/gnome-server config check`; `ExecStart=/usr/local/bin/gnome-server serve`; no `ExecReload` (static files and
  configuration are read at start: restart); `Restart=always`, `RestartSec=2s`, `RestartSteps=6`,
  `RestartMaxDelaySec=60s`, `RestartPreventExitStatus=2`, `TimeoutStopSec=20s`.
- Identity and limits: `DynamicUser=yes`, `StateDirectory=gnome` (mode 0700), `UMask=0077`, `LimitNOFILE=65536` (the
  deferred item; 4096 connections × 6 descriptors fit, D18), `MemoryMax=1G`, `TasksMax=1024` (Tokio's blocking pool
  may grow to 512 threads plus the workers).
- Sandbox: HolyWisp's set (`NoNewPrivileges`, empty `CapabilityBoundingSet`/`AmbientCapabilities`,
  `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `PrivateIPC`, the `ProtectKernel*`,
  `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `ProcSubset=pid`,
  `RestrictNamespaces`, `LockPersonality`, `MemoryDenyWriteExecute`, `RestrictRealtime`, `RestrictSUIDSGID`,
  `RemoveIPC`, `KeyringMode=private`, `SystemCallArchitectures=native`) with two differences that the trace must
  confirm: `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` (the splice probe and Tokio's signal driver use Unix
  socket pairs; without `AF_UNIX` the probe fails and every Wisp connection is silently copied instead of spliced) and
  `SystemCallFilter=@system-service` then `~@privileged @obsolete @cpu-emulation @swap @reboot @mount @debug @raw-io`
  (`@resources` only if the trace shows nothing from it: `setrlimit` is there, while the startup `RLIMIT_NOFILE`
  raise uses `prlimit64`, which is in `@default`; checked with systemd 262's `systemd-analyze syscall-filter` on
  2026-11-18), `SystemCallErrorNumber=EPERM`; `SocketBindAllow=tcp:<port>` for the configured listeners with
  `SocketBindDeny=any` (the unit's comment says to edit both together).
- **Minimum systemd versions**, stated in the unit's comments and in `docs/DEPLOYMENT.md`: `SocketBindAllow`/`Deny`
  249, `RestartSteps`/`RestartMaxDelaySec` 254, `ProtectProc`/`ProcSubset` 247; Debian 12 and Raspberry Pi OS bookworm
  ship 252, which ignores the 254 keys with a warning, so the guide says what is lost there.
  `systemd-analyze verify` also runs (static, in an unprivileged container, nothing booted) with Debian 12's
  systemd 252, besides this host's 262, whose `security` rating would otherwise overstate the protection on older
  hosts.
- **HolyWisp egress to the host's own addresses** (hairpin): HolyWisp refuses private, loopback and link-local
  destinations but cannot know the deployment's public addresses, so a proxied page can reach services bound to the
  host's public IP (bypassing cloud security groups) or a home router's admin page on its WAN address.
  `deployment/systemd/holywisp.service.d/egress-deny.conf.example` ships `IPAddressDeny=<host public IPv4>/32
  <public IPv6 prefix>` for the operator to fill in (§5.7 security checklist).

`deployment/tests/syscalls.sh` follows `services/holywisp/tests/syscalls.sh`: the static musl binary (from
`release.sh`'s `server-out` or a local musl build) and HolyWisp run under `strace -f` in an unprivileged Alpine
container (`--network none`, read-only root, tmpfs `/tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`, UID
65532, the trace image pinned by digest) through a workload: `config check`, `migrate`, `serve` with two origins on
loopback, `/api/health`, static files in br/gzip/identity and a `304`, an anonymous session, a ticket, a Wisp upgrade
through the gateway to HolyWisp and a 4 MiB echo transfer (the splice path; `/admin/diagnostics` must report
`ws.zero_copy` true), an account created and signed in (Argon2 on the blocking pool), a sync upload, `db backup`,
`health`, `admin get`, SIGTERM with an open Wisp connection. The trace is compared with the unit: every system call
inside the expanded filter, socket families inside `RestrictAddressFamilies`, no `PROT_WRITE|PROT_EXEC` mapping, no
`personality`, no file written outside the state directory and `/tmp`, no `/proc` entry outside `/proc/self` and
`/proc/<pid>`. It exits 0 only when the unit fits; the report lists the distinct calls. A glibc build is not what the
unit is written for (its resolver may need `AF_NETLINK`); `deployment/README.md` says so.

### 5.5 Operations: the CLI (d3b) and the guide

New subcommands in `backend/src/cli.rs` (no new crate; tested in `backend/tests/cli_ops.rs` against the real binary):

| Command | Behaviour | Exit |
| --- | --- | --- |
| `gnome-server health [--url URL] [--timeout-ms N]` | `GET /api/health` on `GNOME_BIND` (an unspecified bind address becomes loopback; the proxy listener is never asked) over a plain HTTP/1.1 connection, default timeout 3000 ms; prints the JSON | 0 when `200` and `"status":"ok"`, 1 otherwise (also `503 degraded`), 2 on a configuration error |
| `gnome-server admin get <path>` | `GET <path>` (must start with `/admin/`) on `GNOME_ADMIN_BIND` with `Host: 127.0.0.1:<port>` and the token from `GNOME_ADMIN_TOKEN` / `_FILE` when set; prints the body | 0 on `2xx`, 1 otherwise or when the admin listener is disabled |
| `gnome-server db backup <file>` | creates the target first with `O_CREAT` + `O_EXCL`, mode 0600 and length 0 (refuses an existing path; SQLite would otherwise create it `0644 & ~umask`, and the CLI runs outside the unit's `UMask=0077`), applies the server's connection PRAGMAs (`temp_store=MEMORY` among them, so VACUUM's temporary B-trees stay off the 16 MiB `/tmp` tmpfs), then `VACUUM INTO` it on its own connection: a consistent snapshot while the server keeps running (WAL); then `PRAGMA integrity_check` on the copy; prints its size and schema versions. `secret.key` is not copied (the guide says to back it up separately or keep it in the secret store) | 0 / 1 |
| `gnome-server version` | also prints the build id (`option_env!("GNOME_BUILD_ID")`, `unknown` for local builds) | 0 |

d3b also adds the image's `HEALTHCHECK` (interval 30 s, timeout 5 s, start period 30 s, retries 3), the compose
`healthcheck` and `depends_on: condition: service_healthy` for Caddy, the secrets wiring of §5.2 and §5.4 (after
d4b's M1), and replaces the `GNOME_SERVER_IMAGE` placeholder text of `services/vpn/compose.example.yml` with the real
image name (`gnome-server:<v>` from `deployment/Dockerfile`).

The operations part of `docs/DEPLOYMENT.md` (d3a writes it, d3b completes the CLI parts), each procedure run once by
an OP-row (§5.8):

- **Backups**: what the data directory holds (`gnome.db` + WAL, `secret.key`, `filters/`, Wave C's `oss-games/` and
  thumbnail cache; only the database and the key need a backup, the rest is fetched again), `db backup` in both
  deployments (`docker compose exec gnome gnome-server db backup /var/lib/gnome/backups/<date>.db`, then copy it out
  with `docker compose cp`), a retention example, the `caddy-data` volume (the ACME account key and certificates;
  losing it forces re-issuance, which can hit the CA's rate limits), and the restore: stop, move the old `gnome.db`, `gnome.db-wal`,
  `gnome.db-shm` aside, copy the backup to `gnome.db`, start (migrations run forward at start).
- **Upgrades**: back up; replace the artifact or pull/build the new images; `config check`; start; migrations are
  automatic and append-only; a downgrade is refused by the migration runner ("written by a newer release") and needs
  the backup; static files are indexed at start, so a new `dist/` needs a restart; HolyWisp restarts drop open Wisp
  connections and the transports reconnect.
- **Secrets**: generating each (`openssl rand -base64 48` for the key, ≥ 16 characters for the admin token), the
  file modes, rotation effects (a new secret key or access code ends every anonymous session and ticket; signed-in
  sessions are stored tokens and survive a key change; a new admin token needs a restart), never in `.env`,
  `Environment=` or shell history.
- **Logs**: JSON to stderr, `docker compose logs gnome` or `journalctl -u gnome-server`; what an access line holds
  (no IPs or query strings unless `GNOME_LOG_IPS=true`); Caddy's filtered logger (§5.3: no client address, no
  headers, paths only) and HolyWisp at `log-level warn`, so the whole stack keeps what About promises.
- **Health and metrics**: `gnome-server health`, `/api/health` on both hostnames (the proxy's minimal form),
  `/admin/diagnostics` and `/admin/metrics` through `admin get`, the alerts worth having (`gnome_wisp_upstream_up`,
  `gnome_http_connections_refused_total`, `process_open_fds` against `process_max_fds`, `gnome_db_size_bytes`, job
  failures).
- **Capacity**: the connection caps and descriptor budget (D18), the large-head and large-answer budgets (D19,
  D22), the kernel's per-user pipe budget (`fs.pipe-user-pages-soft`: beyond ≈ 512 spliced connections new ones get
  8 KiB pipes; raising it is the operator's choice on a large host, never done by GNOME or its tests), the sync
  quota, the server-wide sync cap and the measured on-disk use as a multiple of the logical bytes (D20, from
  `sync_quota.rs`), the memory ceilings, what to change on a small host (§5.6).

### 5.6 Raspberry Pi 4

`docs/DEPLOYMENT.md` "Raspberry Pi 4" (D25), with every number labelled measured-on-x86_64, estimate (with basis) or
not measured:

- **OS**: a 64-bit OS (Raspberry Pi OS 64-bit, Debian or Ubuntu arm64) is required: the release binaries are
  `aarch64` static musl, and HolyWisp has no 32-bit build at its pin. 4 GB or 8 GB recommended; 1–2 GB works with the
  smaller settings below (estimate from the budgets of §7, not run).
- **Getting the binaries**: the release artifact `gnome-<v>-linux-aarch64.tar.gz` (systemd route), or the arm64
  images (`docker buildx build --platform linux/arm64 …` on any amd64 machine, cross-compiled by `xx` without binfmt;
  transferred with a registry or `docker save | ssh pi docker load`). Building natively on the Pi works with
  `cargo build --release --locked -p gnome-server`, but the fat-LTO single-codegen-unit link needs more memory than a
  1–2 GB Pi has (estimate); `CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` builds a
  functionally equal but not reproducible binary.
- **Settings for small hosts**: `GNOME_ARGON2_MEMORY_KIB` stays 19456 (t = 2, p = 1; at most CPUs/2 = 2 hashes at
  once ≈ 38 MiB); `GNOME_DB_READERS=2` on 1 GB; `GNOME_MAX_CONNECTIONS=1024` on 1 GB (each idle Wisp connection costs
  its budgeted memory in gnome-server and HolyWisp, §7); HolyWisp `max-concurrent-connections = 2000` and
  `max-streams-per-conn = 256` (its README); compose `mem_limit` values that add up below the RAM; data directory on a
  USB SSD rather than the SD card for accounts with sync (WAL writes), logs bounded (json-file limits, journald's
  `SystemMaxUse=`). Raspberry Pi OS may boot with the memory cgroup disabled, in which case compose `mem_limit` and
  systemd `MemoryMax=` are silently ignored: when Docker warns about memory limits, add `cgroup_enable=memory
  cgroup_memory=1` to `cmdline.txt` (documented, not run here).
- **What was run**: the aarch64 `gnome-server` and HolyWisp binaries and the arm64 image's binary under
  `qemu-aarch64` user-mode inside unprivileged amd64 containers — `version`, `config check`, a loopback `serve` with
  `/api/health`, and `cargo test --workspace` for `aarch64-unknown-linux-musl` with QEMU as the Cargo runner (rows
  RP1–RP3; failures that come from QEMU's user-mode emulation are listed, not hidden). No timing under QEMU is
  quoted. **Not run**: anything on Raspberry Pi hardware; a Raspberry Pi 5 (16 KiB pages by default) is untested; every Pi number is an estimate until a maintainer runs
  `bench/run.mjs` there (d1a's `--cpus servers=0-2,loadgen=3` option, or the load generator on a second machine) and
  `docs/BENCHMARKS.md` records it. Basis of the estimates: the Pi 4's Cortex-A72 has no SHA-2 or AES instructions
  (hashing and AES-GCM run in software: startup hashing O1 and Caddy's TLS are the parts most affected; Go and ring
  pick ChaCha20-Poly1305 or NEON paths), 4 cores at 1.5–1.8 GHz, memory budgets transfer from x86_64 (same 64-bit
  build and allocator, 4 KiB pages).

### 5.7 `docs/DEPLOYMENT.md` and `deployment/README.md`

`docs/DEPLOYMENT.md` (the operator's guide; README.md's "Production notes" will point to it): requirements; DNS for
two sibling hostnames (`gnome.example.com` + `p.gnome.example.com`; the separate-registrable-domain option of D19 (5)
with its measured cost); route A step by step (secrets, `.env`, `docker compose up -d --build`, first checks); route
B (verify `SHA256SUMS.sig` and then `sha256sum -c --ignore-missing SHA256SUMS`, both before unpacking; install
binaries, units and `dist/`, `/etc/gnome/gnome.env` (0600 root), the admin-token credential, Caddy from the
distribution or its static binary with the same Caddyfile and `route-b.env.example`); "Choosing hostnames" (D19 (5):
the sibling default's costs — same-site cookies, one renderer process for app and engine host, the `__Host-`
dependency on a trusted front — against the separate-domain option's partitioned engine state, with CF6's
per-browser result and CF7's process finding); the VPN override; the
operations part (§5.5); Raspberry Pi 4 (§5.6); fronts other than Caddy and CDNs (the conditions of §5.3); the security
checklist of §8, including egress to the host's own addresses (services on the host must not rely on a cloud
firewall: bind them to loopback or private interfaces; the router's admin page must not answer on its WAN address;
route B's `egress-deny.conf.example`; for route A a `DOCKER-USER` rule the operator may add to drop
`<prefix>.81.0/24` → the host's public addresses, a host change that is documented and never run by the tests;
`deployment/tests/egress-probe.sh`, run by the operator, tries the host's public IP on 80, 443 and 8080 from
HolyWisp's network namespace and reports what answers); the IPv6 client-address result of DP5; the realm guarantee
for the front's automatic answers verified for Chromium and Firefox only (WebKit where CF1/DC3 ran it); a variables table for the deployment files (the gnome-server variables stay in ARCHITECTURE §4.2,
linked); what was tested and what was not (§10). `deployment/README.md` is the developer's view: the files, how to
build the images, how to run `check.sh` and the suites.

### 5.8 Acceptance and tests

`deployment/check.sh` (static, no network except pulling the pinned tool images; exit 0 = all pass), run by d3 after
every change and by the integration step:

- `docker compose config -q` for `compose.yml`, `compose.yml + compose.vpn.yml`, `compose.yml + compose.test.yml`
  with `.env.example`; then policy assertions on the merged output: only `caddy` has `ports`; no `privileged`, no
  `network_mode: host`, no `pid`/`ipc: host`, no `docker.sock` or host-path mounts other than the files named in §5.2;
  `cap_add` only on `gluetun` and only `NET_ADMIN`; every service except the named gluetun exception (§5.2)
  `read_only` and `cap_drop: ALL`; every service `no-new-privileges`, `mem_limit` and `pids_limit`; no `security_opt`
  with `seccomp=unconfined`, `apparmor=unconfined` or `label=disable`, no `devices` except gluetun's `/dev/net/tun`,
  no `sysctls`, no `userns_mode: host` or `cgroup: host`, no `rshared`/`shared` propagation; no secret value in any
  `environment` (names ending `_TOKEN`, `_CODE`, `_KEY` must be `_FILE` variables; `GNOME_TLS_KEY_FILE` is one;
  gluetun's control-server key lives in its auth-config file); the admin listener never bound to a non-loopback
  address; the recipe comparison of §5.2; `Dockerfile.dockerignore` contains the deny lines of §5.1; when
  `deployment/secrets/` exists, its directory is 0750 and its files 0640 with group `GNOME_SECRETS_GID`; the route-B
  and compose examples' ports do not collide; `config check`-style warnings when the origins are `https://` and
  `GNOME_HSTS` is off, and when the host has global IPv6 while `edge` has none.
- `caddy validate` and `caddy fmt --diff` on the Caddyfile with production and test placeholders (pinned Caddy image,
  `--network none`); `systemd-analyze verify --root=<tmp root>` for `gnome-server.service` (with the HolyWisp units it
  names); `systemd-analyze security --offline=true` exposure ≤ 2.0 ("OK"; HolyWisp's units rate 1.1–1.2);
  shellcheck and hadolint from pinned images on `deployment/**/*.sh`, `scripts/*.sh` and both Dockerfiles.

Rows (standalone suites under the runner, gated by `GNOME_E2E_DEPLOY=1`, §9; ports from d3's range when run alone):

| Row | Checks |
| --- | --- |
| I1 | image sizes per architecture (compressed and uncompressed) within §7; layer list recorded |
| I2 | the amd64 image runs read-only, as 65532, without capabilities, with tmpfs `/tmp`: `version`, `config check` with `.env.example` values, `serve` answers `/api/health`; a second start on the same volume keeps `secret.key` and the database |
| I3 | the image holds exactly the expected files (no shell: `--entrypoint /bin/sh` fails; no `.map`, e2e driver, `bench/` or fixtures); `postbuild --check` passes on the image's `dist/` |
| I4 | the arm64 image's binary, extracted with `--output type=local`, is a static aarch64 executable and runs `version`, `config check` and a loopback `serve` + `/api/health` under `qemu-aarch64` in an unprivileged amd64 container (`--network none`) |
| I5 | the image's `/usr/share/licenses/gnome/` equals the artifact's `share/licenses/` for that architecture (including `gnome-server/rust-std.txt` and `gnome-server/LICENSE.musl`); OCI labels set, including the two source-archive labels |
| I6 | the image's binary is byte-identical to `release.sh`'s `bin/gnome-server` of the same build id and architecture |
| I7 | two image builds of one snapshot: same digest or not (recorded) |
| DC1 | real Caddy (the derived image, `--network host`, `CADDY_BIND=127.0.0.1`, non-root, lane ports, TLS from the throwaway CA) in front of a real gnome-server (two listeners on `127.0.0.1`) and HolyWisp: in Chromium and Firefox the app loads on `https://gnome.localhost:<p>`, `/api/config` names the proxy hostname, the engine host is ready, a local fixture page loads through Scramjet and through Ultraviolet over `wss://p.gnome.localhost:<p>/wisp/` (WebSocket through Caddy, over h2 where the browser negotiates it); the session cookie is named `__Host-gnome_sid`; the proxy listener receives no `Cookie` header (its access log in the test records header names) |
| DC2 | gnome-server stopped: both hostnames answer `502` from Caddy with the strict policy (byte-equal to gnome-server's `AUTOMATIC_ANSWER_HEADERS` policy), `nosniff`, `no-store`, and HSTS when on; the `http://` redirect answers `308` to `https://` with the same headers; afterwards neither Caddy's nor gnome-server's logs contain the client address or a `t=` query |
| DC3 | a 1.9 MB URL and 180 cookies of 4,000 bytes sent through Caddy over HTTP/1.1 and HTTP/2 (Node client with the CA) reach gnome-server: the answer carries GNOME's `x-request-id` and policy (gnome-server's own `414`/`431`, its hardened `503` from the large-head budget, or `200`), never a Go or Caddy `431`/`400`; the largest URL and cookie bytes Playwright's WebKit sends are recorded where it runs here (as WebKit, not Safari) |
| DC4 | the cookie flood of CF2 through Caddy: the app keeps working (after d4b's M2; before it the row is `expectFail` with the recorded `431`) |
| DC5 | client address: gnome-server's access log (`GNOME_LOG_IPS=true` in the test) shows the browser's address; a client-sent `X-Forwarded-For` is replaced by Caddy; a dial to a refused destination makes HolyWisp (`--log-level info`) log `egress: <client ip>: blocked …` with that address, never a spoofed one (the method of `backend/tests/holywisp_e2e.rs`) |
| DC6 | a Caddy reload (`caddy reload` through its admin endpoint, a Unix socket in the scratch directory, mode 0600) keeps an open Wisp connection alive and moving data |
| DC7 | Caddy runs as 65532 with no capabilities (`/proc/1/status` `CapEff` 0), read-only root, `no-new-privileges`; `getcap` on its binary is empty |
| DC8 | realm check (the method of `backend-proxy.mjs` part `realm`): a same-origin frame of Caddy's `502` page on the proxy hostname, opened from the engine-host document, cannot fetch, open a WebSocket, load an image or send a beacon to the leak sentinel (Chromium and Firefox) |
| DC9 | timeouts: a gnome-server whose listeners are paused (`SIGSTOP` on the test process) makes Caddy answer its strict `504` within `response_header_timeout`, never hang; a full connection cap gives gnome-server's hardened `503` through Caddy |
| DP1 | the whole stack from `compose.yml + compose.test.yml`: `docker compose up -d --build` becomes healthy; DC1's browser flow passes through it |
| DP2 | published ports are exactly Caddy's two; from a helper container on `edge`, HolyWisp's port (`<prefix>.81.2:6001`) and the admin port on gnome's address (`<prefix>.80.10:9091`) refuse; `docker compose exec gnome gnome-server admin get /admin/diagnostics` succeeds |
| DP3 | `docker inspect` of every container shows no secret value; `config check` inside `gnome` reports each secret "from file"; the logs of the whole run (Caddy, gnome-server, HolyWisp) contain none of the test secret values, no client address and no `t=` query |
| DP4 | restarting `gnome` leaves HolyWisp running; `docker compose down && up` keeps the database, `secret.key` and an account (sign-in works) |
| DP5 | client addresses (`GNOME_LOG_IPS=true` in the test): (a) a helper container on `edge` reaches Caddy over IPv4 and IPv6 and gnome-server logs the helper's own addresses (Caddy is dual-stack and forwards them); (b) through the published loopback ports the address is recorded (traffic from the host's own loopback goes through `docker-proxy` and is expected to show the gateway); (c) an external IPv6 client through Docker's `ip6tables` NAT needs a port published on a non-loopback address, which §0 forbids here: documented, not run. `docs/DEPLOYMENT.md` states the results |
| DP6 | temp-file users inside the read-only container with its 16 MiB `noexec` `/tmp`: migration 0002's backfill on a database of 100,000 visits and 20,000 bookmarks, `db backup` of it, and (once Wave C's OSS fetch exists) one OSS game fetch from a local fixture; peak `/tmp` use recorded |
| OP1 | backup and restore: `db backup` while a sync upload loop runs, integrity check, restore into a fresh volume, the account's bookmarks are there |
| OP2 | upgrade: a stack on image build N with data, replaced by build N+1 (a test migration in a scratch copy of the tree), starts and migrates; the same data on build N afterwards is refused with the "newer release" message |
| SD1 | `deployment/tests/syscalls.sh` passes (the unit's filter fits the traced workload, `ws.zero_copy` true) |
| RP1 | the artifact's aarch64 `gnome-server` and `holywisp` under `qemu-aarch64`: `version`, `config check`, loopback `serve` + `/api/health`, HolyWisp `/health` |
| RP2 | `cargo test --workspace --locked --target aarch64-unknown-linux-musl` with `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUNNER=qemu-aarch64` in an unprivileged build container; tests that exec the server binary (`fd_limit.rs`, `cli.rs`, and Wave D's own) fail with `ENOEXEC` without binfmt and are classified up front; Wave D's new tests (`cli_ops.rs`, `conn_caps.rs`) read an optional `GNOME_TEST_EXEC_WRAPPER=qemu-aarch64` so RP2 runs them too; other QEMU-only failures listed with their cause |
| RP3 | an arm64 gnome-server and HolyWisp pair under QEMU relays a Wisp echo (functional only; no timing) |

Acceptance: `check.sh` and every row above pass on the final tree (DC4 after M2), the guide's procedures were each run
by an OP- or DP-row, and `docs/DEPLOYMENT.md` names each thing that was not run (§10).

## 6. Lane d4: security hardening and audits

### 6.1 Audits (d4a, D24)

- **`deny.toml`** (cargo-deny, pinned, installed under `~/.cache/gnome-tools/`; written to the pinned version's
  schema: e.g. current versions put `exclude-dev` under `[graph]` and treat `unmaintained` as a scope setting, not a
  level; AU3 proves the file parses without warnings): `[graph]` targets `x86_64-unknown-linux-gnu`,
  `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`; `[advisories]` the RustSec database, vulnerabilities and
  `yanked` deny, unmaintained and unsound advisories reported (each listed in `docs/AUDIT.md` with a decision), every `ignore` entry with a `reason` and an `# expires: YYYY-MM-DD` comment at most 90 days ahead
  (`audit.sh` fails on an expired one); `[licenses]` (normal and build dependencies; dev dependencies excluded) allows
  licenses that may be combined with AGPL-3.0-only in a distributed binary, as exact SPDX ids: MIT, Apache-2.0 (also
  `WITH LLVM-exception`), BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, BSL-1.0, CC0-1.0, Unicode-3.0,
  CDLA-Permissive-2.0, MPL-2.0, LGPL-2.1-or-later, LGPL-3.0-only, LGPL-3.0-or-later, GPL-3.0-only, GPL-3.0-or-later,
  AGPL-3.0-only, AGPL-3.0-or-later; everything else (GPL-2.0-only,
  SSPL, BUSL, "Commons Clause", no license) is denied; `[[licenses.clarify]]` only with the crate's license files
  hashed; the workspace's own crates are `private` (unpublished); `[bans]` `multiple-versions = "warn"` (C3),
  `wildcards = "deny"` (path dependencies allowed), denied crates `openssl`, `openssl-sys`, `native-tls`, `aws-lc-rs`,
  `aws-lc-sys` (GNOME avoids C TLS stacks), and only if d1b's C2 lands option (b) or (c) also `rustls-native-certs`,
  `rustls-platform-verifier`, `openssl-probe` (d1b asks by change request; d4 owns the file); `[sources]` crates.io
  only (unknown registries and every git source denied). `bench/loadgen` (its own workspace) gets the advisories and
  sources checks only: it is never shipped.
- **`scripts/audit/npm-audit.mjs`** runs `npm audit --json` in `frontend/`, `tests/e2e/` and `bench/wispjs/` and
  classifies each finding: **shipped** = a `dependencies` package of `frontend/package.json`, a `VENDOR_PACKAGES` pin
  (devDependencies that reach browsers unmodified), every package in a vendored package's transitive dependencies
  (the list `copy-vendor.mjs` already computes for `THIRD-PARTY-LICENSES.txt`: `libcurl.js`,
  `@mercuryworkshop/epoxy-tls`, …), or a package with modules in any of the three chunk graphs (§4.6);
  **build-only** = everything else. Policy (`scripts/audit/npm-policy.json`): shipped high or critical fails; shipped
  moderate and every build-only finding are reported and need a decision row in `docs/AUDIT.md` within 30 days, but
  do not fail; ignores need a reason and an expiry ≤ 90 days; it also holds the license allow-list of shipped npm
  packages that `third-party-notices.mjs` enforces (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, MPL-2.0,
  OFL-1.1, 0BSD, CC0-1.0, Unlicense, LGPL-3.0-only, LGPL-3.0-or-later, AGPL-3.0-only, AGPL-3.0-or-later, with
  `AGPL-3.0` (Ultraviolet's `VENDOR_PACKAGES` entry) mapped to AGPL-3.0-only by a listed clarification; §4.4).
- **Wasm-embedded code** (`scripts/audit/embedded.mjs`): records the versions compiled into the vendored wasm
  (`libcurl.version` and the Mbed TLS, nghttp2 and brotli versions from one engine-host init in a test browser; the
  CA bundle's date, which `docs/AUDIT.md` holds to a maximum age of 12 months), and checks epoxy-tls's `Cargo.lock` at
  its D27 revision with `cargo deny check advisories`.
- **Installs run no package scripts**: `npm ci --ignore-scripts` in `release.sh`, the Dockerfile and
  `bench/wispjs` (`tests/e2e/.npmrc` already sets it); the audit checks that the locks' `hasInstallScript` set is
  empty or allow-listed (today: `fsevents` only, which never installs on Linux).
- **`scripts/audit.sh [--offline] [--json FILE]`**: checks the tool versions (exit 2 with the install command when one
  is missing), runs `cargo deny --locked check` on the workspace and the loadgen checks, the npm audits through
  `npm-audit.mjs`, the expiry check, and lists the pinned third-party images (Node, Rust, `xx`, Alpine, Caddy, gluetun; name, version, digest); the
  Caddy and gluetun binaries, copied out of their pinned images, are checked with a pinned `govulncheck
  -mode=binary` (run in a pinned Go image), at least every 30 days and on every pin change; `release.sh` refuses a
  release whose image audit is older than 30 days. `--offline` uses the cached advisory database and reports every part that needs the network as
  `skipped`, never `pass`. Exit 0 pass, 1 policy failure, 2 usage or tool error; the JSON goes into `BUILDINFO` (§4.5).
  The first audit also runs `cargo audit` (pinned) once and records that its findings equal the advisories check.
- **`docs/AUDIT.md`**: the policy, how to run it, the first audit (date, tool versions, advisory database revision,
  every finding with its decision), the duplicate versions, the license inventory summary, the pinned images, and how
  to update a pin (HolyWisp: `services/holywisp/README.md` "Updating the pin"; Caddy, gluetun, base images: read
  their advisories, bump the digest, rerun `deployment/check.sh` and the deploy rows).

### 6.2 M1: configuration (d4b, after Wave C's integration)

New `VARS` in `config.rs` (each with `config check` output, the `/admin/diagnostics` `config` object, and rows for
ARCHITECTURE §4.2 and `backend/README.md` in the lane report):

| Variable | Default | Range / form | Decision |
| --- | --- | --- | --- |
| `GNOME_MAX_CONNECTIONS` | `4096` | 16–1,000,000 | D18 |
| `GNOME_MAX_CONNS_PER_IP` | `256` | 1–65,536, ≤ `GNOME_MAX_CONNECTIONS` | D18 |
| `GNOME_MAX_INFLIGHT_PER_IP` | `256` | 1–65,536 | D18 |
| `GNOME_MAX_INFLIGHT_HEAD_MB` | `64` | 4–1024 | D19 (4) |
| `GNOME_SYNC_QUOTA_MB` | `64` | 1–4096 | D20 |
| `GNOME_SYNC_TOTAL_MB` | `1024` | 16–1,048,576, ≥ `GNOME_SYNC_QUOTA_MB` | D20 |
| `GNOME_COOKIE_HYGIENE` | `app` | `app` · `registrable` (`/api/config` `proxy.cookieHygiene`) | D19 (3) |
| `GNOME_SECRET_KEY_FILE` / `GNOME_ADMIN_TOKEN_FILE` / `GNOME_ACCESS_CODE_FILE` | – | absolute path | D23 |

`_FILE` rules (D23): an empty `_FILE` variable counts as unset (so deployment files can always pass them); otherwise
the file is read when the configuration is loaded (also by `config check`); a regular file of at most 64 KiB;
exactly one trailing `\n` or `\r\n` is removed; the value then passes the same validation as the variable (the key
file holds the same base64 text as `GNOME_SECRET_KEY`); a variable and its `_FILE` twin both set is a configuration
error naming both (exit 2); an unreadable file is a configuration error naming the path and the error; a file that
**others** can read (mode bit `0o004`) logs a warning, while owner- or group-readable is the documented form (compose
`group_add` with mode 0640, measured §5; systemd credentials are 0400 for the service); `config check` prints
`<redacted> (from file <path>)`; TOML keys `secret_key_file`, `admin_token_file`, `access_code_file` work the same.

Also in M1: the default of `GNOME_SOURCE_URL` becomes `option_env!("GNOME_DEFAULT_SOURCE_URL")` (empty for local
builds; release builds set it, D27), and `config check` (and startup, once) gains warnings: `GNOME_SOURCE_URL` empty
while a bind address is not loopback; `GNOME_REGISTRATION=open` while accounts are on; `https://` origins with
`GNOME_HSTS=false`; a secret given as a plain variable while `INVOCATION_ID` is set (systemd).

### 6.3 M2: connection caps, head limits and budget, relay buffer, proxy trust, cookie priority (d4b)

New `backend/src/limits.rs` (registered in `lib.rs`; state in `AppState`), wired in `server.rs`, `router.rs`,
`gateway/{mod,caps,relay}.rs` and `auth/extract.rs`:

- **Global cap** (D18): one owned semaphore permit per connection on the public and proxy listeners together; the
  admin listener has its own 64 permits. Effective cap = min(`GNOME_MAX_CONNECTIONS`, (soft `RLIMIT_NOFILE` after
  startup's raise − 512) ÷ 6), logged at startup when lowered. Without a free permit a loop still accepts, using the
  512-descriptor reserve, answers the hardened `503` with `Retry-After: 1` and closes; at most 256 such overflow
  answers run at once, and only beyond that does the loop pause (the kernel's backlog then holds new connections). A
  full cap is logged at most every 10 s and its time is counted (`gnome_http_cap_full_seconds_total`). An upgraded
  Wisp connection keeps its permit.
- **Per-peer cap at accept**: for socket peers **outside** `GNOME_TRUSTED_PROXIES`, at most `GNOME_MAX_CONNS_PER_IP`
  connections per IPv4 address or IPv6 /64 (the rate limiter's key); the excess is closed at once
  (`gnome_http_connections_refused_total{reason="per_ip"}`). Behind a reverse proxy every peer is the proxy, so this
  protects direct exposure only.
- **In-flight per client**: a layer right after `observe` in every role router (it needs `ClientInfo`, i.e. the real
  client behind a trusted proxy): at most `GNOME_MAX_INFLIGHT_PER_IP` requests per client key from arrival until the
  response head is ready (bodies stream outside the count; large sync answers hold D22's answer budget instead);
  beyond it `503 unavailable` with `Retry-After: 1` (API error shape on `/api/*`; security headers and the
  proxy-origin policies apply as to any answer), counted in `gnome_http_inflight_refused_total`.
- **IPv6 prefix tiers** (D18): the in-flight cap and the gateway's per-client Wisp-connection cap (`gateway/caps.rs`)
  also apply per /56 at 4× and per /48 at 16× the /64 limit; the refusal (`429`/`503`) and the metric label name the
  tier. Ticket minting keeps the rate limiter's /64 key (`security/rate_limit.rs` has no Wave D owner; §12 OI14).
- **Wisp share**: the gateway refuses an upgrade with `429 too_many_connections` while active Wisp connections are at
  90 % of the effective cap (`gnome_ws_rejected_total{reason="server_full"}`), so plain HTTP keeps headroom.
- **Head limits** (D19): hyper's `max_buf_size` on the **app listener** is 1 MiB for connections whose socket peer is
  in `GNOME_TRUSTED_PROXIES` (the reverse proxy, which sends complete heads it has already bounded; loopback by
  default, which covers development) and 64 KiB for every other peer; on the **proxy listener** it is 1 MiB only for
  loopback peers and 64 KiB otherwise (the shipped Caddyfile strips `Cookie` there, D16); the **admin listener** keeps
  64 KiB. In single-origin mode (one listener serving both roles) the app listener's rule applies. Every deployment
  that serves browsers beyond localhost needs HTTPS, so a TLS front that must be trusted for `X-Forwarded-Proto`
  anyway; untrusted peers are plain-HTTP clients, where a large buffer would multiply by addresses. The hardened
  automatic answers of `ConnIo` and hyper's `414` for request targets of 64 KiB or more are unchanged.
- **Large-head budget** (D19 (4)): a layer before routing sums the request's head size (request line and header
  bytes); a head over 64 KiB needs room for twice its size (hyper may overshoot by one read) in a global byte budget
  of `GNOME_MAX_INFLIGHT_HEAD_MB` and is one of at most 4 such requests per client key (with the /56 and /48 tiers);
  the room is held until the response head is ready. Without room: the hardened `503` with `Retry-After: 1` at once
  (realm-safe, the strict policy), counted in `gnome_http_large_head_refused_total`.
- **Upgraded connections hold no head buffer**: the gateway refuses an upgrade whose head exceeds 64 KiB with the
  hardened `431` unless the peer is loopback, and `gateway/relay.rs` (this M2 change only; d1b owns the file
  afterwards) writes `client_rest` upstream, records its length and drops it before the pump loop in both the
  splice and the copy path. hyper hands the connection over with `read_buf.freeze()`, which shares the allocation the
  parsed head was split from, so holding `client_rest` kept up to the whole head buffer alive for the connection's
  life (8 KiB per idle Wisp connection today, ≈ 1 MiB after a flooded upgrade head). Unit test: after the handoff, a
  connection's retained heap does not depend on its head size (alloc-count or a `Weak`-style probe on the buffer).
- **Proxy trust** (`auth/extract.rs`, `security/client.rs` read only): under `GNOME_COOKIE_SECURE=auto`, a deployment
  whose `GNOME_PUBLIC_ORIGINS` and `GNOME_PROXY_ORIGIN` are all `https://` treats cookies as `Secure` (`__Host-`
  names) regardless of `X-Forwarded-Proto`; a request for an `https://` origin that arrives from an untrusted peer
  without a trusted `X-Forwarded-Proto` logs a warning once and counts in `/admin/diagnostics` `proxy_trust`
  (`{"untrusted_https_requests"}`), the sign of a front missing from `GNOME_TRUSTED_PROXIES`.
- **`Priority=High`** on both session cookies (`auth/cookies.rs`; Chromium evicts lower-priority cookies first when a
  site passes 180; Firefox ignores the attribute; CF3 records what each does).
- **`Origin-Agent-Cluster: ?1`** on both origins' documents (`security/headers.rs`), only if row CF7 shows that it
  separates app and engine host into different processes in Chromium with every functional row still green;
  otherwise not added, and CF7's result goes into "Choosing hostnames".
- `/admin/diagnostics` gains `connections` (`{"max", "effective", "active", "per_ip_max", "inflight_per_ip_max",
  "refused": {"per_ip"}, "inflight_refused", "large_head": {"budget_bytes", "used_bytes", "refused"},
  "overflow_answered", "cap_full_seconds"}`) and `proxy_trust` in `admin/mod.rs`; the counters live in `metrics.rs`
  (d4b's M2 edit comes before any d1b edit of that file, §2.2).

### 6.4 The cookie-flood evidence and the app's hygiene (d4a suite and module, d4b wiring)

`tests/e2e/engine/suites/cookie-flood.mjs` (+ `flood-lib.mjs`; standalone; Chromium and Firefox, WebKit where a
Playwright WebKit build runs here; gated by `GNOME_E2E_FLOOD=1` until the Wave D integration step makes it default,
one `skip` row otherwise; the front is d3a's real Caddy from `deploy-lib.mjs` when `GNOME_E2E_DEPLOY=1`, else the Node
front of `backend-https.mjs`, recorded per row). Rows that need d4b's M2 detect it by probing (the `connections`
object in `/admin/diagnostics`) and are `expectFail` with the recorded `431` until then, so nobody edits the suite
when M2 lands:

| Row | Topology | Checks |
| --- | --- | --- |
| CF1 | sibling hostnames over HTTPS | from the proxy origin, plant cookies for the parent domain until the browser keeps no more; record how many it keeps and the largest `Cookie` header the app origin then receives (the front logs header lengths); the expectation is ≈ 180 × 4 KB ≈ 740 KB (D19); WebKit recorded as WebKit, not Safari |
| CF2 | dev two ports on loopback; sibling hostnames behind the front | with the flood planted: the app loads, `/api/session` works, sign-in, a sync round and a Wisp page load work (rows `expectFail` with the recorded `431` until M2, then pass) |
| CF3 | sibling hostnames | after a flood of 200 `Secure; Priority=High` cookies, GNOME's session cookie: kept or evicted (recorded per browser); when evicted, the anonymous session is recreated by itself and a signed-in user sees the sign-in prompt (asserted) |
| CF4 | dev | a 200 KB head from an untrusted peer (client socket bound to 127.0.0.2, outside the default `127.0.0.1/32`) gets the hardened `431` on the app listener; the same head from 127.0.0.1 gets the normal answer; a 1.5 MiB head from 127.0.0.1 gets the hardened `431`; a 200 KB head on the admin listener gets `431` (64 KiB buffer, which hyper may overshoot by one read, so the refusal starts at roughly 128 KiB); a 200 KB Wisp upgrade head from 127.0.0.2 gets the hardened `431` |
| CF5 | dev, the attack shape | memory (RSS sampled every 100 ms; no limit is imposed on the process): from the trusted peer, 16 client keys (distinct `X-Forwarded-For` values, including 8 IPv6 /64s of one /48) × 256 slow-body requests with 1 MiB heads, plus 1,000 untrusted connections with 60 KB heads; the large-head budget refuses the excess with the hardened `503`; gnome-server's peak RSS (`VmHWM`) stays below RB11's absolute ceiling and returns to within 10 % of idle after they close, also while the test front keeps its upstream connections pooled |
| CF6 | proxy origin on a **separate registrable domain** (`gnome.localhost` + `gnome-proxy.localhost`) | the engine host works (service worker, IndexedDB, both engines, a proxied page), or the row records what breaks, in: Chromium with third-party cookies blocked; Chromium's default settings (storage partitioned); Chromium Incognito; Firefox `network.cookie.cookieBehavior` 1 and 5; a Firefox private window; Playwright WebKit where it runs here; a flood planted from the proxy origin never reaches the app origin; `docs/DEPLOYMENT.md` lists, per browser, what that option breaks |
| CF7 | sibling hostnames, Chromium | whether the app and the engine host share a renderer process (CDP `SystemInfo.getProcessInfo` / the target's process id), without and with `Origin-Agent-Cluster: ?1` on both origins (set by the test front); with the header, every functional row of CF2 still passes or the row records what breaks; d4b adopts the header only if it separates them at no functional cost (§6.3) |
| CF8 | dev and behind the front | 1,000 idle Wisp connections opened with 900 KB upgrade heads from loopback (dev) and through the front (where the front strips or refuses them): gnome-server's RSS per connection stays within RB3, and the front's RSS is recorded (Caddy with `GNOME_E2E_DEPLOY=1`) |
| CF9 | sibling hostnames | a `Domain=<registrable domain>` cookie set by a sibling site of the operator (`other.localhost`-style fixture host under the same registrable domain) survives the hygiene; a host-only foreign cookie on the app host does not; a `__Secure-` foreign cookie is removed (deleted with `Secure`) |

`frontend/src/lib/cookie-hygiene.ts` (d4a, + `cookie-hygiene.test.ts` with a fake cookie jar that implements domain
and path rules): `cleanForeignCookies()` reads `document.cookie` and expires each name host-only and for the domain
levels at or below the longest common parent of the app and proxy hostnames that is **not** the registrable domain
(for `gnome.example.com` + `p.gnome.example.com`: `gnome.example.com`; for two ports on `localhost`: host-only only),
at `Path=/`, with `Secure` for `__Secure-` names (at most 200 names per run; the browser itself refuses public
suffixes). The registrable-domain level is cleared only when `document.cookie` exceeds 32 KB or `/api/config`
`proxy.cookieHygiene` is `"registrable"` (the operator's opt-in `GNOME_COOKIE_HYGIENE=registrable`, M1; default
`app`). `startCookieHygiene()` runs it at start, every 5 minutes and when the page becomes visible.
It runs **only in two-origin mode** (`/api/config` `proxy.isolated`): there the app origin has no legitimate
script-visible cookie (GNOME's own are HttpOnly, and nothing in `frontend/src` sets one: checked 2026-11-18), while in
single-origin mode the origin is shared with the engines and the hygiene stays off. It cannot see cookies planted
with another `Path` (they still reach `/api/*` requests): the server's head limits and budget are the guarantee,
hygiene only keeps typical heads small. `docs/DEPLOYMENT.md` states which cookies it removes. d4b wires it in
`src/main.ts` (one import, one call after the configuration is known).

### 6.5 M3: sync quota, usage, bookmark paging (d4b)

- **Migration `database/migrations/0002_sync_quota.sql`** (registered in `CORE_MIGRATIONS`): columns
  `users.sync_bookmark_bytes`, `sync_history_bytes`, `sync_settings_bytes` (`INTEGER NOT NULL DEFAULT 0`), kept exact
  by `AFTER INSERT/UPDATE/DELETE` triggers on `bookmarks`, `history` and `user_settings`, backfilled in the
  migration; the same triggers maintain a one-row aggregate `sync_totals(bytes)` for the server-wide cap. Costs (D20; `octet_length` needs SQLite ≥ 3.43, which the bundled SQLite is, else `length(CAST(x AS
  BLOB))`): a live bookmark `octet_length(url) + octet_length(title) + 36 (id) + 36 (parent, if any) + 64`, a
  tombstone 64; a visit `octet_length(url) + octet_length(title) + 36 + 64`; the settings document
  `octet_length(data)`.
- **Enforcement**: a bookmark batch or a settings `PUT` is applied inside its transaction, then, if it **grew** the
  account's total past the quota, rolled back and answered `413 quota_exceeded` with `used_bytes` and `quota_bytes`;
  a batch that does not grow the total (deletions, tombstones, shorter titles) always applies, so an account over its
  quota (after `GNOME_SYNC_QUOTA_MB` is lowered) can always shrink. A history batch is not refused for the account
  quota: after it the server deletes the account's oldest visits until the total fits (or no visit is left) and
  answers the additive field `trimmed`. **Server-wide cap** (`GNOME_SYNC_TOTAL_MB`, D20): any batch of any kind that
  would grow `sync_totals` past it is rolled back and answered `413 quota_exceeded` with `"scope": "server"` (history
  included: trimming one account to make room for another is not done); the account-level answer carries `"scope":
  "account"`.
- **`GET /api/sync/usage`** (signed in) → `{"used_bytes", "quota_bytes", "history_bytes", "bookmarks_bytes",
  "settings_bytes"}`; `/admin/diagnostics` `db` gains `sync_bytes_total` and `sync_quota_bytes`.
- **Bookmark paging** (D22): `GET /api/sync/bookmarks?since=&limit=&cursor=`, keyset on `(synced_at, id)` exactly like
  history, `limit` 1–1000; a page ends at `limit` items or once its JSON reaches 1 MiB, whichever comes first, with
  `next_cursor` (`null` at the end); the same 1 MiB page cap applies to history pages. Without `limit`, the answer is
  one page that ends on a `synced_at` boundary (a whole group, even past 1 MiB: one group is at most one upload batch)
  with `server_time` set to that boundary, so an old client continues with `since=` at its next sync. The client
  (`frontend/src/settings/sync.ts`, `httpRecordTransport.pull`) sends `limit=1000` and follows `next_cursor` (the
  adapter already loops for history).
- **Answer budget** (D22): a sync answer body over 1 MiB takes room for its size in a fixed 64 MiB budget (in
  `limits.rs`) and keeps it until the body is fully written (a body wrapper releases it on completion or drop); an
  account runs at most 2 sync pulls at once. Without room: `503 unavailable` + `Retry-After: 1`. The write-stall
  timeout alone would let a slow but steady reader hold a buffered body indefinitely.
- **Client message** (`frontend/src/settings/account-sync.ts`): on `413 quota_exceeded` that kind's sync stops with
  "Sync storage on this server is full (<used> of <quota>). Delete bookmarks or turn off history sync to continue."
  (`scope: "account"`) or "This server's sync storage is full. Try again later or ask its operator." (`scope:
  "server"`)
  and is retried after a local deletion or at the next start; the other kinds go on.

### 6.6 History byte budget (d4a, D21)

`frontend/src/library/history.ts`: a running estimate Σ (2 × (URL + title characters) + 96) bytes in the store's
metadata, recomputed at start, adjusted on every add, title update and delete; above `MAX_HISTORY_BYTES` = 64 MiB the
oldest visits are deleted down to 90 % of it, checked together with the count cap (every `CAP_CHECK_EVERY` new visits)
and at start; synced visits (`applyRemote`) take the same path; the existing `QuotaExceededError` eviction stays.
`library-perf.mjs` (owned by part 2 until it finishes, then free) is not changed; d4a's report gives the start-time
cost of the recompute at 100,000 visits from a unit benchmark.

### 6.7 Acceptance and tests

- **Rust** (d4b): `backend/tests/conn_caps.rs` (at the cap the N+1st connection gets the hardened `503` with
  `Retry-After: 1` from the reserve, and beyond 256 overflow answers waits and is served when one closes; the admin
  cap is separate; 128 /64 keys of one /48 simulated through `X-Forwarded-For` from the trusted peer: plain HTTP
  stays usable and the Wisp refusal names the prefix tier; the real-binary cases honour `GNOME_TEST_EXEC_WRAPPER`; an untrusted peer bound to 127.0.0.2 gets its excess closed while 127.0.0.1 does not; `503` +
  `Retry-After: 1` beyond the in-flight cap behind a trusted peer, keyed by `X-Forwarded-For`; the Wisp `429` at 90 %;
  the effective cap lowered by a small `RLIMIT_NOFILE` in the real binary, as `fd_limit.rs` does; metrics and
  diagnostics), `head_limit.rs` (CF4's cases at the socket level, per listener; the large-head budget: the 5th large
  head of one client key and the request past the byte budget get the hardened `503`, room is released when the
  response head is ready), a relay test (after the handoff, a Wisp connection opened with a 60 KB head retains no more
  heap than one opened with a 1 KB head), `proxy_trust.rs` (all-`https://` origins give `__Host-` names without
  `X-Forwarded-Proto`; an untrusted peer's https request is counted once and warned), `sync_quota.rs` (triggers exact after inserts,
  updates, tombstones, deletes and an account deletion; backfill from a version-1 database; `413` when a batch grows
  past the quota; a shrinking batch over the quota applies; history trimmed oldest first; the server-wide cap refuses
  every kind with `scope: "server"`; usage numbers; a 5,000-item batch with and without the triggers timed, the ratio
  recorded; the database file's size on disk as a multiple of the logical bytes, for DEPLOYMENT.md "Capacity"), `sync_paging.rs` (paged pulls equal the whole change
  set, also with writes between pages; limit bounds; the 1 MiB page cap with maximal URLs and titles; a limit-less
  request gets one page ending on a `synced_at` boundary and the rest with `since=`; a third concurrent pull of one
  account and a pull past the answer budget get `503`; N slow readers of maximal pages stay within RB16; a bad cursor
  `422`; tombstones included), `secrets_file.rs`
  (every rule of §6.2); `backend/tests/server.rs`'s automatic-answer test sends its cookie bomb from 127.0.0.2 and
  adds the trusted case; unit tests for `Priority=High` on both cookies, secure and not.
- **e2e** (d4b): `backend-proxy.mjs` part `oversized`: the long-query case becomes a head over 1 MiB (Chromium: a
  1.9 MB query; Firefox, whose URLs stop at 1 MiB: a 900 KB query plus 40 cookies of 3.9 KB), the 66 KB path keeps its
  `414`, and the 156 KB cookie bomb now gets the proxy origin's normal `404` with `proxyInertCsp`; every case still
  proves "no permissive realm". The CF-rows (d4a) and DC4 (d3a) pass after M2.
- **Frontend** (d4a/d4b): `cookie-hygiene.test.ts` (scope rules: a sibling site's `Domain=<registrable>` cookie
  survives unless over 32 KB or opted in, `__Secure-` names deleted with `Secure`, localhost host-only), `history.test.ts` (byte budget: oldest first, together with the
  count cap, recompute equals the running total), `settings/sync.test.ts` (bookmark pages), `account-sync.test.ts`
  (`413` → message, kind stopped, others continue).
- **Audit rows**: AU1 `scripts/audit.sh` exits 0 on the final tree (findings decided in `docs/AUDIT.md`); AU2
  `--offline` reports `skipped`, never `pass`; AU3 `deny.toml` parses without warnings under the pinned cargo-deny,
  and in a scratch crate outside the tree a GPL-2.0-only dependency and a git source each fail `cargo deny` with it;
  AU4 `npm-audit.mjs` on recorded `npm audit --json` fixtures (no network): a vulnerable shipped package fails, the
  same package as build-only passes with a warning, a vulnerable package bundled inside a vendored package counts as
  shipped, an expired ignore fails; AU5 the embedded versions and the CA bundle's date are recorded and the
  epoxy-tls advisories check ran; AU6 `govulncheck -mode=binary` ran on the pinned Caddy and gluetun binaries; AU7 no
  lock has an install script outside the allow-list.
- Acceptance: the deferred items "global/per-IP connection cap", "cookie flood", "per-account sync quota", "bookmark
  pagination" and "history byte budget" each have their rows passing (CF1–CF9 with the recorded per-browser results) and are moved from PROGRESS's deferred list to
  the decisions log by the integration step; `LimitNOFILE=` is in d3's unit (D17).

## 7. Budgets

One file holds every ceiling: **`scripts/budgets.json`** (d1a creates it from this table; `postbuild.mjs`,
`bundle-report.mjs`, `release.sh`, BR5, `deployment/tests/image.sh` and `bench/compare.mjs` read it; `scripts/` is in
the Docker build context, `bench/` is not; `tests/e2e/engine/suites/build.mjs` reads it after step 3's integration,
through a change request the Wave D integration step applies, so step 3's own code-size budgets and these have one
source). The ceilings below are this plan's; "today" is measured (2026-11-18, the `ui:final` build and the release
binary of that evening, as in the header) or an estimate with its basis. **Build-time ceilings are report-only until
baseline-1** (D26): step 3 and Wave C land first, so d1a then rewrites "today" and the ceilings from baseline-1
(keeping the rules of each row) and records the rebase in the decisions log. At the Wave D integration step each
ceiling is tightened to the final measured value + 10 % (build-time) or + the noise band of §3.4 (runtime), so later
waves are held to what Wave D reached.

**Build-time** (checked by `postbuild.mjs` step 5, BR5 and `release.sh`; KB = 1000 B, per-file gzip -9 / brotli 11 as
the UI gate measured):

| # | Budget | Today | Ceiling |
| --- | --- | --- | --- |
| BB1 | app startup set (the files `index.html` loads at start: scripts, module preloads, style sheets), JS + CSS, gzip | 154.2 KB (JS 138.9 + CSS 15.3; 27 + 6 files; 106.6 KB of JS before the restyle) | 170 KB |
| BB2 | the same, brotli | 134.5 KB | 150 KB |
| BB3 | engine host's own startup JS (GNOME's code), gzip | 55.2 KB | 65 KB |
| BB4 | unmodified engine scripts the engine host loads at start, gzip | 208.9 KB | no ceiling (upstream code served unmodified, §0); a pin change records its new value |
| BB5 | any GNOME chunk outside both startup sets, gzip, except the rows below | ≈ 38 KB (SettingsPage in the `ui:final` listing; bundle-report confirms which chunks are lazy) | 60 KB each |
| BB5a | step 3's blocker chunk of the engine host and its builder Worker (each carries `@ghostery/adblocker`, ≈ 91 KB gzip), raw | — (lands with step 3) | < 400 KB raw each (WAVE-B3 §10.2) |
| BB5b | `sw.js` growth over its baseline-0 size, raw | — (lands with step 3) | ≤ 350 KB (WAVE-B3 §10.2) |
| BB5c | the engine host's entry chunk, raw | 129 KB (2026-11-12, WAVE-B3) | < 300 KB (Vite's `chunkSizeWarningLimit`, WAVE-B3 §10.2) |
| BB6 | first-load images (P1, cold: favicon, mark, wallpaper) | ≈ 30 KB (estimate, D12) | 60 KB |
| BB7 | release `dist/` on disk (identity files, siblings, notices; no maps) | estimate 31.8 MiB (21.8 MiB text + 2.4 MiB other + 7.2 MiB brotli + 0.4 MiB gzip of GNOME's own files, D8) | 40 MiB |
| BB8 | `.map` files in a release `dist/`; `sourceMappingURL` in GNOME's files | 0 / 0 | 0 / 0 |
| BB9 | `gnome-server`, stripped static musl, x86_64 and aarch64 | glibc x86_64 10,535,736 B (musl builds come with d3a) | 12.0 MiB each |
| BB10 | gnome-server image per architecture, compressed / uncompressed | estimate 22 / 45 MiB (binary ≈ 4 MiB gzip + `dist/` ≈ 18 MiB compressed) | 30 / 55 MiB |
| BB11 | release artifact `gnome-<v>-linux-<arch>.tar.gz` | estimate 24 MiB | 32 MiB |
| BB12 | crates in `cargo tree -p gnome-server -e normal` | 167 | recorded; no Wave D change may add one without a decisions-log row |

**Runtime** (checked by `bench/compare.mjs` on the record run of §3.4: this machine, servers on 4 physical cores,
the static musl release build unless named):

| # | Budget | Estimate (basis) | Ceiling |
| --- | --- | --- | --- |
| RB1 | gnome-server RSS at rest (R1: 10 s after the first `200`, release `dist/`) | 25–45 MiB (≈ 10 MiB of small static files in memory, SQLite caches as used, Tokio workers) | 64 MiB |
| RB2 | RSS after 60 s of H1 at c = 64 | — | 96 MiB |
| RB3 | gnome-server RSS growth per idle Wisp connection (W4 slope from 1,000 to 10,000) | 8–20 KiB (one task, two sockets, two idle pipes whose buffers are kernel memory and count against the per-user pipe budget, not RSS; no retained head buffer after M2) | 32 KiB |
| RB4 | HolyWisp RSS per idle Wisp connection | upstream's churn bench peaks at 4 MiB | recorded (pinned upstream) |
| RB5 | W1 (1 × 10) throughput through the gateway ÷ HolyWisp direct | ≥ 0.8 (splice adds two syscalls per chunk) | ≥ 0.70 |
| RB6 | W2 idle, latency added by the gateway over HolyWisp direct (23 / 46 µs p50 / p99.9 direct, research §8) | +10–30 µs | p99 ≤ +50 µs, p99.9 ≤ +200 µs |
| RB7 | W3 (a) Wisp setup p99 through the gateway | — | 5 ms |
| RB8 | H1 (a) req/s at c = 64 ÷ the Node 4-worker cluster; p99 at a fixed 5,000 req/s | > 1 | ≥ 1.0; p99 ≤ 2 ms |
| RB9 | A1 ticket mint p99 at a fixed 2,000 req/s | — | 5 ms |
| RB10 | S1 startup p50: (a) warm, (b) "cold" (fadvise), (c) fresh data directory | — | 300 / 800 / 1,000 ms |
| RB11 | CF5 head-buffer memory under the attack shape | — | peak RSS ≤ idle + `GNOME_MAX_INFLIGHT_HEAD_MB` + 64 MiB (the budget already counts each head twice; ≈ 170 MiB with the defaults, far below the stack's 1 GiB `mem_limit`); back within 10 % of idle |
| RB12 | P5 requests during 60 s idle on `/browse` | recorded at baseline-1 | no more than baseline-1 (no Wave D change adds idle requests) |
| RB13 | P2 route transition (time to the target page's first content), p50 / p95 | recorded at baseline-1 | no worse than baseline-1 + the noise band, and p95 ≤ 200 ms on this machine (estimate-based target; tightened at the integration step) |
| RB14 | P1 cold first load: LCP (Chromium) and request count | recorded at baseline-1 | no worse than baseline-1 + the noise band; requests no more than baseline-1; vendor revalidations recorded per load (d2b's decision, §4.6) |
| RB15 | CF8: gnome-server RSS per idle Wisp connection opened with a 900 KB head | — | within RB3's ceiling |
| RB16 | `sync_paging.rs`: 32 slow readers of maximal sync pages at once | — | gnome-server RSS growth ≤ the 64 MiB answer budget + 16 MiB |

**Raspberry Pi 4 targets** (estimates for the guide, not enforced until measured on a Pi, §5.6): whole stack at rest
(gnome-server + HolyWisp + Caddy) ≤ 160 MiB; gnome-server warm startup ≤ 2 s; 200 open Wisp connections (a busy
household) ≤ +16 MiB over rest for gnome-server and HolyWisp together; a password hash ≤ 0.5 s; the gateway and
HolyWisp not the bottleneck below the Pi's 1 Gbit/s Ethernet (TLS in Caddy without AES instructions is the likely
limit).

**When a budget is exceeded** (D26): a build-time overrun makes `postbuild.mjs` exit 1, so BR5 fails and
`release.sh` stops. The lane then either reduces it (bundle-report names the chunk and the modules that grew) or
builds with `--allow-budget-overrun "<reason>"`, which writes the reason into `dist/.gnome/build.json` and
`BUILDINFO`; BR5 then reports `pass` with the reason in its notes, so an allowed overrun is visible in every result,
and the lane closes only after a decisions-log row records the measured value and `scripts/budgets.json` carries the
new ceiling. A runtime overrun makes `compare.mjs` exit 1: the lane does not close (AC5) until it is fixed or a
decisions-log row changes the ceiling with the measured value and the reason. A budget is never raised to hide a
regression the profile can explain.

## 8. Security and compliance of the deliverables

| Area | Rule | Where | Proof |
| --- | --- | --- | --- |
| Containers | fixed non-root users (gnome-server 65532, HolyWisp 65534, Caddy 65532), read-only root, `cap_drop: ALL`, `no-new-privileges`, Docker's default seccomp profile, tmpfs `/tmp` with `noexec,nosuid,nodev`, `pids_limit` and `mem_limit` on every service; never `privileged`, host namespaces, `docker.sock`, unconfined seccomp/AppArmor, extra devices, `sysctls` or host paths beyond the named files; the one documented exception is the optional, never-started-here gluetun: Docker's default capabilities plus `NET_ADMIN`, `/dev/net/tun`, a writable root, `no-new-privileges`, limits (its documented requirement, scoped to its own network namespace) | §5.1–§5.3 | `check.sh`, I2, DC7, DP2 |
| Images | `FROM scratch` for gnome-server and HolyWisp (no shell, no package manager), multi-stage (no toolchain at runtime), bases pinned by digest, compilation with `--network=none` | §5.1 | I3, hadolint |
| Secrets | `GNOME_SECRET_KEY` generated 0600 into the data directory unless `_FILE` is given; the admin token and the access code only as `_FILE` (compose: the read-only `deployment/secrets/` mount with `group_add`; systemd: `LoadCredential=` drop-ins) in every shipped file; never in `.env`, `Environment=`, a build context (the ignore file denies `.env*`, `deployment/secrets/`, keys, databases and test output in every directory), image layers, `docker inspect`, logs, diagnostics, `BUILDINFO` or a source tarball (built from an allow-list and deny-scanned); `init-secrets.sh` sets the group and refuses shared groups; the unit's admin token is part of the first install | D23, §4.5, §5.1, §5.2, §5.4 | DP3, `secrets_file.rs`, BR6, RL8, `check.sh` |
| TLS | Caddy's automatic ACME (HTTP-01 through 80 → 8080, TLS-ALPN through 443 → 8443) or operator files, its TLS 1.2/1.3 defaults, certificates in the `caddy-data` volume (backed up, §5.5); operator TLS files in `secrets/tls` (0640, read-only mount); `http://` → `308` with the strict headers; HSTS on by default in the stack (`GNOME_HSTS=true`, one year, no `includeSubDomains`, no `preload`), also on Caddy's own HTTPS answers | §5.2, §5.3 | DC1, DC2 (files mode; ACME not run here, §10) |
| Admin listener | loopback in every deliverable (the container's own loopback; `127.0.0.1:9091` plus `SocketBindAllow` in the unit), used through `gnome-server admin get`; remote access only through the documented opt-in (token + `GNOME_ADMIN_ALLOW_REMOTE` + an `internal` network, never `ports:`) | §5.2, §5.4, §5.5 | `check.sh`, DP2 |
| The proxy hostname's policy on every answer | gnome-server's answers (unchanged; `backend-proxy.mjs`), Caddy's own answers (`handle_errors`, the redirect site) and Go's automatic answers (kept out of reach of browsers by `max_header_size 4MB`); other fronts only under the conditions of §5.3 | §5.3 | DC2, DC3, DC8 |
| Connection, head and answer bounds | D18 (incl. IPv6 prefix tiers and the overflow `503`), D19 (head limits per listener, the large-head budget, no retained head buffer after an upgrade), D22 (page caps, answer budget), the front's timeouts | §6.3, §6.5, §5.3 | `conn_caps.rs`, `head_limit.rs`, `sync_paging.rs`, CF4, CF5, CF8, DC9 |
| Client addresses | the real client address reaches gnome-server and HolyWisp in every route (dual-stack `edge`; Caddy overwrites forwarding headers; CDN recipe with both trusted-proxy lists); a front missing from `GNOME_TRUSTED_PROXIES` is warned about and no longer downgrades cookies | D15, §5.3, §6.3 | DC5, DP5, `proxy_trust.rs` |
| Logs | no client address, query string or header in any shipped component's logs unless `GNOME_LOG_IPS=true` (gnome-server; Caddy's filtered logger; HolyWisp at `warn`), matching About's privacy text | §5.3, §5.5 | DC2, DP3 |
| Egress to the host itself | HolyWisp refuses private, loopback and link-local destinations; the deployment's public addresses are covered by the guide's checklist, route B's `IPAddressDeny=` drop-in example, route A's documented `DOCKER-USER` rule and the operator's `egress-probe.sh` (an upstream per-CIDR deny option is §12 OI12) | §5.4, §5.7 | documented; `egress-probe.sh` run by the operator |
| Licenses in the release | GNOME's AGPL-3.0 text (also as the root `LICENSE`) and `SOURCE.txt` (the Corresponding Source tarball of this build and its SHA-256; GNOME is a network service: release builds compile in a default `GNOME_SOURCE_URL` pointing at the release's source archives, so an unmodified deployment's About page links them, and an operator who **modifies** it must offer its users the modified source, AGPL §13, by setting `GNOME_SOURCE_URL`; `config check` warns when it is empty on a non-loopback deployment); the vendored engines' `LICENSE` and `THIRD-PARTY-LICENSES.txt` unchanged, with the npm tarball URL, integrity hash and the verified repository, commit and tree hash of each pinned version (`scripts/third-party-sources.json`, D27) in the licenses bundle's `vendor/<dir>/SOURCE.txt` (§4.4); `release.sh` (on by default for a published release) packs the upstream sources of every copyleft and MPL component at those commits plus the shipped npm tarballs into `gnome-<v>-third-party-src.tar.gz`, so an operator can host them (AGPL §6(d), LGPL, MPL §3.2), and fails on a component without a verified entry unless a recorded `--allow-missing-source` and a decisions-log row say why; the Rust crates' texts for the union of the release targets, the Rust standard library's notice and musl's `COPYRIGHT` for gnome-server, the npm packages in GNOME's chunks (also served at `/licenses/THIRD-PARTY-NOTICES.txt`), the fonts' OFL-1.1 texts, HolyWisp (ISC) with musl (MIT), SQLite's dedication; Caddy (Apache-2.0) and gluetun (MIT) are pulled by the compose files, not redistributed | D11, D27, §4.4, §4.5 | RL5, RL10, BR7, I5 |
| Nothing leaks through served files | no source maps for GNOME's code; vendor maps removed from release builds; no `sourceMappingURL` in GNOME's files; no absolute build paths or user names; no token or key patterns; release binaries built with `--remap-path-prefix` | D5, D9 | BR1, BR6, RL4 |
| Supply chain | `npm ci --ignore-scripts` and `--locked` everywhere, crates.io only, images and Alpine build packages pinned, the audit gates the release (D24: npm classification including packages bundled in vendored files, the wasm-embedded C/Rust versions, `govulncheck` on Caddy and gluetun every 30 days), an outer `SHA256SUMS` signed with `--sign` and verified before unpacking, a reproducible artifact verified without caches (the key policy is open, §12 OI1) | D13, D24 | AU1–AU7, RL1, RL2, RL7, RL9 |
| Obfuscation | none (D10): GNOME's own code is minified only; third-party code is never touched | D10 | BR2 |

## 9. Tests: suites, switches, ports

| Suite or script | Owner | Kind | Switch | Rows |
| --- | --- | --- | --- | --- |
| `bench/run.mjs --check` / `--smoke`, `cargo test` in `bench/loadgen`, `node --test bench/node/ bench/lib/` | d1a | scripts | — | AC1, §3.8 |
| `tests/e2e/engine/suites/perf-frontend.mjs` | d1a | standalone suite | `GNOME_E2E_PERF=1` | P1–P5 |
| `tests/e2e/engine/suites/build-release.mjs` (+ `release-lib.mjs`, the release smoke flow d3a reuses) | d2a | standalone suite | `GNOME_E2E_RELEASE=1` | BR1–BR9 |
| `scripts/release.sh` | d2a | script | — | RL1–RL10 |
| `deployment/check.sh` | d3a | script (static) | — | §5.8 |
| `deployment/tests/{image.sh,syscalls.sh,arm64.sh}` | d3a | scripts | — | I1–I7, SD1, RP1–RP3 |
| `deployment/tests/egress-probe.sh` | d3a | operator script (documented, run by the operator on a real deployment) | — | — |
| `tests/e2e/engine/suites/deploy-caddy.mjs` (+ `deploy-lib.mjs`: `startCaddyFront()`, used by d4a too; it enforces the loopback rule of §0) | d3a | standalone suite | `GNOME_E2E_DEPLOY=1` | DC1–DC9 |
| `tests/e2e/engine/suites/deploy-compose.mjs` | d3a, d3b (OP rows) | standalone suite | `GNOME_E2E_DEPLOY=1` | DP1–DP6, OP1–OP2 |
| `tests/e2e/engine/suites/cookie-flood.mjs` (+ `flood-lib.mjs`) | d4a | standalone suite | `GNOME_E2E_FLOOD=1` until the Wave D integration step makes it default (CF5 and CF8 only with `GNOME_E2E_PERF=1`; Caddy only with `GNOME_E2E_DEPLOY=1`) | CF1–CF9 |
| `scripts/audit.sh` | d4a | script | — | AU1–AU7 |
| `backend/tests/{conn_caps,head_limit,proxy_trust,sync_quota,sync_paging,secrets_file,cli_ops}.rs` | d4b, d3b | cargo | — | §5.5, §6.7 |
| `frontend/scripts/*.test.ts`, `cookie-hygiene.test.ts`, `history.test.ts`, sync tests | d2a, d4a, d4b | Vitest | — | §4.7, §6.7 |

- A gated suite run without its switch records one `skip` row naming the switch, so the default runner stays fast
  and nothing is silently missing. The runner discovers the new files itself (`discoverSuites()`, `export const
  standalone = true`); no Wave D lane edits `run.mjs` or `lib/**`.
- Standalone suites run one at a time on the runner's standalone block (`E2E_STANDALONE_PORT_BASE` +0…+99, as Wave C
  states) and on the lane's range when run alone. `deploy-compose.mjs` uses its own Compose project name
  (`gnome-e2e-<pid>`) and its own subnets (it sets `GNOME_NET_PREFIX` to the first of `172.29`, `172.28`, `172.27`
  whose three subnets overlap no existing Docker network, and stops with that message when none is free), and
  removes every container, network and volume it created, also on SIGINT.
- Docker-based suites need Docker with buildx and the pinned images (pulled on first use); they run unprivileged
  containers only. `--offline` runs skip the rows that need the internet (image pulls, `npm audit`, the advisory
  database refresh) with a `skip` row each.
- Heavy runs (record preset, P-rows, CF5, CF8) happen only in quiet windows; everything else may run beside other
  work. Every server, front and container these suites start listens on loopback only and runs without internet
  fetches (§0).

## 10. Integration step and the final verification matrix

**Integration step** (`wave-d:integrate`, after d1b, d2b, d3b and d4b have reported; ports 17900–17999):

1. Apply the open change requests; `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets --locked
   -- -D warnings`, `cargo fmt --all --check`, `cd frontend && npm run check && npm test`.
2. Freeze a snapshot. In a quiet window: `node bench/run.mjs --preset record` (final), `node bench/compare.mjs
   <baseline-1> <final>`, the P-rows, CF5 and CF8 (`GNOME_E2E_PERF=1 GNOME_E2E_FLOOD=1`).
3. `scripts/release.sh --arch x86_64,aarch64 --image --verify-reproducible --third-party-source --sign <throwaway
   key>` (RL1–RL10; the published release is signed later with the maintainer's key), then
   `deployment/tests/image.sh` (I1–I7) and `build-release.mjs --dist <the release dist>` (BR1–BR9).
4. `deployment/check.sh`, `deployment/tests/syscalls.sh` (SD1), `deployment/tests/arm64.sh` (RP1–RP3), the deploy
   suites (`GNOME_E2E_DEPLOY=1`: DC1–DC9, DP1–DP6, OP1–OP2).
5. Make `cookie-flood.mjs` run by default (its `GNOME_E2E_FLOOD` gate removed; CF5/CF8 stay behind
   `GNOME_E2E_PERF`), apply the change request that makes `build.mjs` read `scripts/budgets.json`, then the full
   runner in both browsers with every switch on (`node engine/run.mjs --browser all` with `GNOME_E2E_RELEASE=1
   GNOME_E2E_DEPLOY=1`), so every existing row and every Wave D row run on the final tree, including through Caddy.
6. `scripts/audit.sh` online (AU1) → the final `docs/AUDIT.md`.
7. Tighten `scripts/budgets.json` to the final values (§7); check that the About page's crate list matches the
   final graph (`node frontend/scripts/rust-crates.mjs --check`; d1b regenerated it with every `Cargo.lock` change).
8. The documents of §11; every command in a changed README section is run (decisions log 2026-11-18).
9. Review — security and operations ∥ completeness (independent reviewers who read this plan, the lane reports and
   the code) — then fixes and the affected rows again.

**Matrix** (what the final tree is verified with on this machine, and what is documented but not run):

| Item | Run here | Documented, not run (why) |
| --- | --- | --- |
| x86_64 benchmarks (W1–W4, H1, A1, S1, R1, B1) | the record run in a quiet window, servers on 4 physical cores | — |
| Raspberry Pi 4 numbers | — | no Pi 4 here: every Pi number in `docs/BENCHMARKS.md` and `docs/DEPLOYMENT.md` is a labelled estimate; the method to measure is documented |
| Frontend P-rows | Chromium r1248 and Firefox r1555 (the pinned Playwright builds) behind an HTTPS front | WebKit/Safari: not among the e2e browsers (CF1, CF6 and DC3 record Playwright WebKit only where it runs here) |
| Deployed path | `rust+caddy` for W1, W2, H1 (a) on loopback | a real network and TLS on a Pi |
| gnome-server image, amd64 | built and run (I1–I3, I5–I7, DP-rows) | — |
| gnome-server image, arm64 | cross-built; its binary runs under QEMU user-mode in an amd64 container (I4) | an arm64 kernel or hardware |
| Release artifacts | both architectures built twice, the second time without any cache, and compared (RL2); rebuilt from the source tarball with another umask (RL9); x86_64 run (RL6); aarch64 under QEMU (RL6, RP1–RP3); third-party source archive verified (RL10) | aarch64 hardware |
| Compose stack | the whole stack with real browsers, TLS from a throwaway CA (DP-rows, OP-rows); client addresses from a helper container over IPv4 and IPv6 (DP5) | ACME with a real CA (public DNS and ports 80/443); an upgrade between two released versions (simulated with a test migration, OP2); external IPv6 clients through Docker's NAT (needs a non-loopback published port, §0); the hairpin egress probe (needs a public address) |
| VPN override | `docker compose config` and the recipe comparison | a real tunnel (needs a VPN account; gluetun is never started) |
| Caddy | the pinned Caddy, non-root, DC1–DC9 | other fronts (nginx, Traefik, CDNs): their conditions only (§5.3) |
| systemd | `systemd-analyze verify`, `systemd-analyze security --offline=true`, the syscall trace in an unprivileged container (SD1) | booting the units (host safety: no systemd in containers, nothing installed on this host) |
| Audits | `scripts/audit.sh` online and `--offline` | — |
| Cookie flood | CF1–CF9 in both browsers (CF6 also in Chromium default and Incognito and a Firefox private window), DC4 through Caddy | Safari |
| HTTP/3 | — | off (`protocols h1 h2`) |
| Signed checksums | `--sign` with a throwaway key, verification and tamper cases (RL7) | the maintainer's key and its policy (§12 OI1) |
| systemd on older hosts | `systemd-analyze verify` with Debian 12's systemd 252 (static) | booting it |

Deferred items: Wave D closes "per-account sync storage quota" (D20, M3), "global/per-IP connection cap and
`LimitNOFILE=`" (D18, M2, D17), "`GET /api/sync/bookmarks` pagination" (D22), the cookie-flood decision (D19), the
reverse-proxy error pages (D16) and the history byte budget (D21). It leaves open, reworded by the integration step:
"systemd units (HolyWisp's and gnome-server's) verified statically only; arm64 binaries and images ran only under
QEMU user-mode" (until a maintainer runs them in a VM and on a Pi), and "synced visits with history off" (a Wave E
product decision).

## 11. Documents to update (the integration step)

- **`README.md`**: "Features and their status" (benchmarks, build pipeline, deployment and audit rows with their honest
  status); "Requirements" (Docker with buildx for images); "Turning on every feature" (the new variables of §6.2, the
  variable count, the new CLI commands, `connections` and the new metrics under "Admin diagnostics"); "Production
  notes" rewritten around the three routes of §5 with links to `docs/DEPLOYMENT.md` (the "Coming in Wave D"
  paragraph and "opt-in obfuscation" removed; the reverse-proxy and admin bullets point to the Caddyfile and the unit);
  "Project layout" (`bench/`, `deployment/`, `scripts/`); the documentation table (`docs/BENCHMARKS.md`,
  `docs/DEPLOYMENT.md`, `docs/AUDIT.md`, `docs/WAVE-C.md`, `docs/WAVE-D.md`); "Licenses and credits" (the root
  `LICENSE`, the notices file, the licenses bundle, the source and third-party source tarballs, the default source
  link of release builds).
- **`docs/ARCHITECTURE.md`**: §3 (what `bench/`, `deployment/` and `scripts/` hold; `obfuscate.mjs` removed); §4.1
  (the CLI additions; connection caps in the process model); §4.2 (the ten new rows); §4.3 "Limits" (caps with
  IPv6 prefix tiers, in-flight bound, head limits per listener and peer trust, the large-head and large-answer
  budgets, sync quota and server cap); §4.4 (descriptor budget against the cap, `LimitNOFILE`, the per-user pipe
  budget and the relay's buffer release); §4.5 (migration 2, the byte columns and `sync_totals`); §4.6 "Headers" (head
  limits per listener; the tested Caddy configuration with its cookie strip on the proxy hostname, timeouts and log
  filter; `Origin-Agent-Cluster` if adopted) and "Deployment" (D19 with CF6's and CF7's results); §8 rewritten to what exists (postbuild, maps, no
  obfuscation, budgets, release script, image, compose, Caddy, systemd, Raspberry Pi notes); §9 (the obfuscation
  sentence removed; fonts as in the README; Rust crates, npm notices, Caddy and gluetun pulled not redistributed, the
  third-party source archives).
- **`docs/API.md`**: `GET /api/sync/usage`; `413 quota_exceeded` with `scope`; bookmark `limit` (1–1000) /
  `cursor`/`next_cursor`, the 1 MiB page cap of both pull routes and the paging of limit-less bookmark pulls; `trimmed`
  in the history upload answer; `503 unavailable` + `Retry-After: 1` for the in-flight bound, the large-head and
  answer budgets, two concurrent pulls per account and a full connection cap; the Wisp `429` when the server is full
  (with the prefix tier) and the `431` for oversized upgrade heads; `/api/config` `proxy.cookieHygiene`; the
  `/admin/diagnostics` additions (`connections`, `proxy_trust`, `db` sync totals).
- **`backend/README.md`**: CLI and configuration tables, the "Connections" paragraph of the request pipeline, the
  module map (`limits.rs`), Observability (new metrics), "Data and sync" (quota), Security notes (secrets files).
- **Lane documents in their final form**: `docs/BENCHMARKS.md`, `bench/README.md` (d1); `docs/DEPLOYMENT.md`,
  `deployment/README.md` (d3); `docs/AUDIT.md` (d4).
- **`tests/e2e/engine/README.md`**: the new suites, their switches and what each needs (Docker, buildx, network).
- **`services/holywisp/README.md`** (the stack topology: its own network, `--host 0.0.0.0 --trusted-proxy`, a pointer
  to `deployment/`) and **`services/vpn/README.md`** (`compose.vpn.yml` as the integrated way; the real image name).
- **`frontend/src/pages/about/**`**: known-limitations texts where a Wave D result changes one.
- **`docs/PROGRESS.md`**: Phases 7, 8 and 9 (checked items with their numbers; "Production build pipeline" reworded:
  "minify, tree-shake, precompress, optimize GNOME's images, no public source maps; no obfuscation (D10)" once the
  user confirmed D10); the deferred list as §10 says; the decisions-log rows marked (log) in §1, dated when taken,
  plus "GNOME's own code is AGPL-3.0-only", the budget rebase (D26), the C2 choice, the allocator, PGO and vendor
  revalidation decisions; the RESUME section.
- **This file**: an "Outcome" note at the top (what was built, and every point where the code differs from this plan,
  with the lane report that says why).

## 12. Open items (decided not to do in Wave D)

| # | Item | Why not now |
| --- | --- | --- |
| OI1 | The release signing key and its policy (who holds it, rotation, where `allowed_signers` is published) | `release.sh --sign` exists (OpenSSH 10.6 and GnuPG 2.4.9 are installed here; RL7 runs with a throwaway key); the key itself is a maintainer decision |
| OI2 | Compressing API answers (JSON) in Caddy or in gnome-server | answers that carry secrets (tickets) next to attacker-influenced data need a compression side-channel review first; d1 records the sizes of the largest answers (`/api/config`, a 1,000-item sync page) so the gain is known |
| OI3 | Leaving out vendor files no browser loads (each transport ships `.js`, `.mjs` and `.cjs` copies of a 2 MB bundle) | it would save several MiB per image, but a file that only a fallback path or some site loads would break; d2a records the bytes of vendor files never requested across the full e2e matrix (from the access log) as the evidence for a later decision |
| OI4 | A storage floor (refuse sync writes when the data filesystem is nearly full) | needs `statvfs` (another rustix feature); the server-wide cap `GNOME_SYNC_TOTAL_MB`, the per-account quota and `GNOME_REGISTRATION=closed` in the examples bound sync storage without it |
| OI5 | Per-user quota overrides; a usage meter in Settings → Account | admin and UI scope; `GET /api/sync/usage` exists after M3 |
| OI6 | HTTP/3 in Caddy | untested; UDP 443 is not published |
| OI7 | The systemd units under a real systemd (a VM, not a container); every binary on arm64 hardware | needs a VM and a Pi 4; the deferred item stays open, reworded |
| OI8 | WebSockets over HTTP/2 through Caddy | only if DC1 finds a browser that uses it and fails: then `protocols h1`, with P1's measured cost |
| OI9 | Tokio's blocking-thread ceiling (default 512) on small hosts | d1 samples `Threads:` from `/proc/<pid>/status` in R1, A1 and the sync pulls first; the unit's `TasksMax=1024` covers the default |
| OI10 | Synced visits while history is off | a Wave E product decision (PROGRESS "Deferred items") |
| OI11 | Per-site proxy sub-origins (ending the shared realm) | out of scope for v1 (decisions log 2026-11-11); CF6 documents only the separate-domain option |
| OI12 | A per-CIDR deny option in HolyWisp (`block-net`), so the egress policy can refuse the deployment's own public addresses itself | HolyWisp stays at its pin; an upstream change; until then the guide's checklist, route B's `IPAddressDeny=` example and route A's documented `DOCKER-USER` rule (§5.7) |
| OI13 | Caddy rebuilding `Cookie` on the app hostname from GNOME's own cookie names, so floods never reach gnome-server behind the shipped front | couples the Caddyfile to the cookie names (`__Host-` or plain, by mode) and to every cookie a later wave adds; the server-side head limit and budget already bound the cost |
| OI14 | Ticket minting with the IPv6 /56 and /48 tiers | the minting limit lives in `security/rate_limit.rs`, which no Wave D lane owns; minting is limited per minute, while the resource an attacker could hold for free (idle connections) gets the tiers in M2 |
| OI15 | A minimum transfer rate for large response bodies | the answer budget of D22 bounds the memory instead; a rate floor would cut off slow but legitimate links (a Pi on Wi-Fi, mobile clients) |
| OI16 | Lowering `GNOME_MAX_INFLIGHT_PER_IP` to 64 (a review proposal) | not done: the app's startup set is 33 parallel requests, so users behind one NAT address would get `503`s; memory is bounded by the large-head budget (D19 (4)) |
