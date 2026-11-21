#!/usr/bin/env bash
# smoke.sh: black-box checks of a HolyWisp build with GNOME's config (gnome.conf and the
# vpn-egress overlay). HolyWisp and holywisp-client only ever run in containers (read-only root, no
# capabilities, UID 65534) that share the host's network namespace, so the servers listen on the
# host's 127.0.0.1 exactly like a gateway-side deployment. Run services/holywisp/fetch-build.sh first.
#
#   tests/smoke.sh [--arch ARCH] [--port PORT] [--image TAG] [--offline]
#
# Ports PORT .. PORT+4 on 127.0.0.1 must be free. Checks that need the internet (example.org,
# 1.1.1.1 as DNS, nip.io) are skipped with --offline. Exit status: 0 when every check passed.
# shellcheck disable=SC2015  # pass/fail/skip always return 0: `cond && pass .. || fail ..` is an if/else
set -euo pipefail
shopt -s lastpipe # `producer | wisp ...` must set W_* in this shell

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
PROG=smoke.sh
die() {
  printf '%s: error: %s\n' "$PROG" "$*" >&2
  exit 1
}

ARCH=$(uname -m)
PORT=16101
IMAGE=""
ONLINE=1
while (($#)); do
  case $1 in
  --arch) ARCH=${2:?--arch needs a value}; shift 2 ;;
  --port) PORT=${2:?--port needs a value}; shift 2 ;;
  --image) IMAGE=${2:?--image needs a tag}; shift 2 ;;
  --offline) ONLINE=0; shift ;;
  -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
  *) die "unknown argument $1 (see --help)" ;;
  esac
done
case $ARCH in amd64) ARCH=x86_64 ;; arm64) ARCH=aarch64 ;; esac
[[ $ARCH == "$(uname -m)" ]] || die "can only run $(uname -m) binaries here, not $ARCH"
[[ $PORT =~ ^[0-9]+$ ]] && ((PORT >= 1024 && PORT <= 65530)) || die "--port must be 1024..65530"

BIN=$HERE/build/$ARCH
[[ -x $BIN/holywisp && -x $BIN/holywisp-client ]] || die "no binaries in $BIN; run fetch-build.sh first"
ALPINE_IMAGE=$(sed -n 's/^ARG ALPINE_IMAGE=//p' "$HERE/Dockerfile" | head -n 1)
[[ -n $ALPINE_IMAGE ]] || die "ARG ALPINE_IMAGE not found in Dockerfile"
command -v docker >/dev/null || die "docker is required"

P_MAIN=$PORT P_DNS=$((PORT + 1)) P_EGRESS=$((PORT + 2)) P_SOCKS=$((PORT + 3)) P_SPARE=$((PORT + 4))
port_in_use() {
  if command -v ss >/dev/null; then
    [[ -n $(ss -ltnH "sport = :$1") ]]
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}
for p in "$P_MAIN" "$P_DNS" "$P_EGRESS" "$P_SOCKS" "$P_SPARE"; do
  # A HolyWisp started by the same UID would silently share the port (SO_REUSEPORT) and answer
  # part of the checks, so refuse to run next to anything.
  ! port_in_use "$p" || die "port $p is already in use; pick another --port"
done

NAME=gnome-hw-smoke-$$
TMP=$(mktemp -d "${TMPDIR:-/tmp}/gnome-hw-smoke.XXXXXX")
chmod 0755 "$TMP"
CONTAINERS=()
STUB_PID=""
cleanup() {
  local c
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  [[ -z $STUB_PID ]] || kill "$STUB_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

PASSES=0 FAILS=0 SKIPS=0
pass() { PASSES=$((PASSES + 1)); printf '  PASS  %s\n' "$*"; return 0; }
fail() { FAILS=$((FAILS + 1)); printf '  FAIL  %s\n' "$*"; return 0; }
skip() { SKIPS=$((SKIPS + 1)); printf '  SKIP  %s\n' "$*"; return 0; }
info() { printf '  INFO  %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

# Names that resolve, through the server container's /etc/hosts, to addresses nobody may reach.
cat >"$TMP/hosts" <<'EOF'
127.0.0.1 localhost
::1 localhost ip6-localhost
127.0.0.2 loopback.hw-smoke.test
::1 loopback6.hw-smoke.test
10.1.2.3 rfc1918-10.hw-smoke.test
172.20.1.1 rfc1918-172.hw-smoke.test
192.168.0.10 rfc1918-192.hw-smoke.test
100.64.1.1 cgnat.hw-smoke.test
169.254.169.254 metadata.google.internal metadata.hw-smoke.test
169.254.10.10 linklocal.hw-smoke.test
fd12:3456::1 ula.hw-smoke.test
fe80::1234 linklocal6.hw-smoke.test
EOF
chmod 0644 "$TMP/hosts"
cp "$HERE/gnome.conf" "$TMP/gnome.conf"
chmod 0644 "$TMP/gnome.conf"

LOCKDOWN=(--network host --read-only --cap-drop ALL --security-opt no-new-privileges --ulimit nofile=65536:65536)

# start_server NAME UID [docker options --] [holywisp args...]: HolyWisp with gnome.conf (+ args).
start_server() {
  local name=$1 uid=$2
  shift 2
  local dopts=()
  while (($#)) && [[ $1 != -- ]]; do dopts+=("$1"); shift; done
  [[ ${1-} == -- ]] && shift
  CONTAINERS+=("$name")
  if [[ -n $IMAGE ]]; then
    docker run -d --name "$name" "${LOCKDOWN[@]}" --user "$uid:$uid" \
      -v "$TMP/hosts:/etc/hosts:ro" "${dopts[@]}" "$IMAGE" "$@" >/dev/null
  else
    docker run -d --name "$name" "${LOCKDOWN[@]}" --user "$uid:$uid" \
      -v "$TMP/hosts:/etc/hosts:ro" -v "$BIN:/opt/holywisp:ro" \
      -v "$TMP/gnome.conf:/etc/holywisp/holywisp.conf:ro" "${dopts[@]}" \
      --entrypoint /opt/holywisp/holywisp "$ALPINE_IMAGE" \
      --config /etc/holywisp/holywisp.conf "$@" >/dev/null
  fi
}
CLIENT=$NAME-client
http_get() { docker exec "$CLIENT" wget -q -T 5 -O - "http://127.0.0.1:$1$2" 2>&1 || true; }
wait_ready() { # port container
  for _ in $(seq 1 50); do
    [[ $(http_get "$1" /health) == '{"status":"ok"}' ]] && return 0
    [[ $(docker inspect -f '{{.State.Running}}' "$2" 2>/dev/null) == true ]] || break
    sleep 0.1
  done
  docker logs "$2" 2>&1 | tail -n 5 >&2
  return 1
}

# wisp PORT CLIENT-ARGS...: run holywisp-client against ws://127.0.0.1:PORT/wisp/ with stdin passed
# through; sets W_RC, W_OUT (stdout), W_ERR (stderr, with -v events). The client gives up W_IDLE_MS
# after stdin EOF if nothing arrives (exit 0, no CLOSE). That timer starts before the remote has even
# been resolved or connected, so it is generous; a CLOSE (refusal or remote EOF) ends the client at once.
W_IDLE_MS=15000
wisp() {
  local port=$1
  shift
  set +e
  timeout 40 docker exec -i "$CLIENT" /opt/holywisp/holywisp-client -v --idle-ms "$W_IDLE_MS" \
    -s "ws://127.0.0.1:$port/wisp/" "$@" >"$TMP/w.out" 2>"$TMP/w.err"
  W_RC=$?
  set -e
  W_OUT=$(tr -d '\0' <"$TMP/w.out")
  W_ERR=$(cat "$TMP/w.err")
}
http_request() { printf 'GET / HTTP/1.0\r\nHost: %s\r\nUser-Agent: gnome-holywisp-smoke\r\n\r\n' "$1"; }
close_of() { grep -o 'CLOSE [^(]*(0x[0-9a-f]*)' <<<"$W_ERR" | tail -n 1 || true; }

# expect_http LABEL PORT HOST DPORT [client options]: the relay returns an HTTP status line.
expect_http() {
  local label=$1 port=$2 host=$3 dport=$4 status
  shift 4
  http_request "$host" | wisp "$port" "$@" "$host" "$dport"
  status=$(head -n 1 <<<"$W_OUT" | tr -d '\r')
  if [[ $W_RC == 0 && $status =~ ^HTTP/1\.[01]\ [1-5][0-9][0-9] ]]; then
    pass "$label -> $status"
  else
    fail "$label -> rc=$W_RC status='$status' $(close_of) $(tail -n 1 <<<"$W_ERR")"
  fi
}
# expect_refused LABEL CODES PORT HOST DPORT [client options]: the stream is closed with one of the
# Wisp reasons in CODES ("0x48" blocked, "0x48|0x42" ...) and no byte is relayed.
expect_refused() {
  local label=$1 codes=$2 port=$3 host=$4 dport=$5 got
  shift 5
  wisp "$port" "$@" "$host" "$dport" </dev/null
  got=$(close_of)
  if [[ $W_RC != 0 && -z $W_OUT && $got =~ \((${codes})\)$ ]]; then
    pass "$label -> refused, $got"
  else
    fail "$label -> rc=$W_RC ${got:-no CLOSE} (expected $codes) out=${#W_OUT}B $(tail -n 1 <<<"$W_ERR")"
  fi
}
expect_blocked() { # LABEL PORT HOST DPORT [client options]: Wisp CLOSE 0x48 (blocked)
  local label=$1
  shift
  expect_refused "$label" 0x48 "$@"
}
log_has() { docker logs "$1" 2>&1 | grep -qF -- "$2"; }

# A Wisp v1 TCP CONNECT for stream 1 inside one masked WebSocket frame (mask key 0).
wisp_connect_frame() {
  local host=$1 port=$2 len
  len=$((1 + 4 + 1 + 2 + ${#host}))
  # FIN+binary, MASK|len, mask key 0 | CONNECT, stream 1 (LE), TCP, port (LE), hostname
  printf '%b' "\\x82\\x$(printf %02x $((0x80 | len)))\\x00\\x00\\x00\\x00"
  printf '%b' '\x01\x01\x00\x00\x00\x01'
  printf '%b' "\\x$(printf %02x $((port & 255)))\\x$(printf %02x $((port >> 8)))"
  printf '%s' "$host"
}
# raw_upgrade PORT HEADER-LINES HOST DPORT: a hand-made upgrade (like the gateway's) plus a CONNECT.
raw_upgrade() {
  {
    printf 'GET /wisp/ HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' "$1"
    printf 'Sec-WebSocket-Key: c21va2UtdGVzdC1rZXktMQ==\r\nSec-WebSocket-Version: 13\r\n%s\r\n' "$2"
    sleep 0.3
    wisp_connect_frame "$3" "$4"
    sleep 1
  } | timeout 10 docker exec -i "$CLIENT" nc -w 2 127.0.0.1 "$1" >"$TMP/raw.out" 2>&1 || true
}

printf 'HolyWisp smoke test: %s, %s, ports %s-%s\n' "${IMAGE:-$BIN}" "$(cat "$BIN/BUILDINFO" | sed -n 's/^version: *//p')" "$P_MAIN" "$P_SPARE"

CONTAINERS+=("$CLIENT")
docker run -d --name "$CLIENT" "${LOCKDOWN[@]}" --user 65534:65534 -v "$BIN:/opt/holywisp:ro" \
  --entrypoint sleep "$ALPINE_IMAGE" 900 >/dev/null

# ------------------------------------------------------------------------------- main instance
section "gnome.conf on 127.0.0.1:$P_MAIN (CLI: --port, and --log-level info for evidence)"
MAIN=$NAME-main
start_server "$MAIN" 65534 -- --port "$P_MAIN" --log-level info
wait_ready "$P_MAIN" "$MAIN" || die "server did not become ready"
# The listen line ends with ", reputation on" only when reputation is enabled.
listen_line=$(docker logs "$MAIN" 2>&1 | grep -o 'listening on .*' | head -n 1 || true)
if [[ $listen_line == "listening on 127.0.0.1:$P_MAIN with "* && $listen_line != *reputation* ]]; then
  pass "starts: $listen_line (reputation off)"
else
  fail "startup log: $(docker logs "$MAIN" 2>&1 | tail -n 3)"
fi
[[ $(http_get "$P_MAIN" /health) == '{"status":"ok"}' ]] && pass "GET /health -> {\"status\":\"ok\"}" || fail "GET /health"
out=$(http_get "$P_MAIN" /)
[[ $out == *426* ]] && pass "GET / (plain HTTP) -> 426, no web client, no banner" || fail "GET / -> $out"
out=$(http_get "$P_MAIN" /wisp/)
[[ $out == *426* ]] && pass "GET /wisp/ without upgrade -> 426" || fail "GET /wisp/ -> $out"

section "relay"
if ((ONLINE)); then
  expect_http "example.org:80 over Wisp v1" "$P_MAIN" example.org 80
  [[ $W_OUT == "HTTP/1.1 200"* ]] || fail "example.org:80 status is not 200"
  expect_http "example.org:80 over Wisp v2 (+stream confirm)" "$P_MAIN" example.org 80 --v2 --confirm
  [[ $W_OUT == "HTTP/1.1 200"* ]] || fail "example.org:80 (v2) status is not 200"
  expect_http "public IP literal 1.1.1.1:80 (allow-direct-ip = on)" "$P_MAIN" 1.1.1.1 80
else
  skip "relay to example.org and 1.1.1.1 (--offline)"
fi

section "refused by literal: loopback, RFC 1918, CGNAT, link-local, metadata, reserved"
for target in 127.0.0.1:80 "127.0.0.1:$P_MAIN" 0x7f000001:80 0.0.0.0:80 \
  10.0.0.1:80 172.16.0.1:80 192.168.1.1:80 100.64.0.1:80 \
  169.254.169.254:80 169.254.0.1:80 224.0.0.1:80 255.255.255.255:80 192.0.2.1:80 240.0.0.1:80; do
  expect_blocked "$target" "$P_MAIN" "${target%:*}" "${target##*:}"
done
# Shorthand and integer IPv4 forms are rejected as malformed literals (0x41) before any lookup.
for target in 127.1:80 2130706433:80 017700000001:80; do
  expect_refused "$target" 0x41 "$P_MAIN" "${target%:*}" "${target##*:}"
done
for target in ::1 '[::1]' fd00::1 fe80::1 ::ffff:127.0.0.1 ::ffff:10.0.0.1 ::ffff:169.254.169.254 \
  64:ff9b::a9fe:a9fe 64:ff9b::101:101 ::; do
  expect_blocked "[$target]:80" "$P_MAIN" "$target" 80
done

section "refused by hostname (resolved by HolyWisp, then checked)"
for host in localhost loopback.hw-smoke.test loopback6.hw-smoke.test rfc1918-10.hw-smoke.test \
  rfc1918-172.hw-smoke.test rfc1918-192.hw-smoke.test cgnat.hw-smoke.test metadata.google.internal \
  linklocal.hw-smoke.test ula.hw-smoke.test linklocal6.hw-smoke.test; do
  expect_blocked "$host:80" "$P_MAIN" "$host" 80
done
log_has "$MAIN" "blocked metadata.google.internal:80 (link-local)" &&
  pass "log names the class: blocked metadata.google.internal:80 (link-local)" ||
  fail "no 'blocked metadata.google.internal:80 (link-local)' log line"
if ((ONLINE)); then
  # Through the host's resolver: refused either by HolyWisp (0x48) or because the resolver drops
  # private answers (0x42, DNS-rebind protection on many routers).
  for host in 127.0.0.1.nip.io 10.0.0.1.nip.io 169.254.169.254.nip.io; do
    expect_refused "$host:80 (system resolver)" "0x48|0x42" "$P_MAIN" "$host" 80
  done
fi

section "refused ports and stream types"
# Ports are matched before DNS and before any connect, so these need no network.
for dport in 25 22 6667; do expect_blocked "example.org:$dport (Fetch bad port)" "$P_MAIN" example.org "$dport"; done
expect_blocked "UDP 1.1.1.1:53 (allow-udp = off)" "$P_MAIN" 1.1.1.1 53 --udp

section "client IP from the gateway (trusted-proxy 127.0.0.1/32, X-Forwarded-For only)"
raw_upgrade "$P_MAIN" $'X-Forwarded-For: 203.0.113.9\r\n' localhost 81
head -c 12 "$TMP/raw.out" | grep -q 'HTTP/1.1 101' && pass "hand-made gateway upgrade -> 101" || fail "upgrade: $(head -c 80 "$TMP/raw.out")"
log_has "$MAIN" "egress: 203.0.113.9: blocked localhost:81" && pass "X-Forwarded-For: 203.0.113.9 -> policy IP 203.0.113.9" || fail "X-Forwarded-For not honoured"
raw_upgrade "$P_MAIN" $'CF-Connecting-IP: 198.51.100.66\r\nX-Forwarded-For: 203.0.113.10\r\n' localhost 82
log_has "$MAIN" "egress: 203.0.113.10: blocked localhost:82" && pass "CF-Connecting-IP ignored, X-Forwarded-For used" || fail "CF-Connecting-IP + XFF"
raw_upgrade "$P_MAIN" $'CF-Connecting-IP: 198.51.100.67\r\n' localhost 83
log_has "$MAIN" "egress: 127.0.0.1: blocked localhost:83" && pass "CF-Connecting-IP alone -> peer 127.0.0.1 (not spoofable)" || fail "CF-Connecting-IP alone was trusted"
raw_upgrade "$P_MAIN" $'X-Forwarded-For: 203.0.113.11, 127.0.0.1\r\n' localhost 84
log_has "$MAIN" "egress: 203.0.113.11: blocked localhost:84" && pass "XFF list: right-most untrusted address used" || fail "XFF list"

stats=$(http_get "$P_MAIN" /stats)
egress=$(grep -o '"egress":[0-9]*' <<<"$stats" | cut -d: -f2)
filter=$(grep -o '"filter":[0-9]*' <<<"$stats" | cut -d: -f2)
[[ -n $egress && $egress -gt 0 && -n $filter && $filter -ge 3 ]] &&
  pass "GET /stats counts the refusals (blocked.egress=$egress, blocked.filter=$filter)" || fail "/stats: $stats"

# -------------------------------------------------------------------- built-in DNS resolver
section "hostnames resolved by HolyWisp's built-in DNS client (--dns-server 1.1.1.1)"
if ((ONLINE)); then
  DNSI=$NAME-dns
  start_server "$DNSI" 65534 -- --port "$P_DNS" --dns-server 1.1.1.1
  wait_ready "$P_DNS" "$DNSI" || die "dns instance did not become ready"
  expect_http "example.org:80" "$P_DNS" example.org 80
  for host in 127.0.0.1.nip.io 10.0.0.1.nip.io 192.168.1.1.nip.io 169.254.169.254.nip.io localtest.me; do
    expect_blocked "$host:80 (public DNS answer is private)" "$P_DNS" "$host" 80
  done
else
  skip "public DNS checks (--offline)"
fi

# ---------------------------------------------------------------------------- VPN egress overlay
section "vpn-egress.conf.example as an overlay (proxy = a local SOCKS5 stub, stands in for the relay)"
if docker run --rm "${LOCKDOWN[@]}" --user 65534:65534 -v "$BIN:/opt/holywisp:ro" \
  -v "$TMP/gnome.conf:/etc/holywisp/holywisp.conf:ro" \
  -v "$HERE/vpn-egress.conf.example:/etc/holywisp/egress.conf:ro" \
  --entrypoint /opt/holywisp/holywisp "$ALPINE_IMAGE" \
  --config /etc/holywisp/holywisp.conf --config /etc/holywisp/egress.conf >"$TMP/unfilled.log" 2>&1; then
  fail "the unfilled example started"
else
  pass "unfilled example refuses to start: $(grep -m1 -oE "(bad value|unknown|cannot).*" "$TMP/unfilled.log" || tail -n 1 "$TMP/unfilled.log")"
fi
# check-egress.sh (holywisp@.service's ExecStartPre): HolyWisp itself starts with a malformed or
# missing dns-server and then resolves through the host, so the overlay must be refused before.
fill_example() {
  sed -e 's|^port = <port>|port = 6002|' -e 's|^proxy = socks5://<relay ip>:1080|proxy = socks5://10.124.1.240:1080|' \
    -e 's|^dns-server = <dns ip>|dns-server = 10.64.0.1|' -e 's|^trusted-proxy = <gateway ip>|trusted-proxy = 127.0.0.1/32|' \
    "$HERE/vpn-egress.conf.example"
}
check_egress() { # LABEL EXPECT(ok|refused) FILE
  local out
  if out=$("$HERE/check-egress.sh" "$3" 2>&1); then
    [[ $2 == ok ]] && pass "check-egress accepts $1" || fail "check-egress accepted $1"
  else
    out=${out%%$'\n'*}
    [[ $2 == refused ]] && pass "check-egress refuses $1: ${out#"$3": }" || fail "check-egress refused $1: $out"
  fi
}
fill_example >"$TMP/ce-ok.conf"
check_egress "the filled-in example" ok "$TMP/ce-ok.conf"
check_egress "the unfilled example" refused "$HERE/vpn-egress.conf.example"
fill_example | sed 's|^dns-server = .*|dns-server = fd00::1|' >"$TMP/ce-v6.conf"
check_egress "a bare IPv6 dns-server (HolyWisp would ignore it)" refused "$TMP/ce-v6.conf"
fill_example | sed '/^dns-server = /d' >"$TMP/ce-nodns.conf"
check_egress "an overlay without dns-server" refused "$TMP/ce-nodns.conf"
fill_example | sed 's|^proxy = .*|proxy = socks5://relay.example.net:1080|' >"$TMP/ce-host.conf"
check_egress "a proxy given as a hostname" refused "$TMP/ce-host.conf"
{ fill_example; echo 'allow-private = on'; } >"$TMP/ce-private.conf"
check_egress "an overlay that turns allow-private on" refused "$TMP/ce-private.conf"
if ((ONLINE)) && command -v python3 >/dev/null; then
  sed -e "s|^port = <port>|port = $P_EGRESS|" \
    -e "s|^proxy = socks5://<relay ip>:1080|proxy = socks5://127.0.0.1:$P_SOCKS|" \
    -e "s|^dns-server = <dns ip>|dns-server = 1.1.1.1|" \
    -e "s|^trusted-proxy = <gateway ip>|trusted-proxy = 127.0.0.1/32|" \
    "$HERE/vpn-egress.conf.example" >"$TMP/egress.conf"
  chmod 0644 "$TMP/egress.conf"
  ! grep -Eq '^[^#]*<[a-z ]+>' "$TMP/egress.conf" || die "placeholder substitution missed a line"
  check_egress "the overlay used below" ok "$TMP/egress.conf"
  : >"$TMP/socks.log"
  python3 -I "$HERE/tests/socks5_stub.py" --port "$P_SOCKS" --log "$TMP/socks.log" \
    --allow-host example.org --max-seconds 600 &
  STUB_PID=$!
  for _ in $(seq 1 50); do port_in_use "$P_SOCKS" && break; sleep 0.1; done
  EGR=$NAME-egress
  start_server "$EGR" 65534 -v "$TMP/egress.conf:/etc/holywisp/egress.conf:ro" -- \
    --config /etc/holywisp/egress.conf --log-level info
  wait_ready "$P_EGRESS" "$EGR" || die "egress instance did not become ready"
  log_has "$EGR" "listening on 127.0.0.1:$P_EGRESS with 2 workers" && pass "overlay applied: port $P_EGRESS, 2 workers" || fail "overlay not applied"
  expect_http "example.org:80 through the upstream proxy" "$P_EGRESS" example.org 80
  grep -q '"atyp": 3, "cmd": 1, "host": "example.org", "port": 80' "$TMP/socks.log" &&
    pass "the proxy received CONNECT example.org:80 as a hostname (ATYP 3)" || fail "proxy log: $(cat "$TMP/socks.log")"
  expect_blocked "10.64.0.1:80 (tunnel-internal literal) via egress instance" "$P_EGRESS" 10.64.0.1 80
  expect_blocked "10.0.0.1.nip.io:80 (DNS answer is private) via egress instance" "$P_EGRESS" 10.0.0.1.nip.io 80
  # dns-server switches to HolyWisp's own DNS client, which does not read /etc/hosts: these names
  # do not resolve at all on an egress instance (0x42), and are never handed to the proxy.
  expect_refused "localhost:80 via egress instance" 0x42 "$P_EGRESS" localhost 80
  expect_refused "metadata.google.internal:80 via egress instance" 0x42 "$P_EGRESS" metadata.google.internal 80
  expect_blocked "example.org:25 via egress instance (inherited block-port)" "$P_EGRESS" example.org 25
  if [[ $(grep -c . "$TMP/socks.log") == 1 ]]; then
    pass "refused destinations never reached the proxy"
  else
    fail "proxy saw: $(tr '\n' ' ' <"$TMP/socks.log")"
  fi
else
  skip "egress overlay relay (needs the internet and python3)"
fi

# ------------------------------------------------------------------------------- lifecycle
section "lifecycle: SO_REUSEPORT, SIGHUP, SIGTERM"
A=$NAME-reuse-a
start_server "$A" 65534 -- --port "$P_SPARE"
wait_ready "$P_SPARE" "$A" || die "instance A did not become ready"
if ((ONLINE)); then
  expect_http "gnome.conf with only --port (log-level warn): example.org:80" "$P_SPARE" example.org 80
fi
expect_blocked "gnome.conf with only --port: 169.254.169.254:80" "$P_SPARE" 169.254.169.254 80
B=$NAME-reuse-b
start_server "$B" 65534 -- --port "$P_SPARE"
sleep 0.5
if [[ $(docker inspect -f '{{.State.Running}}' "$B") == true ]]; then
  info "a second instance under the SAME UID co-binds port $P_SPARE silently (upstream SO_REUSEPORT behaviour)"
else
  info "a second instance under the same UID did not start: $(docker logs "$B" 2>&1 | tail -n 1)"
fi
docker rm -f "$B" >/dev/null
C=$NAME-reuse-c
start_server "$C" 65533 -- --port "$P_SPARE"
docker wait "$C" >/dev/null 2>&1 || true
rc=$(docker inspect -f '{{.State.ExitCode}}' "$C")
if [[ $(docker inspect -f '{{.State.Running}}' "$C") == false && $rc != 0 ]]; then
  pass "an instance under ANOTHER UID cannot bind port $P_SPARE (exit $rc: $(docker logs "$C" 2>&1 | grep -m1 -oE 'cannot start.*|bind.*' || true))"
else
  fail "an instance under another UID bound port $P_SPARE"
fi
docker kill -s HUP "$A" >/dev/null
sleep 0.5
if [[ $(docker inspect -f '{{.State.Running}}' "$A") == true ]]; then
  info "SIGHUP to holywisp as container PID 1: ignored (no handler, and PID 1 drops default-action signals)"
fi
docker rm -f "$A" >/dev/null
H=$NAME-hup
start_server "$H" 65534 --init -- --port "$P_SPARE"
wait_ready "$P_SPARE" "$H" || die "SIGHUP test instance did not become ready"
docker kill -s HUP "$H" >/dev/null
rc=$(timeout 10 docker wait "$H" || echo timeout)
[[ $rc == 129 ]] && pass "SIGHUP kills holywisp under an init (exit 129): why the units have no ExecReload" ||
  fail "SIGHUP under --init: exit $rc"
docker stop -t 5 "$MAIN" >/dev/null
rc=$(docker inspect -f '{{.State.ExitCode}}' "$MAIN")
[[ $rc == 0 ]] && log_has "$MAIN" "server: shutting down" && pass "SIGTERM: clean exit 0 ('server: shutting down')" ||
  fail "SIGTERM: exit $rc"

printf '\n%d passed, %d failed, %d skipped\n' "$PASSES" "$FAILS" "$SKIPS"
((FAILS == 0))
