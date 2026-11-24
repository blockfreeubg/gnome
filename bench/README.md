# bench/: GNOME's benchmark harness

Benchmark-only code (docs/WAVE-D.md §0, D2, D3). Nothing here is built into a release, an image or `dist/`, and
nothing in the product imports it. The method, the scenarios and the numbers are in
[docs/BENCHMARKS.md](../docs/BENCHMARKS.md); this file says how to run it and what each part is.

| Path | What |
| --- | --- |
| `run.mjs` | the harness: starts and stops every process, pins them, runs the load generator, samples `/proc`, writes `results/<id>/{results.json,results.md}` (raw logs in the ignored `results/raw/<id>/`) |
| `compare.mjs` | `<before> <after>`: noise-aware comparison (§3.4) plus the runtime ceilings of `scripts/budgets.json`; `--ceilings <results>` checks one set. Exit 1 on a significant regression of a budgeted cell or a ceiling exceeded |
| `lib/` | `cpusets` (topology → CPU sets), `quiet` (the quiet gate), `proc` (`/proc` sampling, the loopback guard), `stats`, `servers` (every configuration's command line and bench settings), `equivalence` + `check` (the `--check` request list), `dist` (the bench's static tree), `plan` |
| `node/` | the Node.js 26 baseline of gnome-server's three hot paths (Wisp gateway, static serving, session/ticket API), built-ins only; `--workers N` runs it under `node:cluster` |
| `wispjs/` | the pinned `@mercuryworkshop/wisp-js` server (0.5.3, LGPL-3.0-or-later, installed with `npm ci --ignore-scripts`) on `127.0.0.1` only |
| `loadgen/` | `gnome-bench`, the load generator (Rust, its own Cargo workspace, std + `libc`, `sha1`, `sha2`, `socket2`, all already in the product's lock file): `wisp tp|rtt|churn|open|idle|sha`, `http`, `echo`, `fadvise` |
| `results/` | committed result sets (`results.json`, `results.md`); `results/raw/` is ignored |

## Running it

```sh
# once
(cd bench/wispjs && npm ci --ignore-scripts)
export CARGO_TARGET_DIR=$PWD/target          # or your own; run.mjs looks for both binaries there
cargo build --release -p gnome-server        # the build under test (better: from a frozen copy, §3.4)
cargo build --release --manifest-path bench/loadgen/Cargo.toml
(cd frontend && npm run build)               # or pass --dist with d2a's release dist/

node bench/run.mjs --plan --preset quick     # cells × repeats × time, before a run
node bench/run.mjs --check                   # the equivalence check alone (must pass before any timing)
node bench/run.mjs --smoke                   # every scenario 2 s, no gate: the harness self-test
node bench/run.mjs --preset quick --label quick-final   # ≈ 35–45 min, every scenario once (budgeted cells twice)
node bench/run.mjs --preset record          # the full method, ≈ 5 h, quiet window only
node bench/compare.mjs bench/results/<before> bench/results/<after>
```

Useful flags: `--server-bin PATH` (a frozen snapshot's binary), `--dist DIR`, `--scenarios W1,H1`,
`--configs rust,holywisp`, `--repeats N`, `--duration S`, `--warmup S`, `--cpus servers=0-3,loadgen=4,5`
(Raspberry Pi 4 or another layout), `--no-gate-wait` (measure the quiet gate and mark noisy repeats, never wait;
for a machine known to be shared), `--note TEXT` (stored in `results.json` and the table header), `--scratch DIR`
(data directory, the bench `dist/` copy; default `$TMPDIR/gnome-bench-<uid>`). Set `BENCH_SNAPSHOT` to the
snapshot id of the build under test so it is recorded. `BENCH_PORT_BASE` (default 12100) moves every port of the harness (app = base + 1, …,
echo = base + 20).

Tests: `cargo test --manifest-path bench/loadgen/Cargo.toml` (WebSocket accept key and masking, Wisp frames, flow
control, histogram merge); `node --test bench/node/ bench/lib/` (token and ticket formats, ETag form, encoding
negotiation, path rules, the loopback guard, the CPU-set derivation, the `--plan` arithmetic).

## Presets

| Preset | Warm-up / measured | Repeats (budgeted cells) | Quiet gate | W4 N | H1 closed-loop c | S1 runs | Use |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `smoke` | 0.5 / 2 s | 1 (1) | off | 200 | 16 | 2 | harness self-test |
| `dev` | 1 / 5 s | 1 (1) | off | 1,000 | 64 | 5 | development; never quoted |
| `quick` | 2 / 8 s | 1 (2) | 2 s check, one 5 s retry, then marked noisy | 1,000, 3,000 | 64 | 10 | honest short numbers in ≤ 45 min, quoted as "quick preset" with their marks |
| `record` | 5 / 20 s | 3 (5) | up to 20 × 30 s | 1,000, 5,000, 10,000 | 1, 16, 64, 256 | 30 | the method of §3.4 (≈ 5 h) |

Every preset also runs the fixed-rate cells (H1 5,000 req/s, A1 2,000 req/s, both coordinated-omission
corrected).

## Bench settings (only here, never product defaults)

gnome-server: `GNOME_WORKERS=4`, `GNOME_RATE_LIMIT_SCALE=0`, `GNOME_MAX_WS_PER_IP`/`_PER_SESSION=100000`, d4b's
`GNOME_MAX_CONNECTIONS`, `GNOME_MAX_CONNS_PER_IP`, `GNOME_MAX_INFLIGHT_PER_IP`, `GNOME_MAX_INFLIGHT_HEAD_MB` at their
maximum (snapshots that predate them ignore them), `GNOME_LOG=warn`, the no-internet variables, two origins on
`127.0.0.1` (app `:12101`, proxy `:12102`, admin `:12103`), one VPN profile (`bench-vpn`, upstream `:12113`, no
listener: only for the route-binding checks), a scratch data directory. HolyWisp: `services/holywisp/gnome.conf` +
`--host 127.0.0.1 --workers 4 --allow-loopback on --flood-protection off` and its connection limits raised. Every
process is pinned with `taskset`; every listener a started process opens is checked to be on loopback, and a run
aborts otherwise. Ports: the lane's range, 12100–12191.

## The Node baseline: what it copies and the accepted differences

It copies the rules of docs/API.md and ARCHITECTURE §4.4/§4.6, not the Rust code: the static index (strong ETag =
first 16 bytes of SHA-256 in base64url, `-br`/`-gz` sibling suffixes, `immutable` for `/assets/`, `no-cache`
elsewhere, files ≤ 256 KiB in memory up to a 32 MiB budget, larger ones streamed from disk), the security headers
by listener role, the proxy-origin CSP strings read from `backend/tests/fixtures/proxy-origin-csp.json`, the
anonymous session token (`v1.<exp>.<id>.<mac>`) and the route-bound `w2` ticket (`w2.<exp>.<iat>.<route>.<ref>.<mac>`)
with HMAC-SHA256 purpose keys, the gateway's checks in gnome-server's order (route, ticket probe, RFC 6455 headers,
exactly one Origin equal to the proxy origin, ticket form/MAC/expiry, route binding, minted before the process
started, superseded by a VPN-location ticket, caps), the reconstructed upgrade request with one `X-Forwarded-For`,
`TCP_NODELAY` on both legs and the 15 s re-check of direct-route connections.

`--check` (run before every timing run; a failure blocks it) sends 51 fixed requests to both servers over raw
sockets and compares the status and every response header (values of `Date`, `x-request-id` and
`Sec-WebSocket-Accept` excepted; the ETag and `Set-Cookie` by form, because sessions are random; each server's own
origins normalised), plus the key set of every JSON body; then it pushes 64 MiB of pseudo-random bytes through
each gateway to the echo and compares SHA-256s.

Accepted differences, each with its reason:

- **Node relays by copying** (`socket.pipe()`); gnome-server splices. That is the point of the comparison.
- **No database on the measured paths, in either server**: anonymous sessions are stateless HMAC tokens. The
  database-backed paths (accounts, sync) were not compared (no A1 (d) scenario).
- **No rate limiting in Node**: the bench runs gnome-server with `GNOME_RATE_LIMIT_SCALE=0`, so neither limits.
- **No upstream health job in Node**: a ticket probe answers `426` even while the upstream is down (gnome-server
  answers `503 wisp_upstream_unavailable`); the bench's upstreams are always up.
- **`node:cluster` workers do not share state**: each worker has its own connection caps and its own record of
  VPN-location mints (gnome-server is one process). The bench sets the caps to their maximum and never mints
  VPN-location tickets outside `--check`, which runs the one-process `node1`.
- **The `/~/sj/` "engine starting" page and the not-built pages** are plain text in Node (not on a measured path;
  not in the check list).
- **`/api/config`** is built once at start from the same fields (gnome-server serialises it per request).
- **Node's HTTP server adds `Keep-Alive: timeout=…`** to keep-alive responses (hyper sends no such header); the check
  uses `Connection: close` and does not see it.

## Deviations from the plan (and why)

- **`oha` is not used**: it is not installed here and installing it needs the internet. H1 and A1 use
  `gnome-bench http` (keep-alive closed loop, or a fixed rate with each request's latency measured from its
  scheduled send time, like `oha --latency-correction`). Same histogram as the Wisp modes.
- **`rust-ctr`, `rust-copy`, `rust+caddy` are recorded as "not run"**: they need d3a's static musl `server-out`
  binary (the host's glibc 2.44 build does not run in `debian:trixie`), `lib/no-splice.json` (Docker's default
  seccomp profile minus `splice`) and d3a's Caddy image. Open.
- **The static tree**: until d2a's release `dist/` exists, `lib/dist.mjs` copies a plain `npm run build` and adds
  `.br`/`.gz` siblings (brotli q11, gzip -9, text ≥ 1 KiB), labelled "plain build + harness siblings".
- **W4's per-connection RSS** is the RSS delta while N connections are held (W4 runs first in each configuration,
  before W1 grows the process); RB3 is the slope between the smallest and largest N of the preset.
- **S1 (b) "cold"** uses `posix_fadvise(DONTNEED)` on our own files (no root): not a real cold boot.
- **P1–P5** (`tests/e2e/engine/suites/perf-frontend.mjs`) and the profiling/optimization loop (d1b, O1–O10) are not
  part of this pass. Open.
