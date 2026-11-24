# Supply-chain audit

GNOME's dependency audit (WAVE-D D24): what is checked, how to run it, the policy, and the first audit with every
finding and its decision.

## How to run it

```sh
scripts/audit.sh                 # needs the network (RustSec database, npm registry)
scripts/audit.sh --offline       # cached advisory database; npm audits are "skipped", never "pass"
scripts/audit.sh --json out.json # also writes the summary (release.sh puts it into BUILDINFO)
node --test scripts/audit/npm-audit.test.mjs   # the npm classification on recorded fixtures (no network)
```

Exit codes: 0 pass, 1 policy failure, 2 usage or tool error (a missing tool prints its install command).

Tools are pinned and installed per user, never system-wide:

```sh
cargo install --locked --version 0.22.1 --root ~/.cache/gnome-tools/cargo-deny-0.22.1 cargo-deny
cargo install --locked --version 0.23.0 --root ~/.cache/gnome-tools/cargo-audit-0.23.0 cargo-audit   # first audit only
```

`CARGO_DENY=<path>` points the script at another copy of the same version.

## What is checked

| Part | Tool | Policy |
| --- | --- | --- |
| Rust workspace | `cargo deny --locked check` (advisories, licenses, bans, sources) | `deny.toml` |
| `bench/loadgen` (own workspace, never shipped) | `cargo deny check advisories sources` | `deny.toml` |
| `deny.toml` ignores | `scripts/audit.sh` | every `ignore` entry has a reason and `# expires: YYYY-MM-DD` at most 90 days ahead; an expired one fails |
| npm: `frontend/`, `tests/e2e/`, `bench/wispjs/` | `npm audit --json --package-lock-only` through `scripts/audit/npm-audit.mjs` | `scripts/audit/npm-policy.json` |
| Install scripts in the npm locks | `npm-audit.mjs` | only allow-listed packages may have `hasInstallScript` (installs run with `--ignore-scripts` anyway) |
| Code compiled into the vendored wasm | `scripts/audit/embedded.mjs` | versions recorded; CA bundle at most 12 months old |
| Pinned third-party images | `scripts/audit.sh` (lists name, tag, digest) | Caddy and gluetun binaries: `govulncheck -mode=binary` at least every 30 days and on every pin change |

### Rust policy (`deny.toml`)

- Targets: `x86_64-unknown-linux-gnu`, `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`; dev dependencies are
  excluded from the license check (they are never distributed).
- Advisories (RustSec): vulnerabilities and yanked crates fail; unmaintained and unsound advisories are reported and
  get a decision row below.
- Licenses: exact SPDX ids that may be combined with AGPL-3.0-only in a distributed binary: MIT, Apache-2.0 (also
  `WITH LLVM-exception`), BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, BSL-1.0, CC0-1.0, Unicode-3.0,
  CDLA-Permissive-2.0, MPL-2.0, LGPL-2.1-or-later, LGPL-3.0-only, LGPL-3.0-or-later, GPL-3.0-only, GPL-3.0-or-later,
  AGPL-3.0-only, AGPL-3.0-or-later. Everything else (GPL-2.0-only, SSPL, BUSL, "Commons Clause", no license) is
  denied. GNOME's own crates are private (unpublished).
- Bans: duplicate versions warn; wildcard version requirements are denied (path dependencies of private crates are
  allowed); `openssl`, `openssl-sys`, `native-tls`, `aws-lc-rs`, `aws-lc-sys` are denied (no C TLS stacks).
- Sources: crates.io only; unknown registries and every git source are denied.

### npm policy (`scripts/audit/npm-policy.json`)

- **Shipped** packages reach browsers: today every package of `frontend/` counts as shipped. This is deliberately
  wider than the plan's definition (`dependencies`, the `VENDOR_PACKAGES` pins, every package bundled inside a
  vendored package, and packages with modules in GNOME's chunk graphs), because the chunk graphs that would narrow it
  are not written yet (WAVE-D §4.6, lane d2b). Packages bundled inside vendored packages
  (copy-vendor's transitive `dependencies`, e.g. `libcurl.js`, `@mercuryworkshop/epoxy-tls`) count as shipped from
  any project.
- **Build-only**: `tests/e2e/` and `bench/wispjs/`.
- A shipped high or critical finding fails. Shipped moderate and every build-only finding are reported and need a
  decision row here within 30 days, but do not fail.
- Ignores: `{"advisory": "GHSA-…"}` or `{"package": "name"}` with a `reason` and an `expires` date at most 90 days
  ahead; an expired ignore fails and stops ignoring.
- Install-script allow-list: `fsevents` (never installs on Linux) and `bench-wispjs:bufferutil` (an optional native
  add-on of `ws` used by the wisp-js benchmark baseline; it is never built because installs run with
  `--ignore-scripts`, and `ws` falls back to JavaScript).
- The same file holds the license allow-list of shipped npm packages that `frontend/scripts/third-party-notices.mjs`
  enforces (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, MPL-2.0, OFL-1.1, 0BSD, CC0-1.0, Unlicense,
  LGPL-3.0-only, LGPL-3.0-or-later, AGPL-3.0-only, AGPL-3.0-or-later), with `AGPL-3.0` (Ultraviolet's
  `VENDOR_PACKAGES` entry) clarified to AGPL-3.0-only.

## First audit (2026-11-24)

Machine: the development PC (x86_64, CachyOS). Tree: branch `waves-b3-c-d` after commit 900a6ff with Wave D's
working-tree changes. Command: `scripts/audit.sh --json …`. Tools: cargo-deny 0.22.1, cargo-audit 0.23.0, Node
v26.13.0, npm 12.2.1. RustSec advisory database: revision `1d328b6bb9f2f350bf65c1c81ab68781cb9e018a`
(2026-11-24T10:21:37+01:00). Result: **fail**, two findings, both with a fix that needs a file another lane owns
(change requests in the lane report; with both applied in a scratch copy of the tree, `cargo deny --locked check`
passes: advisories ok, bans ok, licenses ok, sources ok).

| Finding | Where | Decision |
| --- | --- | --- |
| **RUSTSEC-2026-0592** (vulnerability): stack overflow in `Url::origin()` on nested `blob:` URLs, `url` 2.5.8 | `Cargo.lock` (via `gnome-net`, `reqwest`, `tower-http`). GNOME calls `Url::origin()` in `backend/src/filters/text.rs` (filter-list URL checks) and `crates/net/src/client.rs` (redirect checks) on URLs from filter lists and upstream redirects | **Fix**: `cargo update -p url --precise 2.5.9` (a patch release; no other crate changes). `Cargo.lock` belongs to lane d1b: change request; not ignored |
| **wildcard** (bans): `gnome-server`'s path dependencies on `gnome-net` and `gnome-catalog` count as wildcards because the crates are not marked unpublished | `backend/Cargo.toml`, `crates/net/Cargo.toml`, `crates/catalog/Cargo.toml` | **Fix**: `publish = false` in the three manifests (they are never published; it also makes `[licenses.private]` apply). Manifests belong to lane d1b: change request |
| duplicate versions (warning, C3): `getrandom` (2), `tower-http` (2) | `Cargo.lock` | Accepted for now; d1b's dependency trimming (D7) decides whether one copy can go |
| unmaintained / unsound advisories | — | none reported |
| `cargo audit` (cross-check) | `Cargo.lock`, 234 crates | 1 vulnerability, RUSTSEC-2026-0592: equal to the advisories check |
| `bench/loadgen` advisories and sources | `bench/loadgen/Cargo.lock` | pass |
| npm audit `frontend/` (shipped) | 0 findings | pass |
| npm audit `tests/e2e/`, `bench/wispjs/` (build-only) | 0 findings | pass |
| Install scripts | `bench/wispjs`: `bufferutil` | allow-listed (see the policy above) |

License inventory (cargo-deny, 183 crates for the three targets): 92 `MIT OR Apache-2.0`, 35 `MIT`, 18
`Unicode-3.0`, 11 `Apache-2.0 OR MIT`, 3 `BSD-3-Clause`, 3 `AGPL-3.0-only` (GNOME's own), 3 `Apache-2.0 OR ISC OR
MIT`, 3 `Apache-2.0`, and single crates under `BSD-3-Clause OR MIT`, `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR
MIT`, `ISC`, `0BSD OR MIT OR Apache-2.0`, `Zlib`, `MIT OR BSD-3-Clause`, `Unlicense OR MIT`, `MIT OR Zlib OR
Apache-2.0`, `Apache-2.0 OR ISC`, `Apache-2.0 OR BSL-1.0`, `MIT OR Apache-2.0 OR Unicode-3.0`, `CDLA-Permissive-2.0`.
Every one is allowed.

Policy checks of the policy itself (row AU3, 2026-11-24, scratch crates outside the tree): a dependency under
`GPL-2.0-only` fails `cargo deny check licenses` ("license is not explicitly allowed"); a git dependency fails
`cargo deny check sources` ("detected 'git' source not explicitly allowed").

### Wasm-embedded code

| Component | Version | Source |
| --- | --- | --- |
| libcurl.js | 0.7.5 | `frontend/node_modules/libcurl.js/package.json` |
| curl (inside libcurl.wasm) | 8.23.0-DEV | version string in `libcurl.wasm` |
| @mercuryworkshop/epoxy-tls | 2.1.20-1 | its `package.json` |
| Mbed TLS, nghttp2, brotli, CA bundle date | not recorded | libcurl.js formats them at run time: needs one engine-host init in a test browser (open) |
| epoxy-tls `Cargo.lock` advisories | not run | needs the checkout at its `scripts/third-party-sources.json` revision (open) |

### Pinned images

Found in `deployment/`, `services/` and `bench/` (name:tag@sha256, digests abbreviated here; the script prints them
in full): `alpine:3.22@sha256:49340b346798…`, `caddy:2.11-alpine@sha256:003a97808e78…`,
`docker/dockerfile:1@sha256:4edf897a3ffa…`, `tonistiigi/xx:1.10.0@sha256:40fe21f44bb8…`,
`node:26-alpine3.22@sha256:c7932b9e5e33…`, `rust:1.99-alpine3.22@sha256:9a744dc47d1a…`,
`hadolint/hadolint:v2.14.0@sha256:27086352fd5e…`, `koalaman/shellcheck:v0.10.0@sha256:2097951f02e7…` (the last two
are check tools, never shipped). No gluetun digest pin was found. `govulncheck -mode=binary` on the Caddy and gluetun
binaries was **not run** (row AU6 open): it needs a pinned Go image; `scripts/audit.sh` reports it as skipped.

## Open items

- AU1 passes once the two change requests above are applied (`Cargo.lock` `url` 2.5.9; `publish = false`).
- AU5 runtime versions (Mbed TLS, nghttp2, brotli, the CA bundle's date) and the epoxy-tls advisories check.
- AU6 `govulncheck` on Caddy and gluetun; a gluetun digest pin.
- The npm "shipped" set narrows to the plan's definition once the chunk graphs exist (d2b).

## Updating a pin

- **HolyWisp**: `services/holywisp/README.md` "Updating the pin".
- **Caddy, gluetun, base images** (Node, Rust, `xx`, Alpine): read the project's advisories since the pinned
  version, bump the tag and digest in the file that pins it, rerun `deployment/check.sh` and the deploy rows, then
  `scripts/audit.sh`.
- **Rust crates**: `cargo update -p <crate> --precise <version>` (lane d1b owns `Cargo.lock`), regenerate About's
  crate list (`node frontend/scripts/rust-crates.mjs`), run the workspace tests and `scripts/audit.sh`.
- **npm packages**: change the exact version in the project's `package.json`, `npm install --ignore-scripts`, rerun
  the tests and `scripts/audit.sh`.
