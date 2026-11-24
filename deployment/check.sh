#!/usr/bin/env bash
# Static checks of the deployment files (WAVE-D §5.8). No network except pulling the pinned tool images; nothing is
# started except throwaway tool containers (--network none, --cap-drop ALL, read-only). Exit 0 = every check passed.
#
#   deployment/check.sh [--no-docker-tools]     # --no-docker-tools: skip caddy/shellcheck/hadolint/systemd 252
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
cd "$here"

CADDY_IMAGE=caddy:2.11-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
SHELLCHECK_IMAGE=koalaman/shellcheck:v0.10.0@sha256:2097951f02e735b613f4a34de20c40f937a6c8f18ecb170612c88c34517221fb
HADOLINT_IMAGE=hadolint/hadolint:v2.14.0@sha256:27086352fd5e1907ea2b934eb1023f217c5ae087992eb59fde121dce9c9ff21e

tools=1
[[ ${1:-} == --no-docker-tools ]] && tools=0
fail=0
pass() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }
run_tool() { docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --user 65532:65532 "$@"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Dummy values for the VPN override's required variables (never a real secret).
export WIREGUARD_ADDRESSES=10.66.0.1/32 GLUETUN_SERVER_CITIES=Check GLUETUN_API_KEY=check-only

echo "compose"
for set in "compose.yml" "compose.yml compose.vpn.yml" "compose.yml compose.test.yml"; do
  args=()
  for f in $set; do args+=(-f "$f"); done
  name=${set// /+}
  if docker compose --env-file .env.example "${args[@]}" config --format json > "$tmp/$name.json" 2> "$tmp/$name.err"; then
    pass "docker compose config: $set"
  else
    bad "docker compose config: $set: $(head -3 "$tmp/$name.err")"
  fi
done

node - "$tmp" <<'EOF' || fail=1
const fs = require('fs');
const dir = process.argv[2];
let failed = false;
const bad = (m) => { console.log(`  FAIL  ${m}`); failed = true; };
const ok = (m) => console.log(`  ok    ${m}`);
const allowedHostFiles = [/\/deployment\/Caddyfile$/, /\/deployment\/caddy\/tls-(acme|files)\.caddy$/, /\/deployment\/secrets(\/tls)?$/,
  /\/deployment\/vpn\/(egress\/[^/]+\.conf|profiles\.toml)$/, /\/deployment\/secrets\/wireguard_private_key$/];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const set = f.replace(/\.json$/, '');
  const cfg = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  const before = failed;
  for (const [name, s] of Object.entries(cfg.services)) {
    const where = `${set}: ${name}`;
    const gluetun = name === 'gluetun';
    if (s.ports?.length && name !== 'caddy') bad(`${where} publishes ports`);
    if (s.privileged) bad(`${where} is privileged`);
    if (s.network_mode === 'host' || s.pid === 'host' || s.ipc === 'host' || s.userns_mode === 'host' || s.cgroup === 'host') bad(`${where} shares a host namespace`);
    for (const v of s.volumes ?? []) {
      if (v.type !== 'bind') continue;
      if (/docker\.sock/.test(v.source)) bad(`${where} mounts docker.sock`);
      else if (!allowedHostFiles.some((r) => r.test(v.source))) bad(`${where} bind-mounts ${v.source}`);
      if (/shared/.test(v.bind?.propagation ?? '')) bad(`${where} uses shared mount propagation`);
    }
    if (s.cap_add?.length && !(gluetun && s.cap_add.length === 1 && s.cap_add[0] === 'NET_ADMIN')) bad(`${where} adds capabilities ${s.cap_add}`);
    if (!gluetun) {
      if (!s.read_only) bad(`${where} is not read_only`);
      if (!(s.cap_drop ?? []).includes('ALL')) bad(`${where} does not drop ALL capabilities`);
    }
    if (!(s.security_opt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(o))) bad(`${where} lacks no-new-privileges`);
    if ((s.security_opt ?? []).some((o) => /seccomp=unconfined|apparmor=unconfined|label=disable/.test(o))) bad(`${where} disables a security profile`);
    if (!s.mem_limit) bad(`${where} has no mem_limit`);
    if (!s.pids_limit) bad(`${where} has no pids_limit`);
    for (const d of s.devices ?? []) {
      const src = typeof d === 'string' ? d : d.source;
      if (!(gluetun && /^\/dev\/net\/tun/.test(src))) bad(`${where} has device ${src}`);
    }
    if (s.sysctls && Object.keys(s.sysctls).length) bad(`${where} sets sysctls`);
    for (const [k, v] of Object.entries(s.environment ?? {})) {
      if (/(_TOKEN|_CODE|_KEY)$/.test(k) && v) bad(`${where}: secret-like variable ${k} carries a value (use a _FILE variable)`);
      if (k === 'GNOME_ADMIN_BIND' && v && !/^(127\.|\[::1\]|localhost)/.test(v)) bad(`${where}: admin listener on ${v}`);
    }
  }
  if (failed === before) ok(`policy: ${set}`);
}
process.exit(failed ? 1 : 0);
EOF

echo "files"
for line in '**/.env*' '!**/.env.example' 'deployment/secrets/' '**/*.pem' '**/*.key' '**/secret.key' '**/*.db*' \
  '**/test-results/' '**/playwright-report/' 'target/' 'data/' 'release/' '.claude/' 'services/holywisp/build/' \
  '**/node_modules/' 'frontend/dist/'; do
  grep -qxF -- "$line" Dockerfile.dockerignore || bad "Dockerfile.dockerignore lacks $line"
done
pass "Dockerfile.dockerignore deny lines"
if [[ -d secrets ]]; then
  gid=$(sed -n 's/^GNOME_SECRETS_GID=//p' .env 2>/dev/null || true)
  [[ $(stat -c %a secrets) == 750 ]] || bad "secrets/ is $(stat -c %a secrets), want 750"
  while IFS= read -r f; do
    [[ $(stat -c %a "$f") == 640 ]] || bad "$f is $(stat -c %a "$f"), want 640"
    [[ -z $gid || $(stat -c %g "$f") == "$gid" ]] || bad "$f group $(stat -c %g "$f") != GNOME_SECRETS_GID $gid"
  done < <(find secrets -type f)
  pass "secrets/ modes"
fi
# Route B: gnome-server's loopback ports must not collide with Caddy's, and the unit's SocketBindAllow must list them.
port() { sed -n "s/^$1=.*:\([0-9]*\)$/\1/p" "$2"; }
app=$(port GNOME_BIND systemd/gnome.env.example) proxy=$(port GNOME_PROXY_BIND systemd/gnome.env.example)
ch=$(sed -n 's/^CADDY_HTTP_PORT=//p' systemd/route-b.env.example) cs=$(sed -n 's/^CADDY_HTTPS_PORT=//p' systemd/route-b.env.example)
for p in "$app" "$proxy"; do
  [[ $p != "$ch" && $p != "$cs" ]] || bad "route B: gnome-server port $p collides with Caddy's"
  grep -qx "SocketBindAllow=tcp:$p" systemd/gnome-server.service || bad "gnome-server.service: SocketBindAllow lacks tcp:$p"
done
grep -q "GNOME_APP_UPSTREAM=127.0.0.1:$app" systemd/route-b.env.example || bad "route-b.env.example does not point at GNOME_BIND"
pass "route B ports"
# HSTS on by default where the origins are https://.
grep -q '^GNOME_HSTS=true' .env.example || bad ".env.example: GNOME_HSTS is not true with https:// origins"
grep -q '^GNOME_HSTS=true' systemd/gnome.env.example || bad "gnome.env.example: GNOME_HSTS is not true with https:// origins"

echo "systemd"
root=$tmp/root
mkdir -p "$root/usr/local/bin" "$root/etc/systemd/system" "$root/etc/gnome"
printf '#!/bin/sh\n' > "$root/usr/local/bin/gnome-server"
cp "$root/usr/local/bin/gnome-server" "$root/usr/local/bin/holywisp"
chmod 755 "$root/usr/local/bin/"*
: > "$root/etc/gnome/gnome.env"
cp systemd/gnome-server.service "$repo/services/holywisp/holywisp.service" "$repo/services/holywisp/holywisp@.service" "$root/etc/systemd/system/"
if out=$(systemd-analyze verify --man=no --root="$root" "$root/etc/systemd/system/gnome-server.service" 2>&1) && [[ -z $out ]]; then
  pass "systemd-analyze verify ($(systemd-analyze --version | head -1 | cut -d' ' -f1-2))"
else
  bad "systemd-analyze verify: $out"
fi
score=$(systemd-analyze security --offline=true systemd/gnome-server.service 2>&1 | sed -n 's/.*exposure level for gnome-server.service: \([0-9.]*\).*/\1/p')
if [[ -n $score ]] && awk "BEGIN {exit !($score <= 2.0)}"; then pass "systemd-analyze security: $score"; else bad "systemd-analyze security: ${score:-?} (want <= 2.0)"; fi

if ((tools)); then
  echo "tools"
  for i in "$CADDY_IMAGE" "$SHELLCHECK_IMAGE" "$HADOLINT_IMAGE"; do
    docker image inspect "$i" > /dev/null 2>&1 || docker pull -q "$i" > /dev/null
  done
  for mode in acme files; do
    if out=$(run_tool -v "$here/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$here/caddy:/etc/caddy/inc:ro" \
      -e GNOME_APP_HOST=gnome.example.com -e GNOME_PROXY_HOST=p.gnome.example.com -e ACME_EMAIL=ops@example.com \
      -e GNOME_TLS_MODE="$mode" -e CADDY_BIND_MODE=loopback -e XDG_CONFIG_HOME=/tmp -e XDG_DATA_HOME=/tmp --tmpfs /tmp \
      --entrypoint sh "$CADDY_IMAGE" -c 'mkdir -p /tmp/e && cp /etc/caddy/inc/*.caddy /tmp/e/ && sed "s|/etc/caddy/|/tmp/e/|g" /etc/caddy/Caddyfile > /tmp/e/Caddyfile && caddy fmt /tmp/e/Caddyfile --diff >/dev/null && caddy adapt --config /tmp/e/Caddyfile --adapter caddyfile >/dev/null' 2>&1); then
      pass "caddy adapt + fmt ($mode)"
    else
      bad "caddy ($mode): $(echo "$out" | tail -2)"
    fi
  done
  mapfile -t scripts < <(cd "$repo" && ls deployment/*.sh deployment/tests/*.sh scripts/*.sh scripts/lib/*.sh 2>/dev/null)
  if run_tool -v "$repo:/mnt:ro" -w /mnt "$SHELLCHECK_IMAGE" -S warning "${scripts[@]}"; then pass "shellcheck (${#scripts[@]} scripts)"; else bad "shellcheck"; fi
  for df in deployment/Dockerfile deployment/caddy/Dockerfile; do
    # hadolint cannot parse RUN heredocs: their bodies are replaced by `true` (the shell inside is not linted here).
    awk '/<<.EOS.$/ {sub(/<<.EOS.$/, "true"); print; skip = 1; next} skip && /^EOS$/ {skip = 0; next} !skip' "$repo/$df" > "$tmp/Dockerfile.lint"
    if run_tool -i "$HADOLINT_IMAGE" hadolint --failure-threshold error - < "$tmp/Dockerfile.lint" > "$tmp/hadolint.txt" 2>&1; then
      pass "hadolint $df"
    else
      bad "hadolint $df: $(head -5 "$tmp/hadolint.txt")"
    fi
  done
fi

((fail)) && { echo "deployment/check.sh: FAILED"; exit 1; }
echo "deployment/check.sh: all checks passed"
