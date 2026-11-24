# GNOME benchmarks

How GNOME's server side is measured, against what, and the numbers so far. The harness is in [`bench/`](../bench/README.md);
the plan it implements is docs/WAVE-D.md §3 (lane d1) and the ceilings are §7 (`scripts/budgets.json`).

> **Status (2026-11-24): only a dev smoke run exists.** The numbers below come from one `quick`-preset run on a
> machine that other agents were using at the same time (builds, test suites). Every repeat of it failed the quiet
> gate. They show that the harness works and roughly where things stand; **they are not final numbers** and must not
> be quoted as GNOME's performance.
>
> **Final step (d-final, 2026-11-24): no quotable run.** The machine never had a quiet window during the step (a
> desktop application kept one core at 100 % for the whole step, and the release builds and the e2e matrix ran
> too), so the `quick` preset was not run on the final tree, and the allocator check (D6) was not run either. The
> smoke numbers below remain the only ones, from baseline-1 (`900a6ff`), labelled as such. What the final tree adds
> on the measured paths (Wave D's limits layer: one semaphore and two counters per connection and request) is not
> measured. To record the numbers, run in a quiet window:
> `node bench/run.mjs --preset quick --label quick-final --server-bin <frozen build>` (≈ 35–45 min), then
> `node bench/compare.mjs bench/results/2026-11-24-quick-dev-smoke bench/results/<new>`. `BENCH_PORT_BASE` moves the
> harness's ports (default 12100).

## What is compared

| Configuration | What runs | Notes |
| --- | --- | --- |
| `rust` | gnome-server (release build, glibc, on the host) → HolyWisp | the product: zero-copy splice relay |
| `node1`, `node4` | the Node.js 26 baseline (`bench/node/`, built-ins only; 1 process or a 4-worker `node:cluster`) → HolyWisp | the same rules as gnome-server (§3.2); relays by copying |
| `node4-wispjs` | `node4` → wisp-js (4 workers) | an all-JavaScript stack |
| `holywisp` | HolyWisp direct (4 workers) | the Wisp server GNOME ships, without the gateway |
| `wispjs`, `wispjs4` | `@mercuryworkshop/wisp-js` 0.5.3 direct (1 process / 4 workers) | the common JavaScript Wisp server |
| `rust-ctr`, `rust-copy`, `rust+caddy` | gnome-server in a container (splice / no splice), and behind Caddy | **not run yet**: need d3a's static musl binary, the no-splice seccomp profile and the Caddy image |

The Node baseline is held to gnome-server's behaviour by the equivalence check (`node bench/run.mjs --check`): 51
fixed requests (assets in br/gzip/identity, `304`, SPA fallback, `/engine/`, `/sw.js`, a vendor file, `404`s,
reserved-prefix JSON `404`s, ticket mint with and without a session, bad JSON, unknown route, a VPN-location ticket,
`/api/session`, ticket probe `426`/`401` cases including the wrong-route refusal, upgrades without Origin, with the
app origin, with a bad version or key, without a ticket, and one that succeeds) compared header by header, plus
64 MiB pushed through each gateway to an echo and compared by SHA-256. It must pass before any timing run; the
accepted differences are listed in [bench/README.md](../bench/README.md#the-node-baseline-what-it-copies-and-the-accepted-differences).

## Scenarios

| ID | Scenario | Metrics |
| --- | --- | --- |
| W1 | Wisp bulk throughput to a counting sink on loopback: 1 conn × 1 stream, 1 × 10, 8 × 4, 64 × 4, 768 × 1 | MiB/s at the sink, CPU-s per GiB per process, peak RSS |
| W2 | Wisp latency: 64-byte ping-pong on one stream, idle and while W1 8 × 4 runs | p50 / p99 / p99.9 / max |
| W3 | (a) ticket probe + upgrade + CONNECT + 1-byte echo + close, 32 in flight from 8 source addresses; (b) stream open/close in one connection (direct servers) | ops/s, p50 / p99 |
| W4 | hold N idle Wisp connections (one idle stream each), then 1,000 of them move 128 KiB/s each | RSS per connection (gateway and Wisp server separately), slope between Ns |
| H1 | static: (a) hashed asset br, (b) gzip, (c) identity, (d) `304`, (e) the large vendor file from disk (brotli ≈ 700 KB), (f) SPA fallback, (g) `/engine/` on the proxy listener; closed loop and a fixed 5,000 req/s | req/s, p50 / p99 / p99.9, CPU µs per request |
| A1 | API: ticket mint (session cookie, `X-GNOME-Request: 1`), `/api/config`, `/api/session`; c = 64 and a fixed 2,000 req/s | as H1 |
| S1 | startup: exec → first `200` from `/api/health`: (a) warm, (b) after `posix_fadvise(DONTNEED)` on our files, (c) fresh data directory | ms p50 / p90 / max |
| R1 | memory at rest: 10 s after start, after H1 (a) c = 64, after W4 closed | RSS MiB |
| B1 | sizes: the stripped binary, crate counts | bytes |
| P1–P5 | frontend first load, route transitions, engine init, first proxied page, idle requests | **not measured yet** (open) |

## Method

- **Snapshots.** The build under test comes from a frozen copy of the tree (`git archive <commit>` or an rsync
  without `target/`, `node_modules/`, `dist/`, `data/`), built in the lane's own target directory; its id and the
  binary's SHA-256 are stored in `results.json`. baseline-1 = commit `900a6ff` (Wave B step 3 + Wave C, before any
  Wave D Rust change).
- **CPU sets.** Servers on 4 logical CPUs of 4 distinct physical cores with their SMT siblings idle; the load
  generator on the remaining physical cores. On this machine (6 cores × 2 threads): servers `0-3`, siblings `6-9`
  idle, load generator `4,5,10,11`. A two-process stack (gateway + Wisp server) shares the 4 server CPUs, as on a
  Raspberry Pi 4; a `node:cluster` primary is pinned there too and its CPU counted.
- **Quiet gate.** Before every repeat, 2 s of `/proc/stat`: every CPU of both sets ≥ 95 % idle and the 1-minute load
  ≤ 2, else wait and retry; a repeat that still fails is marked `noisy` and left out of medians when a clean repeat
  exists.
- **Timing.** Warm-up discarded, then the measured window; configurations interleaved per repeat. Presets: `quick`
  2 + 8 s, 1 repeat (2 for budgeted cells), ≤ 45 min; `record` 5 + 20 s, 3 repeats (5 for budgeted cells), ≈ 5 h.
  `run.mjs --plan` prints the estimate first.
- **Sampling.** Every 100 ms `VmRSS` of every process tree; at the end `Pss`, `utime + stime` over the window and the
  descriptor count, for each server process and the load generator (a cell whose load generator used more than
  90 % of its cores is marked load-generator-bound).
- **Loopback limits.** Per cell `ListenOverflows`, `TIME_WAIT` and `EADDRNOTAVAIL` are counted; an affected cell is
  marked and not quoted as a server number.
- **Statistics.** Median with min, max and IQR per metric; latency percentiles from the merged histograms of a cell's
  repeats; a difference is significant only when the medians differ by more than max(3 %, the larger IQR as a share
  of the "before" median) (`bench/compare.mjs`). Units: MiB/s (2²⁰ B), MiB/KiB for memory, ms/µs.
- **Machine record.** CPU, topology, governor, kernel, memory, Docker, rustc, Node, wisp-js versions, the read-only
  sysctls that bound loopback benchmarks, the pipes this UID held before the run, every command line (`$HOME`
  written as `~`).

## Results

**Dev smoke, shared machine** — `bench/results/2026-11-24-quick-dev-smoke` (preset quick, `--no-gate-wait`, 2026-11-24T20:16Z; load average during the run 9–14 from other agents' builds and tests). Build: baseline-1 (`900a6ff`), x86_64 glibc release; dist: plain build + harness siblings. Equivalence check: pass (51/51, 64 MiB echo equal on both gateways). Every cell is marked noisy. Full tables: `results.md` next to it.

W1 throughput, MiB/s (one repeat; budgeted cells two):

| shape | rust | node1 | node4 | node4-wispjs | holywisp | wispjs | wispjs4 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1x1 | 1,336 | 589 | 787 | 467 | 1,232 | 761 | 738 |
| 1x10 | 1,487 | 947 | 1,419 | 480 | 1,880 | 740 | 688 |
| 8x4 | 2,961 | 801 | 1,736 | 755 | 2,606 | 698 | 1,393 |
| 64x4 | 3,021 | 1,025 | 1,191 | 704 | 2,953 | 641 | 1,051 |
| 768x1 | 1,788 | 796 | 1,051 | 590 | 2,293 | 681 | 1,031 |

W2 / W3 latency (µs p50 / p99) and W3 rate:

| cell | rust | node1 | node4 | node4-wispjs | holywisp | wispjs | wispjs4 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| W2 idle | 72 / 147 | 78 / 168 | 88 / 311 | 129 / 737 | 34 / 59 | 47 / 82 | 80 / 2,359 |
| W2 under W1 8x4 | 1,704 / 5,243 | 7,602 / 15,991 | 5,112 / 20,972 | 44,040 / 102,760 | 262 / 4,850 | 66,060 / 85,983 | 52,429 / 104,858 |
| W3 (a) setup churn | 5,636 / 15,991 | 16,777 / 28,312 | 9,699 / 23,593 | 15,466 / 41,943 | 2,490 / 17,826 | 8,389 / 12,059 | 6,160 / 16,777 |
| W3 (a) ops/s | 5,045 | 1,806 | 3,042 | 1,853 | 7,816 | 3,638 | 4,670 |

H1 / A1 at c = 64 (req/s) and p99 at the fixed rate (µs):

| cell | rust req/s | node1 req/s | node4 req/s | rust p99 @rate | node1 p99 @rate | node4 p99 @rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| H1 (a) | 94,526 | 15,514 | 69,502 | 475 | 8,258 | 475 |
| H1 (b) | 84,093 | 21,459 | 58,670 | 117 | 606 | 4,456 |
| H1 (c) | 49,374 | 11,628 | 21,343 | 139 | 590 | 4,719 |
| H1 (d) | 171,939 | 26,052 | 59,255 | 100 | 106 | 3,342 |
| H1 (e) | 4,224 | 1,594 | 1,748 | 2,684,355 | 6,979,322 | 6,576,669 |
| H1 (f) | 141,384 | 14,737 | 71,046 | 92 | 2,097 | 934 |
| H1 (g) | 177,691 | 15,694 | 79,478 | 86 | 2,294 | 385 |
| A1 ticket | 135,734 | 7,927 | 39,552 | 233 | 1,507 | 950 |
| A1 config | 97,499 | 22,356 | 84,686 | 1,999 | 369 | 3,277 |
| A1 session | 20,548 | 14,912 | 57,665 | 2,490 | 623 | 1,573 |

Memory, startup, size:

- R1 rust (a) 10 s after start: gnome-server 23.7 MiB, holywisp 0.6 MiB
- R1 rust (c) after W4 N=1000 closed: gnome-server 33.3 MiB, holywisp 1.3 MiB
- R1 rust (b) after H1 (a) c=64: gnome-server 56.5 MiB, holywisp 1.8 MiB
- R1 node1 (a) 10 s after start: node-gateway 82.7 MiB, holywisp 0.6 MiB
- R1 node1 (b) after H1 (a) c=64: node-gateway 263.2 MiB, holywisp 0.8 MiB
- R1 node4 (a) 10 s after start: node-gateway 392.7 MiB, holywisp 0.6 MiB
- R1 node4 (c) after W4 N=1000 closed: node-gateway 570.7 MiB, holywisp 2 MiB
- R1 node4 (b) after H1 (a) c=64: node-gateway 975 MiB, holywisp 1.8 MiB
- R1 holywisp (a) 10 s after start: holywisp 0.6 MiB
- R1 holywisp (c) after W4 N=1000 closed: holywisp 1.3 MiB
- W4 rust N=1000: gnome-server 10.7 KiB/conn, holywisp 13.6 KiB/conn
- W4 rust N=3000: gnome-server 7 KiB/conn, holywisp 13.6 KiB/conn
- W4 node4 N=1000: node-gateway 25.7 KiB/conn, holywisp 13.6 KiB/conn
- W4 node4 N=3000: node-gateway 12.6 KiB/conn, holywisp 13.6 KiB/conn
- W4 holywisp N=1000: holywisp 13.6 KiB/conn
- W4 holywisp N=3000: holywisp 13.6 KiB/conn
- W4 wispjs N=1000: wispjs 50.7 KiB/conn
- W4 wispjs N=3000: wispjs 18.7 KiB/conn
- W4 rust slope N=1000→N=3000: gnome-server 10.5 KiB/conn, holywisp 14.1 KiB/conn
- W4 node4 slope N=1000→N=3000: node-gateway 97.2 KiB/conn, holywisp 14.3 KiB/conn
- W4 holywisp slope N=1000→N=3000: holywisp 14 KiB/conn
- W4 wispjs slope N=1000→N=3000: wispjs 74.2 KiB/conn
- S1 rust (a) warm: p50 43.7 ms, max 45.5 ms (10 runs)
- S1 rust (b) cold (fadvise): p50 43.5 ms, max 45.5 ms (10 runs)
- S1 rust (c) fresh data dir: p50 45.8 ms, max 48.6 ms (10 runs)
- S1 node1 (a) warm: p50 145.5 ms, max 156.7 ms (10 runs)
- S1 node1 (b) cold (fadvise): p50 153.2 ms, max 174.1 ms (10 runs)
- B1 gnome-server x86_64 glibc release (already stripped by the release profile): 12,876,208 B; 178 crates in `cargo tree -p gnome-server -e normal` (BB12 recorded 167 before Wave C), 234 packages in Cargo.lock

Runtime ceilings of §7 on this set (`node bench/compare.mjs --ceilings …`; informational on a noisy set):

```
ceilings of 2026-11-24-quick-dev-smoke (quick preset; dev smoke, shared machine: other agents were building and testing at the same time; not final numbers)
ok   RB1   R1 (a) gnome-server RSS MiB          23.70 (limit 64)
ok   RB2   R1 (b) gnome-server RSS MiB          56.50 (limit 96)
ok   RB3   W4 slope N=1000→N=3000 gnome-server KiB/conn 10.52 (limit 32)
ok   RB5   W1 1x10 rust / holywisp              0.79 (limit 0.7)
OVER RB6   W2 idle added p99 µs                 88.06 (limit 50)
OVER RB6   W2 idle added p99.9 µs               245.76 (limit 200)
OVER RB7   W3 (a) rust p99 µs                   15990.78 (limit 5000)
ok   RB8   H1 (a) c=64 rust / node4             1.36 (limit 1)
ok   RB8   H1 (a) 5000/s rust p99 µs            475.14 (limit 2000)
ok   RB9   A1 ticket 2000/s rust p99 µs         233.47 (limit 5000)
ok   RB10  S1 (a) rust p50 ms                   43.66 (limit 300)
ok   RB10  S1 (b) rust p50 ms                   43.48 (limit 800)
ok   RB10  S1 (c) rust p50 ms                   45.77 (limit 1000)
```

How to read this set (it is a smoke run, so only the rough shape is worth noting): the harness, the equivalence
check and every scenario ran with no errors; gnome-server serves static files and the API at 1.4–3× the 4-worker
Node cluster with a fraction of its memory (24 vs 393 MiB at rest) and starts in ≈ 44 ms; through the gateway, W1
1 × 10 reached 0.79 of HolyWisp direct (RB5 needs ≥ 0.70). The three ceilings over their limit (RB6 added idle
latency, RB7 setup p99) are latency tails, which is what a load average of 9–14 from other work inflates first;
they are the first thing the quiet run has to settle. Cells marked **X** in `results.md` (W1 1 × 1 rust, W3 (a)
rust, H1 (a) c = 64 rust, W1 768 × 1 node1 and wispjs) saw `ListenOverflows` grow; that counter is system-wide, so on
a shared machine other processes can cause it. No cell was load-generator-bound.

## Raspberry Pi 4

Not measured. The §7 Pi targets (whole stack at rest ≤ 160 MiB, warm startup ≤ 2 s, 200 open Wisp connections
≤ +16 MiB) are estimates until someone runs `node bench/run.mjs --preset quick --cpus servers=0-3,loadgen=0-3` on a
Pi (servers and load generator then share the 4 cores, so throughput rows are load-generator-bound and only the
memory and startup rows are meaningful) or, better, drives the Pi from a second machine.

## History

| Date | Set | Build | Preset | Status |
| --- | --- | --- | --- | --- |
| 2026-11-24 | `bench/results/2026-11-24-quick-dev-smoke` | baseline-1 (`900a6ff`), x86_64 glibc | quick, `--no-gate-wait` | dev smoke on a shared machine; not final |

## Open

- The quotable run: `--preset quick` in a quiet window (or `record`), on the final tree; AC2 and AC6 (repeatability)
  need it.
- d1b: profiling and the optimization loop (O1–O10), the release-profile and allocator records (D5, D6, D7); the
  allocator decision is the final step's quick check.
- `rust-ctr`, `rust-copy` (`bench/lib/no-splice.json`), `rust+caddy`; static musl and aarch64 sizes (B1, BB9).
- P1–P5 (`tests/e2e/engine/suites/perf-frontend.mjs`).
- W4 at 5,000 and 10,000 connections and the default-caps row; S1 with 30 runs; H1 at c = 1, 16, 256.
- Rebasing the build-time ceilings of `scripts/budgets.json` on baseline-1's release `dist/` (D26).
