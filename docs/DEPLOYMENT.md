# Deploying GNOME

The operator's guide (WAVE-D §5.7). Three supported routes, all built from the same release recipe:

- **Route A — the Docker stack** (`deployment/compose.yml`): Caddy → gnome-server → HolyWisp, optional VPN egress.
- **Route B — the release artifact with systemd** (`gnome-<v>-linux-<arch>.tar.gz`) behind the same Caddy configuration.
- **Route C — either of them on a Raspberry Pi 4** (64-bit OS only).

"Tested" below means a check in this repository ran it on the build machine (x86_64, Docker 29.9, unprivileged
containers only). What was not run is listed in [What was tested](#what-was-tested-and-what-was-not).

## Requirements

- A Linux host with a public IPv4 (and ideally IPv6) address, ports 80 and 443 reachable from the internet.
- Two DNS names for **sibling hostnames**, both pointing at the host: the app (`gnome.example.com`) and the proxy
  origin (`p.gnome.example.com`). See [Choosing hostnames](#choosing-hostnames).
- Route A: Docker Engine ≥ 27 with the Compose plugin and buildx. Building the images needs ≈ 4 GB of RAM and
  10 GB of disk (Rust fat-LTO link; estimate). Route B: systemd ≥ 249 (≥ 254 for every unit key), Caddy 2.
- Building a release (`scripts/release.sh`) needs Node ≥ 22.12, Docker with buildx, `curl`, `openssl`, `git`.

## Route A: the Docker stack

```sh
git clone <your GNOME repository> gnome && cd gnome
cp deployment/.env.example deployment/.env
$EDITOR deployment/.env                       # GNOME_APP_HOST, GNOME_PROXY_HOST, ACME_EMAIL
deployment/init-secrets.sh --admin-token      # random admin token into deployment/secrets/ (never printed)
deployment/check.sh --no-docker-tools         # static policy checks of the files
docker compose -f deployment/compose.yml up -d --build
docker compose -f deployment/compose.yml ps   # gnome becomes "healthy", then caddy starts
```

The first `--build` compiles gnome-server (≈ 6 min on a 12-thread x86_64 with `CARGO_BUILD_JOBS=3`, measured
2026-11-24) and HolyWisp. What runs:

| Service | Image | Published | Hardening |
| --- | --- | --- | --- |
| `caddy` | `gnome-caddy` (official Caddy 2.11, file capability removed) | 80 → 8080, 443 → 8443 | user 65532, read-only, `cap_drop: ALL`, no-new-privileges, 512 MiB, 512 pids |
| `gnome` | `gnome-server` (FROM scratch: one static binary, the web app, the licenses) | none | user 65532, read-only, tmpfs `/tmp` 16 MiB noexec, `cap_drop: ALL`, no-new-privileges, 1 GiB, 1024 pids |
| `holywisp` | `gnome-holywisp:0.1.0-e0a0f15` | none | read-only, `cap_drop: ALL`, no-new-privileges, 1 GiB, 128 pids |

Networks: `edge` (172.30.80.0/24 + a ULA IPv6 /64: caddy, gnome) and `wisp` (172.30.81.0/24: gnome, holywisp). Caddy
cannot reach HolyWisp; HolyWisp refuses private destinations, so it reaches neither Caddy, gnome-server nor your LAN.
If your LAN or another Docker network already uses `172.30.80-81.x`, set `GNOME_NET_PREFIX` (and `GNOME_NET6_PREFIX`).

First checks:

```sh
curl -sI https://gnome.example.com/ | head -5                   # 200, strict headers
curl -s https://p.gnome.example.com/api/health                  # the proxy origin's minimal health answer
docker compose -f deployment/compose.yml exec gnome gnome-server health
docker compose -f deployment/compose.yml exec gnome gnome-server admin get /admin/diagnostics
```

TLS from your own certificate instead of ACME: `deployment/init-secrets.sh --tls-cert fullchain.pem --tls-key key.pem`
and `GNOME_TLS_MODE=files` in `.env`.

### Secrets

Secrets are files in `deployment/secrets/` (directory 0750, files 0640, group `GNOME_SECRETS_GID`), mounted read-only
at `/run/secrets` and named by `GNOME_ADMIN_TOKEN_FILE`, `GNOME_ACCESS_CODE_FILE`, `GNOME_SECRET_KEY_FILE` in `.env`.
Compose ignores a file secret's `uid`/`gid`/`mode` outside Swarm, so the containers read them through `group_add` of
your group; `init-secrets.sh` refuses a group with other members unless `--allow-shared-group`, and writes `0` under
rootless Docker. Never put a secret value into `.env`, `environment:` or shell history. Without a secret-key file the
server generates `secret.key` into its data volume.

- Admin token: ≥ 16 characters (`init-secrets.sh --admin-token`). A new token needs a restart.
- Secret key: `openssl rand -base64 48`. A new key (or access code) ends every anonymous session and Wisp ticket;
  signed-in sessions are stored tokens and survive.

## Route B: the release artifact with systemd

Verify **before unpacking** (the inner `SHA256SUMS` travels inside the tarball and proves nothing about it):

```sh
ssh-keygen -Y verify -f allowed_signers -I <maintainer> -n gnome-release -s SHA256SUMS.sig < SHA256SUMS   # when signed
sha256sum -c --ignore-missing SHA256SUMS
tar -xzf gnome-<v>-linux-x86_64.tar.gz && cd gnome-<v>-linux-x86_64
```

Install (as root):

```sh
install -m 0755 bin/gnome-server bin/holywisp /usr/local/bin/
mkdir -p /usr/local/share/gnome && cp -r share/gnome/dist /usr/local/share/gnome/
mkdir -p /usr/local/share/licenses/gnome && cp -r share/licenses/. /usr/local/share/licenses/gnome/
install -d -m 0755 /etc/gnome /etc/holywisp && install -d -m 0700 /etc/gnome/credentials
install -m 0600 etc/gnome.env.example /etc/gnome/gnome.env          # then edit the hostnames
install -m 0644 etc/holywisp.conf /etc/holywisp/holywisp.conf
cp etc/systemd/gnome-server.service etc/systemd/holywisp.service /etc/systemd/system/
# The admin token is part of the first install: without it any local user passes the admin listener's loopback check.
umask 077; head -c 36 /dev/urandom | base64 > /etc/gnome/credentials/admin_token
mkdir -p /etc/systemd/system/gnome-server.service.d
cp etc/systemd/gnome-server.service.d/credentials.conf.example /etc/systemd/system/gnome-server.service.d/credentials.conf
systemctl daemon-reload && systemctl enable --now holywisp gnome-server
```

Caddy on the same host, with the same Caddyfile: install Caddy 2 from your distribution, copy `etc/Caddyfile` and
`etc/caddy/*.caddy` to `/etc/caddy/`, and give Caddy's unit the values of `etc/route-b.env.example`
(`EnvironmentFile=`): it listens on 80/443 and forwards to gnome-server's loopback listeners `127.0.0.1:8080` (app)
and `127.0.0.1:8081` (proxy role). The unit `gnome-server.service` runs with `DynamicUser=yes`, `StateDirectory=gnome`,
an empty capability set, `ProtectSystem=strict`, a system-call filter and `SocketBindAllow` for 8080/8081/9091 (edit
both when you change ports). `systemd-analyze security` rates it 1.4 ("OK") with systemd 262. Minimum versions:
`ProtectProc`/`ProcSubset` 247, `SocketBindAllow` 249, `RestartSteps`/`RestartMaxDelaySec` 254; on systemd 252 (Debian
12, Raspberry Pi OS bookworm) the restart delay stays at 2 s instead of growing to 60 s.

## Choosing hostnames

The supported default is two **sibling hostnames** under one registrable domain (`gnome.example.com` and
`p.gnome.example.com`). Costs: the two origins are same-site (cookies set by a proxied page on the proxy origin are
same-site with the app, which gnome-server tolerates: large request heads from its trusted front are accepted, D19),
browsers may put app and engine host in one renderer process, and the `__Host-` session cookie relies on a trusted
HTTPS front. The alternative — the proxy origin on a separate registrable domain — partitions the engine's state from
the app; it is not the tested default.

## VPN egress

`docker compose -f deployment/compose.yml -f deployment/compose.vpn.yml up -d` adds gluetun and one HolyWisp per exit
(recipe A of `services/vpn/README.md`; read it first: your own account, your own household). gluetun is the stack's
one documented exception: Docker's default capabilities plus `NET_ADMIN` and `/dev/net/tun` (never `privileged`).
This override is checked statically only; it has never been started by GNOME's tests.

## Operations

- **Backups**: the data directory holds `gnome.db` (+ WAL), `secret.key`, `filters/`, `oss-games/` and the
  thumbnail cache; only the database and the key need a backup.
  `docker compose -f deployment/compose.yml exec gnome gnome-server db backup /var/lib/gnome/backups-$(date +%F).db`
  (the target must not exist; it is created 0600, `VACUUM INTO`, integrity-checked) then
  `docker compose -f deployment/compose.yml cp gnome:/var/lib/gnome/backups-<date>.db .`. Route B: run
  `gnome-server db backup` with the unit's environment (`GNOME_DATA_DIR=/var/lib/gnome`). Back up the `caddy-data`
  volume too (ACME account and certificates; losing it forces re-issuance and can hit rate limits).
  **Restore**: stop gnome, move `gnome.db`, `gnome.db-wal`, `gnome.db-shm` aside, copy the backup to `gnome.db`, start.
- **Upgrades**: back up; pull or build the new images (`docker compose ... up -d --build`) or replace the artifact;
  `gnome-server config check`; start. Migrations run forward at start and are append-only; a downgrade is refused
  ("written by a newer release") and needs the backup. A new `dist/` needs a restart. Restarting HolyWisp drops open
  Wisp connections; the transports reconnect.
- **Logs**: JSON on stderr (`docker compose logs gnome`, `journalctl -u gnome-server`); no IP addresses or query
  strings unless `GNOME_LOG_IPS=true`. Caddy's logger deletes client addresses and headers and strips query strings
  (Wisp tickets travel as `?t=`); access logs are off.
- **Health and metrics**: `gnome-server health` (exit 0 = ok), `/api/health` on both hostnames,
  `gnome-server admin get /admin/diagnostics` and `/admin/metrics`. Useful alerts: `gnome_wisp_upstream_up`,
  `gnome_http_connections_refused_total`, `process_open_fds` against `process_max_fds`, `gnome_db_size_bytes`. To let a
  scraper read metrics, put the admin listener on an extra `internal: true` network shared only with the scraper,
  with `GNOME_ADMIN_ALLOW_REMOTE=true` and an admin token file — never `ports:`.
- **Capacity**: `GNOME_MAX_CONNECTIONS` (default 4096) and the descriptor limit 65536; the per-user pipe budget of the
  kernel (`fs.pipe-user-pages-soft`: beyond ≈ 512 spliced connections new ones get small pipes; raising it is your
  choice); `GNOME_SYNC_QUOTA_MB` per account; `mem_limit` / `MemoryMax=` 1 GiB each (estimates).

## Raspberry Pi 4

Every Pi number here is an **estimate** until measured on a Pi.

- **OS**: a 64-bit OS (Raspberry Pi OS 64-bit, Debian or Ubuntu arm64) is required: the release binaries are
  `aarch64` static musl and HolyWisp has no 32-bit build at its pin. 4 or 8 GB recommended; 1–2 GB should work with
  the smaller settings below (estimate, not run).
- **Binaries**: the artifact `gnome-<v>-linux-aarch64.tar.gz` (route B), or arm64 images built on any amd64 machine
  (`docker buildx build -f deployment/Dockerfile --platform linux/arm64 -t gnome-server:<v> --output type=docker,dest=gnome-server-arm64.tar .`;
  cross-compiled by `tonistiigi/xx`, no binfmt), then `ssh pi docker load < gnome-server-arm64.tar`. Building on the
  Pi itself (`cargo build --release --locked -p gnome-server`) needs more memory than 1–2 GB for the fat-LTO link
  (estimate); `CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` gives a functionally equal but
  not reproducible binary.
- **Small hosts**: keep `GNOME_ARGON2_MEMORY_KIB=19456`; `GNOME_DB_READERS=2` and `GNOME_MAX_CONNECTIONS=1024` on 1 GB;
  HolyWisp `max-concurrent-connections = 2000`, `max-streams-per-conn = 256`; lower `GNOME_MEM_LIMIT` /
  `GNOME_CADDY_MEM_LIMIT` so they add up below the RAM; data on a USB SSD rather than the SD card. If Docker warns that
  memory limits are unsupported, Raspberry Pi OS booted without the memory cgroup: add
  `cgroup_enable=memory cgroup_memory=1` to `cmdline.txt` (documented, not run here).
- **Basis of the estimates**: Cortex-A72 without SHA-2/AES instructions (hashing and AES-GCM in software; Caddy's TLS
  and startup hashing are most affected), 4 cores at 1.5–1.8 GHz, 4 KiB pages, the same 64-bit build and allocator.
  A Raspberry Pi 5 (16 KiB pages by default) is untested.

## Other fronts and CDNs

Only Caddy with `deployment/Caddyfile` is tested. Any other front must: accept request heads above what browsers send
(Caddy here: `max_header_size 4MB`); put the strict policy (`Content-Security-Policy: default-src 'none'; form-action
'none'; base-uri 'none'; frame-ancestors 'none'`, `nosniff`, `no-store`) on every answer it writes itself; pass
WebSocket upgrades without an idle timeout shorter than the transports' keep-alive; keep `Host` (or set
`X-Forwarded-Host`); overwrite — never append — `X-Forwarded-Proto` and `X-Forwarded-Host`; be listed in
`GNOME_TRUSTED_PROXIES`; remove `Cookie` on the proxy hostname; log no client addresses or query strings. A CDN in
front of Caddy: list its ranges in Caddy's `trusted_proxies` and in `GNOME_TRUSTED_PROXIES`. A CDN whose request-header
limit is below browser limits (Cloudflare's proxied mode documents 32 KB) does not meet the first condition for the
proxy hostname.

## Security checklist

- Only Caddy publishes ports; the admin listener stays on loopback (`check.sh` asserts both for the stack).
- Secrets only as files (`*_FILE`); `deployment/secrets/` and `deployment/.env` are ignored by git, both build
  contexts and the source tarball.
- `GNOME_REGISTRATION=closed` unless you want anyone to create accounts; `GNOME_ACCESS_MODE=code|accounts` to limit
  who may use the proxy.
- **Egress to the host's own addresses** (hairpin): HolyWisp refuses private destinations but cannot know your public
  IP. Bind services on the host to loopback or private interfaces; make sure your router's admin page does not answer
  on its WAN address. Route B: fill in `etc/systemd/holywisp.service.d/egress-deny.conf.example`. Route A: you may add
  a `DOCKER-USER` iptables rule dropping `172.30.81.0/24` → your public addresses (a host change; never run by the
  tests). `deployment/tests/egress-probe.sh <public-ip>` reports what answers from HolyWisp's network.
- IPv6 client addresses: the `edge` network is dual-stack so Docker NATs IPv6 and keeps client addresses instead of
  showing the bridge gateway (not measured here: it needs a port published on a non-loopback address). Hosts that
  cannot do it may run Caddy with `network_mode: host` (an exception you document yourself).
- Source offer (AGPL-3.0 §13): set `GNOME_SOURCE_URL` to where your users get the source of what you run.

## Third-party software pulled by the deployment files

Caddy (Apache-2.0) and gluetun (MIT) are pulled by the compose files, not redistributed in GNOME's artifact. The
artifact's `share/licenses/` and the image's `/usr/share/licenses/gnome/` carry GNOME's AGPL-3.0 text, the Rust crates,
the Rust standard library and musl notices, the bundled npm packages, the vendored engines' licenses, HolyWisp (ISC)
and SQLite's dedication.

## Deployment variables

| Variable (deployment/.env) | Default | Meaning |
| --- | --- | --- |
| `GNOME_APP_HOST`, `GNOME_PROXY_HOST` | — | the two hostnames (required) |
| `ACME_EMAIL` | — | ACME account e-mail (required in acme mode) |
| `GNOME_TLS_MODE` | `acme` | `acme` or `files` |
| `GNOME_TLS_CERT_FILE`, `GNOME_TLS_KEY_FILE` | `/run/secrets/tls/{cert,key}.pem` | files mode |
| `GNOME_HTTP_PORT`, `GNOME_HTTPS_PORT` | 80, 443 | published ports |
| `GNOME_SERVER_IMAGE`, `GNOME_CADDY_IMAGE`, `GNOME_HOLYWISP_IMAGE` | local tags | images |
| `GNOME_NET_PREFIX`, `GNOME_NET6_PREFIX` | `172.30`, `fd47:6e6f:6d65:80` | Docker subnets |
| `GNOME_SECRETS_GID` | 65532 | group that reads `deployment/secrets/` |
| `GNOME_MEM_LIMIT`, `GNOME_CADDY_MEM_LIMIT` | `1g`, `512m` | memory ceilings |
| `GNOME_HSTS` | `true` | HSTS (one year, no includeSubDomains) |
| `GNOME_ACCESS_MODE`, `GNOME_REGISTRATION` | `open`, `closed` | who may use the proxy / register |
| `GNOME_SOURCE_URL` | the release default | source offer |
| `GNOME_LOG`, `GNOME_LOG_IPS` | `info`, `false` | logging |
| `GNOME_ADMIN_TOKEN_FILE`, `GNOME_ACCESS_CODE_FILE`, `GNOME_SECRET_KEY_FILE` | empty | secret files |

gnome-server's own variables are in `docs/ARCHITECTURE.md` §4.2 (`gnome-server config check` prints them all).

## What was tested and what was not

Tested on the build machine (2026-11-24): the amd64 image builds and runs read-only, unprivileged, without a shell
(`deployment/tests/image.sh`); `deployment/check.sh` (compose policy for the stack, the VPN and test overrides; Caddy
adapt/fmt in both TLS modes; `systemd-analyze verify` and `security`; shellcheck; hadolint); the release pipeline
(`scripts/release.sh`) and the release `dist/` rows `tests/e2e/engine/suites/build-release.mjs` (BR1–BR8 except BR9);
the CLI operations (`backend/tests/cli_ops.rs`); the x86_64 artifact rebuilt without any build cache gave a
byte-identical tarball (`release.sh --verify-reproducible`); the aarch64 artifact's `gnome-server` (`version`, `config
check`, a loopback `serve` + `health`) and `holywisp --version` under a directly invoked `qemu-aarch64` in an
unprivileged container (`deployment/tests/arm64.sh`, no binfmt); a reduced syscall trace of the static binary fits
the unit's filter (`deployment/tests/syscalls.sh`: no Wisp, Argon2 or sync workload yet). The per-run results are in
the Wave D report.

Integration step (d-final, 2026-11-24, final tree): `release.sh --arch x86_64,aarch64 --image --sign <throwaway key>`
built both artifacts and both image archives (the signature verified, a changed byte failed); `image.sh`, `arm64.sh`,
`syscalls.sh` and `check.sh` passed again; the compose stack (`compose.yml` + `compose.test.yml`, `GNOME_TLS_MODE=files`
with a throwaway CA, ports on 127.0.0.1) came up healthy with curl through Caddy: both health endpoints, two-origin
`/api/config`, HSTS, the 308 redirect, Caddy's strict CSP on its 502, `gnome-server health`, `admin get`, `user create`
and `db backup` through `docker compose exec`, no client address in Caddy's log and no secret in gnome's. Caddy's own
`431` for a head over 4 MB carries no CSP (Go's HTTP server writes it before any handler); browsers cannot send such a
head. The artifact installed as in route B in an unprivileged `ubuntu:24.04` container (no systemd): `config check`
in two-origin mode with the admin token from a file, `gnome-server` and HolyWisp started by hand, health answered.

Not run here: the stack end to end with real browsers through Caddy (rows DC1–DC9, DP1–DP6, OP1–OP2: the deploy suites
are not written), anything on Raspberry Pi hardware, the VPN override, systemd 252's `verify`, Debian/Ubuntu hosts
with real DNS and ACME, IPv6 client addresses through Docker's NAT, and every number marked estimate.
