# GNOME start guide

How to start everything: **Part A** on this PC (CachyOS/Arch with the toolchain installed) and **Part B** on an
Ubuntu Server 24.04 LTS host. Run every command from the repository root unless a step says otherwise. The details
behind each step are in [README.md](README.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and
[backend/README.md](backend/README.md).

What was tested where (2026-11-24) is listed at the end of each part. In short: Part A was run as written, on other
ports. Part B was checked in an unprivileged `ubuntu:24.04` container and with the Docker stack on this PC. Real DNS,
ACME certificates and booting the systemd units were **not** tested here.

## Contents

- [Part A: this PC](#part-a-this-pc)
  - [A1. One-time setup](#a1-one-time-setup)
  - [A2. Dev mode with every feature](#a2-dev-mode-with-every-feature)
  - [A3. Frontend development with hot reload](#a3-frontend-development-with-hot-reload)
  - [A4. A local production run from the release artifact](#a4-a-local-production-run-from-the-release-artifact)
- [Part B: Ubuntu Server 24.04 LTS](#part-b-ubuntu-server-2404-lts)
  - [B1. Hostnames and DNS](#b1-hostnames-and-dns)
  - [B2. Firewall](#b2-firewall)
  - [B3. Option 1: the release artifact with systemd and Caddy](#b3-option-1-the-release-artifact-with-systemd-and-caddy)
  - [B4. Option 2: the Docker compose stack](#b4-option-2-the-docker-compose-stack)
  - [B5. After the install](#b5-after-the-install)
  - [B6. Updates, backups, logs, troubleshooting](#b6-updates-backups-logs-troubleshooting)

---

## Part A: this PC

Every command in Part A works in bash, zsh and fish (this PC's terminal runs fish). Run them from the
repository root, `~/gnome`, unless a step says otherwise.

### A1. One-time setup

You need Rust (1.89 or newer), a C compiler, Node 22.12 or newer with npm, and Docker with buildx (Docker is only
needed for images and releases). The HolyWisp binary must exist at `services/holywisp/build/x86_64/holywisp`. If it
is missing, build it once (needs Docker with buildx, git and the network):

```sh
services/holywisp/fetch-build.sh
```

Then build the web app and the server:

```sh
cd frontend && npm ci && npm run build && cd ..
cargo build --release -p gnome-server
```

### A2. Dev mode with every feature

This turns on everything at once, on loopback: games catalog (GamePix and the reviewed open-source games), filter
lists, a VPN profile demo (a second HolyWisp stands in for a VPN exit: no tunnel), accounts and sync, the access code
and the admin listener.

**Terminal 1: two HolyWisp instances and the data files.**

```sh
services/holywisp/build/x86_64/holywisp --config services/holywisp/gnome.conf &
services/holywisp/build/x86_64/holywisp --config services/holywisp/gnome.conf --port 6002 &

mkdir -p data
printf '%s\n' '[[profile]]
id = "test-exit"
label = "Test exit (no tunnel)"
country_code = "se"
country = "Sweden"
city = "Gothenburg"
wisp_upstream = "127.0.0.1:6002"' > data/profiles.toml
printf '[[list]]\nid = "plowe-0"\ndisabled = true\n' > data/lists.toml
```

**Terminal 2: gnome-server.**

```sh
export GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 GNOME_ADMIN_BIND=127.0.0.1:9091
export GNOME_ADMIN_TOKEN=replace-with-a-long-random-token
export GNOME_ACCESS_MODE=code GNOME_ACCESS_CODE=choose-a-long-code
export GNOME_ACCOUNTS=true GNOME_REGISTRATION=closed
export GNOME_VPN_PROFILES=$PWD/data/profiles.toml
export GNOME_FILTER_LISTS_FILE=$PWD/data/lists.toml
export GNOME_CATALOG_SOURCES=gamepix,oss GNOME_OSS_FETCH=auto GNOME_THUMB_PROXY=true
./target/release/gnome-server config check
echo 'a-long-password' | ./target/release/gnome-server user create alice --admin --password-stdin
./target/release/gnome-server serve
```

`user create` fails with "already exists" the second time; that is fine.

**Check it (terminal 3):**

```sh
curl -s http://127.0.0.1:8080/api/health                 # "status":"ok", wisp direct "up"
curl -s http://127.0.0.1:8080/api/vpn/locations          # test-exit, "up"
curl -s http://127.0.0.1:8080/api/games/status           # about a minute after start: listed > 0
curl -s -H "Authorization: Bearer replace-with-a-long-random-token" http://127.0.0.1:9091/admin/diagnostics | head -c 300; echo
```

**Use it.** Open **http://127.0.0.1:8080/** (use `127.0.0.1`, not `localhost`) and enter the access code. Then:

- `/browse`: type an address. The engine badge reads `SJ` (Scramjet).
- `/games`: the catalog. `/vpn`: Connect to "Test exit (no tunnel)".
- Settings → Account & sync: sign in as `alice`.
- http://127.0.0.1:9091/admin/: any user name, with the token as the password.

**Stop:** press Ctrl+C in terminal 2, then run `kill %1 %2` in terminal 1.

Optional extras: `GNOME_ALLOW_CUSTOM_WISP=true` (your own Wisp servers in Settings), `GNOME_ADS_TXT=<file>` (the
lines your game networks give you), `GNOME_VPN_CHECK_URL=<your check endpoint>` (exit checks). The README section
"Turning on every feature" lists everything.

### A3. Frontend development with hot reload

The app runs from Vite's dev server on `127.0.0.1:5173`. The engine host, `sw.js` and `vendor/` still come from
gnome-server's proxy listener, so the server must allow the dev origin. Use four terminals:

```sh
# terminal 1
services/holywisp/build/x86_64/holywisp --config services/holywisp/gnome.conf
# terminal 2
npm --prefix frontend run build && \
GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 GNOME_STATIC_DIR=frontend/dist GNOME_STATIC_RELOAD=true \
GNOME_PUBLIC_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:8080 cargo run -p gnome-server
# terminal 3
cd frontend && npm run dev:engine
# terminal 4: then open http://127.0.0.1:5173/
cd frontend && npm run dev
```

Tests: `cargo test --workspace --locked`, `cd frontend && npm run check && npm test`. The e2e runner is described in
[tests/e2e/engine/README.md](tests/e2e/engine/README.md).

### A4. A local production run from the release artifact

**1. Build the release.** This builds both architectures in Docker (about 15 minutes on a cold cache). It needs the
network, Docker with buildx and `~/.cache/gnome-tools/bin` on `PATH` for the audit:

```sh
PATH="$HOME/.cache/gnome-tools/bin:$PATH" scripts/release.sh --arch x86_64 --no-third-party-source --reuse-holywisp
ls release/        # gnome-0.1.0-linux-x86_64.tar.gz, gnome-0.1.0-src.tar.gz, SHA256SUMS
```

`--no-third-party-source` is for local use only. A release you publish needs the third-party source archive
(docs/DEPLOYMENT.md). Without `--sign` there is no `SHA256SUMS.sig`.

**2. Verify and unpack it** in a scratch directory:

```sh
cd ~/gnome/release && sha256sum -c --ignore-missing SHA256SUMS
mkdir -p /tmp/gnome-prod && cd /tmp/gnome-prod
tar -xzf ~/gnome/release/gnome-0.1.0-linux-x86_64.tar.gz && cd gnome-0.1.0-linux-x86_64
```

**3. Run it** (two terminals, from that directory):

```sh
# terminal 1
bin/holywisp --config etc/holywisp.conf
# terminal 2
GNOME_DATA_DIR=/tmp/gnome-prod/data GNOME_STATIC_DIR=$PWD/share/gnome/dist \
GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 bin/gnome-server serve
```

Check `bin/gnome-server health` and `curl -s http://127.0.0.1:8080/api/health`, then open http://127.0.0.1:8080/.
The artifact binaries are static (musl) and run on any x86_64 Linux.

**Or the image:** `scripts/release.sh --image` (or `docker buildx build -f deployment/Dockerfile --platform
linux/amd64 -t gnome-server:0.1.0 --load .`) builds `gnome-server:0.1.0`; the compose stack of B4 also runs on this
PC with `GNOME_TLS_MODE=files` and a certificate of your own.

**Tested on this PC (2026-11-24):** A1 (`npm ci`, both builds), A2 with every command as written but on other ports
(13xxx, because the usual ports are used by other things here), A4 from the artifact `release.sh` built that day. A3's
`npm run dev` was not re-run in this pass. Later that day every block was made to run in fish as well (fish has
no `<<` heredocs or `( … )` subshells): all of them pass `fish --no-execute`, and A2's terminal 1 ran in fish 4.9
on its usual ports, 6001 and 6002.

---

## Part B: Ubuntu Server 24.04 LTS

Pick **one** of the two install options in B3 and B4. Option 2 (Docker) is the simplest; option 1 (systemd) uses
less memory and gives every service the systemd hardening of `deployment/systemd/`. Both put Caddy in front, with
automatic HTTPS from Let's Encrypt.

### B1. Hostnames and DNS

GNOME needs **two hostnames** on the same host: the app (`gnome.example.com`) and the proxy origin
(`p.gnome.example.com`). Proxied pages run on the proxy origin, so they cannot read GNOME's own data.

At your DNS provider, create for both names an `A` record to the server's public IPv4 address (and an `AAAA` record
if it has IPv6). Wait until `dig +short gnome.example.com` and `dig +short p.gnome.example.com` answer with your
address before you start Caddy: ACME (the certificate request) fails until they do, and repeated failures hit
Let's Encrypt's rate limits.

### B2. Firewall

Only ports 22 (SSH), 80 and 443 are public. Everything else (HolyWisp's 6001, the admin listener 9091, gluetun's
control port) stays on loopback or inside Docker networks.

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Docker note: ports Docker publishes bypass `ufw`. The compose stack publishes only Caddy's 80 and 443, so this is
fine. Never add `ports:` to the gnome, HolyWisp or gluetun services.

### B3. Option 1: the release artifact with systemd and Caddy

**1. Get the artifact.** Copy `gnome-0.1.0-linux-x86_64.tar.gz` (or `-aarch64` for a Raspberry Pi 4 or another
arm64 host) and `SHA256SUMS` (plus `SHA256SUMS.sig` if signed) from the machine that built them (A4). Verify before
unpacking:

```sh
sha256sum -c --ignore-missing SHA256SUMS
# if signed: ssh-keygen -Y verify -f allowed_signers -I <maintainer> -n gnome-release -s SHA256SUMS.sig < SHA256SUMS
tar -xzf gnome-0.1.0-linux-x86_64.tar.gz && cd gnome-0.1.0-linux-x86_64
```

**2. Install the files** (as root):

```sh
sudo install -m 0755 bin/gnome-server bin/holywisp /usr/local/bin/
sudo mkdir -p /usr/local/share/gnome && sudo cp -r share/gnome/dist /usr/local/share/gnome/
sudo mkdir -p /usr/local/share/licenses/gnome && sudo cp -r share/licenses/. /usr/local/share/licenses/gnome/
sudo install -d -m 0755 /etc/gnome /etc/holywisp
sudo install -d -m 0700 /etc/gnome/credentials
sudo install -m 0600 etc/gnome.env.example /etc/gnome/gnome.env
sudo install -m 0644 etc/holywisp.conf /etc/holywisp/holywisp.conf
sudo cp etc/systemd/gnome-server.service etc/systemd/holywisp.service /etc/systemd/system/
```

**3. Configure.** Edit `/etc/gnome/gnome.env`: set `GNOME_PUBLIC_ORIGINS=https://gnome.example.com` and
`GNOME_PROXY_ORIGIN=https://p.gnome.example.com` to your names. Put no secrets in this file.

**4. Secrets as files (`_FILE`).** Secrets go into `/etc/gnome/credentials/` and reach the server as systemd
credentials, through `GNOME_ADMIN_TOKEN_FILE`, `GNOME_ACCESS_CODE_FILE` and `GNOME_SECRET_KEY_FILE`. The admin token
is required: without it, any local user passes the admin listener's loopback check.

```sh
sudo sh -c 'umask 077; head -c 36 /dev/urandom | base64 > /etc/gnome/credentials/admin_token'
sudo mkdir -p /etc/systemd/system/gnome-server.service.d
sudo cp etc/systemd/gnome-server.service.d/credentials.conf.example \
        /etc/systemd/system/gnome-server.service.d/credentials.conf
```

For an access code (B5), write `/etc/gnome/credentials/access_code` the same way and uncomment its two lines in
`credentials.conf`. The server never logs a secret; `config check` shows `<redacted> (from file …)`.

**5. Start gnome-server and HolyWisp:**

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now holywisp gnome-server
systemctl status gnome-server holywisp --no-pager
curl -s http://127.0.0.1:6001/health          # HolyWisp
curl -s http://127.0.0.1:8080/api/health      # gnome-server
```

**6. Caddy in front** (Ubuntu's own `caddy` package is version 2.6 and too old for this Caddyfile; install Caddy
2.11 from Caddy's apt repository, https://caddyserver.com/docs/install#debian-ubuntu-raspbian):

```sh
sudo cp etc/Caddyfile /etc/caddy/Caddyfile
sudo cp etc/caddy/*.caddy /etc/caddy/
sudo install -m 0644 etc/route-b.env.example /etc/caddy/gnome.env   # then edit the hostnames and ACME_EMAIL
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/caddy/gnome.env\n' | sudo tee /etc/systemd/system/caddy.service.d/gnome.conf
sudo systemctl daemon-reload && sudo systemctl restart caddy
curl -sI https://gnome.example.com/ | head -3
```

### B4. Option 2: the Docker compose stack

Install Docker Engine with the compose and buildx plugins from Docker's apt repository
(https://docs.docker.com/engine/install/ubuntu/). Ubuntu's `docker.io` package lacks buildx. Then:

```sh
git clone <your GNOME repository> gnome && cd gnome
cp deployment/.env.example deployment/.env
nano deployment/.env                        # GNOME_APP_HOST, GNOME_PROXY_HOST, ACME_EMAIL
deployment/init-secrets.sh --admin-token    # writes deployment/secrets/ (never prints the token)
```

Run `init-secrets.sh` **before** the first `docker compose up`. Otherwise Docker creates `deployment/secrets/`
owned by root. It writes random values that are never printed, and it sets `GNOME_ADMIN_TOKEN_FILE` (and the other
`_FILE` variables for the secrets it made) in `.env`. Add `--access-code` for code mode and `--secret-key` for a
secret key of your own.

```sh
docker compose -f deployment/compose.yml up -d --build     # first build ≈ 6–10 min
docker compose -f deployment/compose.yml ps                # gnome "healthy", then caddy starts
docker compose -f deployment/compose.yml exec gnome gnome-server health
curl -s https://p.gnome.example.com/api/health
```

What runs: Caddy (the only service with published ports, 80 and 443), gnome-server (FROM scratch, user 65532,
read-only, no capabilities) and HolyWisp on its own network. If you have a certificate of your own, use it instead
of ACME: `deployment/init-secrets.sh --tls-cert fullchain.pem --tls-key key.pem` and `GNOME_TLS_MODE=files`.

### B5. After the install

In the commands below, `gs` stands for the way you run the gnome-server CLI:

- **Docker:** `docker compose -f deployment/compose.yml exec -T gnome gnome-server`
- **systemd** (runs as the service's dynamic user, with its data directory and environment):
  `sudo systemd-run --wait --pipe --collect -p DynamicUser=yes -p User=gnome-server -p StateDirectory=gnome -p EnvironmentFile=/etc/gnome/gnome.env -E GNOME_DATA_DIR=/var/lib/gnome /usr/local/bin/gnome-server`

**The first admin user.** Accounts are on by default, and registration is closed:

```sh
echo 'a-long-password' | gs user create alice --admin --password-stdin
```

Sign in at `https://gnome.example.com/` → Settings → Account & sync. The admin pages live on the admin listener,
which is loopback only. Reach it through an SSH tunnel and open http://127.0.0.1:9091/admin/ (any user name, the
token as the password):

```sh
ssh -L 9091:127.0.0.1:9091 you@server
```

For the Docker stack, use `gs admin get /admin/diagnostics` instead.

**Access modes** (`GNOME_ACCESS_MODE` in `gnome.env` or `.env`):

- `open`: anyone who knows the address.
- `code`: visitors enter a shared code. Put it in a file and set `GNOME_ACCESS_CODE_FILE`: on Docker,
  `deployment/init-secrets.sh --access-code` (read the code to share with `cat deployment/secrets/access_code`);
  on systemd, as in B3 step 4.
- `accounts`: signed-in users only. Create the users with `user create`, or set `GNOME_REGISTRATION=open` (the
  server then warns: anyone can sign up).

Restart after a change: `sudo systemctl restart gnome-server`, or `docker compose -f deployment/compose.yml up -d`.

**Games.** The catalog imports by itself: GamePix 30 s after start and then daily, and the reviewed open-source
games are fetched from GitHub. To run either now:

```sh
gs catalog import
gs catalog fetch-oss
gs catalog stats
```

Other game networks need your own publisher IDs (README, "Games catalog").

**Filter lists** (ad and tracker blocking) refresh by themselves every 24 h. To check upstream now, run
`gs filters refresh`. To add or disable lists, use a TOML file named by `GNOME_FILTER_LISTS_FILE` (README,
"Filter lists").

**Optional: VPN locations.** **Read [services/vpn/README.md](services/vpn/README.md) first.** Use only your own VPN
account, and follow your provider's terms: most consumer VPN subscriptions are for personal or household use and do
not allow sharing an exit with other people. GNOME is not affiliated with any VPN provider. The integrated way is the
compose override (gluetun plus one HolyWisp per exit). It is the stack's only service with `NET_ADMIN` and never
privileged:

```sh
docker compose -f deployment/compose.yml -f deployment/compose.vpn.yml up -d
```

The override has only been checked statically (`docker compose config`). No real tunnel was started in GNOME's tests.

### B6. Updates, backups, logs, troubleshooting

**Backups.** The database and the secret key are what matter:

```sh
gs db backup /var/lib/gnome/backup-$(date +%F).db        # VACUUM INTO + integrity check; the target must not exist
docker compose -f deployment/compose.yml cp gnome:/var/lib/gnome/backup-$(date +%F).db .   # Docker: copy it out
```

On systemd, the file is in `/var/lib/private/gnome/`. Back up the `caddy-data` volume (or `/var/lib/caddy`) as well:
it holds the ACME account and the certificates. To restore: stop gnome-server, move `gnome.db*` aside, copy the
backup to `gnome.db`, start it again.

**Updates.** Back up first. Then:

- **Artifact:** install the new files as in B3 step 2, run `gnome-server config check`, then
  `sudo systemctl restart holywisp gnome-server`.
- **Docker:** `git pull && docker compose -f deployment/compose.yml up -d --build`.

Migrations run forward at start. A downgrade is refused and needs the backup.

**Logs.** Logs are JSON, with no IP addresses or query strings unless you set `GNOME_LOG_IPS=true`:

- `journalctl -u gnome-server -u holywisp -u caddy -f`
- `docker compose -f deployment/compose.yml logs -f gnome caddy holywisp`

**Troubleshooting.**

| Symptom | Check |
| --- | --- |
| The unit stops at once | `sudo /usr/local/bin/gnome-server config check` with the same environment (`set -a; . /etc/gnome/gnome.env`); exit status 2 = bad configuration, and the message names the variable |
| Caddy has no certificate | `dig` both names; ports 80/443 open (`ufw status`); `journalctl -u caddy` or `docker compose logs caddy` |
| Pages open but nothing loads in `/browse` | `curl -s https://gnome.example.com/api/health` should show `"wisp":{"direct":"up"}`; otherwise HolyWisp is down |
| "proxy isolation: off" warning | `GNOME_PROXY_ORIGIN` is missing or the same as the app origin |
| `503` with `Retry-After: 1` under load | the connection or in-flight caps (`GNOME_MAX_CONNECTIONS`, `GNOME_MAX_INFLIGHT_PER_IP`); see `gs admin get /admin/diagnostics` → `connections` |
| `413 quota_exceeded` on sync | the account reached `GNOME_SYNC_QUOTA_MB` (or the server reached `GNOME_SYNC_TOTAL_MB`) |
| `deployment/secrets` is owned by root | `docker compose` ran before `init-secrets.sh`: `sudo rm -r deployment/secrets` and run `init-secrets.sh` again |

**What was tested for Part B, and what was not (2026-11-24).** These were checked in an unprivileged `ubuntu:24.04`
container (`--cap-drop ALL`, no systemd): the artifact verified and unpacked, the files installed as in B3 step 2,
`config check` with the production `gnome.env`, gnome-server and HolyWisp started by hand, and both health endpoints
answered. The compose stack (B4) was run on this PC with `GNOME_TLS_MODE=files` and a throwaway certificate, on high
ports. **Not tested:** real DNS, ACME with Let's Encrypt, `ufw`, Caddy from Caddy's apt repository, booting the
systemd units (they passed `systemd-analyze verify` and `security` only), the `systemd-run` form of `gs`, the VPN
override with a real tunnel, and arm64 hardware (the aarch64 binaries ran only under QEMU user-mode).
