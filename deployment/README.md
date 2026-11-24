# deployment/

The developer's view of GNOME's deployment files (WAVE-D §5). The operator's guide is
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

| File | What |
| --- | --- |
| `Dockerfile` (+ `Dockerfile.dockerignore`) | gnome-server image: release `dist/` built once (Node 26 Alpine), gnome-server cross-compiled per target as a static musl binary with clang through `tonistiigi/xx` (no binfmt; an arm64 binary runs only under a directly invoked `qemu-aarch64` inside the build stage), FROM-scratch runtime. Targets: `runtime` (default), `server-out`, `licenses-out`, `frontend-out`, `release-out` |
| `compose.yml` | the stack: `caddy` (only published service) → `gnome` → `holywisp` |
| `compose.vpn.yml` | VPN egress override (gluetun + HolyWisp exits; static checks only) |
| `compose.test.yml` | e2e override (TLS from files, loopback ports, `.localhost` hostnames) |
| `.env.example` | every variable the compose files read |
| `Caddyfile`, `caddy/` | Caddy for both routes; `caddy/Dockerfile` makes the official image run as 65532 without capabilities; `tls-{acme,files}.caddy` and `bind-{any,loopback}.caddy` are chosen by `GNOME_TLS_MODE` / `CADDY_BIND_MODE` |
| `systemd/` | `gnome-server.service`, `gnome.env.example`, `route-b.env.example`, the credentials drop-in example, HolyWisp's egress-deny drop-in example |
| `init-secrets.sh` | random secrets into `secrets/` (0750/0640, group `GNOME_SECRETS_GID`) |
| `check.sh` | static checks (below) |
| `tests/image.sh` | rows I1–I3 on a built image |
| `tests/arm64.sh` | rows I4/RP1: an aarch64 binary under `qemu-aarch64` in an unprivileged container (`--network none`) |
| `tests/syscalls.sh` | row SD1 (reduced workload): the static musl binary under `strace` vs the unit's filter |
| `tests/egress-probe.sh` | for operators: what answers on the host's public IP from HolyWisp's network |

## Build

```sh
# amd64 image for this machine (≈ 6 min cold with 3 cargo jobs)
docker buildx build -f deployment/Dockerfile --platform linux/amd64 --build-arg CARGO_BUILD_JOBS=3 -t gnome-server:dev --load .
# the static arm64 binary only (cross-compiled, no binfmt)
docker buildx build -f deployment/Dockerfile --platform linux/arm64 --target server-out --output type=local,dest=out/arm64 .
deployment/tests/arm64.sh out/arm64
# Caddy
docker build -f deployment/caddy/Dockerfile -t gnome-caddy:dev deployment
# release artifacts (both architectures, checksums; see scripts/release.sh --help)
scripts/release.sh --skip-audit "<reason>" --no-third-party-source
```

The build context is the repository root; `Dockerfile.dockerignore` admits only `Cargo.*`, `LICENSE`, `backend/`,
`crates/`, `database/`, `frontend/` (without `node_modules/`, `dist/`) and `scripts/`, and denies secrets, databases,
keys, `.env*` (except examples), test output and `.claude/` also inside them. Base images and Alpine packages are
pinned; `scripts/release.sh` fails when the built packages drift from the pins.

## Checks

```sh
deployment/check.sh                     # compose policy, Caddy adapt/fmt, systemd-analyze verify+security, shellcheck, hadolint
deployment/check.sh --no-docker-tools   # without the pinned tool images
deployment/tests/image.sh gnome-server:dev
deployment/tests/syscalls.sh <static musl gnome-server> <release dist/>
node tests/e2e/engine/suites/build-release.mjs          # BR-rows on a release dist/
```

`syscalls.sh` is written for the static musl binary the unit runs; a glibc build is not what the unit is written for
(its resolver may need `AF_NETLINK`). Nothing here boots systemd, registers binfmt or runs a privileged container;
every test container runs with `--cap-drop ALL --security-opt no-new-privileges`, read-only and, where nothing needs
the network, `--network none`.

## Network prefix

`GNOME_NET_PREFIX` (default `172.30`) moves `<prefix>.80.0/24` (edge), `<prefix>.81.0/24` (wisp) and
`<prefix>.64.0/24` (VPN override) together with every fixed address. With the VPN override, the HolyWisp exit
configurations (`vpn/egress/*.conf`: `--trusted-proxy <prefix>.64.10`) and `vpn/profiles.toml` (`<prefix>.64.2:<port>`)
must follow it by hand.
