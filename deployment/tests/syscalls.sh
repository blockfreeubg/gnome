#!/usr/bin/env bash
# Row SD1 (WAVE-D §5.4), reduced workload: the static musl gnome-server under `strace -f` in an unprivileged Alpine
# container (--network none, read-only root, tmpfs /tmp, --cap-drop ALL, no-new-privileges, UID 65532) through
# config check, migrate, serve on loopback, /api/health, static files (br/gzip/identity, a 304), health, db backup,
# admin get and SIGTERM. Every traced system call must be inside gnome-server.service's SystemCallFilter (expanded by
# this host's systemd-analyze) and every socket family inside RestrictAddressFamilies.
# Not covered yet (marked in the report): the Wisp upgrade/splice path, Argon2 sign-up, sync upload.
#
#   deployment/tests/syscalls.sh <static musl gnome-server> <release dist/>
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bin=$(realpath "${1:?usage: syscalls.sh <gnome-server> <dist>}")
dist=$(realpath "${2:?usage: syscalls.sh <gnome-server> <dist>}")
unit=$here/../systemd/gnome-server.service
ALPINE_IMAGE=alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
img=gnome-strace:alpine3.22
docker image inspect "$img" > /dev/null 2>&1 ||
  printf 'FROM %s\nRUN apk add --no-cache strace curl\n' "$ALPINE_IMAGE" | docker build -q -t "$img" - > /dev/null
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod 0777 "$tmp"
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --user 65532:65532 \
  --tmpfs /tmp:size=64m -v "$bin:/gnome-server:ro" -v "$dist:/dist:ro" -v "$tmp:/out" \
  "$img" sh -euc '
  export GNOME_DATA_DIR=/tmp/data GNOME_STATIC_DIR=/dist GNOME_BIND=127.0.0.1:11990 GNOME_PROXY_BIND=127.0.0.1:11991 \
    GNOME_ADMIN_BIND=127.0.0.1:11992 GNOME_ADMIN_TOKEN=syscalls-test-admin-token-0123 GNOME_WISP_UPSTREAM=127.0.0.1:9 \
    GNOME_FILTERS_REFRESH_HOURS=0 GNOME_CATALOG_REFRESH_HOURS=0 GNOME_OSS_FETCH=manual GNOME_LOG=warn
  t() { strace -f -qq -e trace=all -o "/out/trace.$1" -- /gnome-server "$@"; }
  t config check > /dev/null
  t migrate > /dev/null
  strace -f -qq -o /out/trace.serve -- /gnome-server serve & pid=$!
  i=0; until /gnome-server health > /dev/null 2>&1; do i=$((i + 1)); [ $i -lt 100 ] || exit 1; sleep 0.2; done
  a=$(ls /dist/assets/*.js | head -1); a=${a#/dist}
  for e in br gzip identity; do curl -fsS -o /dev/null -H "accept-encoding: $e" "http://127.0.0.1:11990$a"; done
  tag=$(curl -fsSI -H "accept-encoding: br" "http://127.0.0.1:11990$a" | sed -n "s/^etag: //Ip" | tr -d "\r")
  curl -s -o /dev/null -w "%{http_code}\n" -H "if-none-match: $tag" -H "accept-encoding: br" "http://127.0.0.1:11990$a" > /out/304
  curl -fsS -o /dev/null http://127.0.0.1:11991/engine/
  t health > /dev/null
  t admin get /admin/diagnostics > /dev/null
  t db backup /tmp/backup.db > /dev/null
  # SIGTERM to gnome-server itself (strace keeps tracing it through the shutdown).
  kill -TERM "$(pidof gnome-server)"; wait $pid || true'
[[ $(cat "$tmp/304") == 304 ]] || { echo "syscalls.sh: the revalidation was not a 304" >&2; exit 1; }
# The unit's filter, expanded by this host's systemd.
# Groups list other groups (`@default`, …) besides calls: expand recursively.
expand() { # group...
  local g item
  for g in "$@"; do
    while read -r item; do
      case $item in
      @*) expand "$item" ;;
      [a-z_]*) echo "$item" ;;
      esac
    done < <(systemd-analyze syscall-filter "$g" | sed -n '2,$s/^ \{4\}\([@a-z0-9_-]*\)$/\1/p')
  done
}
allow=$(expand @system-service | sort -u)
deny_groups=$(sed -n 's/^SystemCallFilter=~//p' "$unit")
# shellcheck disable=SC2086
deny=$(expand $deny_groups | sort -u)
used=$(cat "$tmp"/trace.* | sed -n 's/^[0-9]* *\([a-z0-9_]*\)(.*/\1/p' | sort -u)
fail=0
outside=$(comm -23 <(echo "$used") <(comm -23 <(echo "$allow") <(echo "$deny")))
[[ -z $outside ]] || { echo "outside the unit's SystemCallFilter: $(echo "$outside" | tr '\n' ' ')"; fail=1; }
fams=$(grep -ho 'socket(AF_[A-Z0-9]*' "$tmp"/trace.* | sed 's/socket(//' | sort -u | tr '\n' ' ')
for f in $fams; do [[ $f == AF_INET || $f == AF_INET6 || $f == AF_UNIX ]] || { echo "socket family outside RestrictAddressFamilies: $f"; fail=1; }; done
grep -h 'PROT_WRITE|PROT_EXEC\|PROT_EXEC|PROT_WRITE' "$tmp"/trace.* > /dev/null && { echo "a writable+executable mapping"; fail=1; }
grep -h '^[0-9]* *personality(' "$tmp"/trace.* > /dev/null && { echo "personality() called"; fail=1; }
res=$(comm -12 <(echo "$used") <(expand @resources | sort -u) | tr '\n' ' ')
echo "distinct system calls: $(echo "$used" | wc -l); socket families: $fams; from @resources: ${res:-none}"
echo "$used" | tr '\n' ' '
echo
((fail)) && { echo "syscalls.sh: the unit does NOT fit the trace"; exit 1; }
echo "syscalls.sh: the unit fits the traced workload"
