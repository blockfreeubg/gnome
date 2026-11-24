#!/usr/bin/env bash
# Rows I4/RP1 (WAVE-D §5.8): an aarch64 gnome-server (and HolyWisp) under QEMU user-mode, invoked directly inside an
# unprivileged amd64 container with --network none. No binfmt registration, no timings.
#
#   deployment/tests/arm64.sh <dir with gnome-server [and holywisp]>   # e.g. an unpacked gnome-<v>-linux-aarch64/bin
set -euo pipefail
bin=$(cd "${1:?usage: arm64.sh <dir with the aarch64 gnome-server>}" && pwd)
ALPINE_IMAGE=alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
img=gnome-qemu-aarch64:10.0.0-r1
if ! docker image inspect "$img" > /dev/null 2>&1; then
  # The only networked step: installing the pinned QEMU user-mode package into a local tool image.
  printf 'FROM %s\nRUN apk add --no-cache qemu-aarch64=10.0.0-r1 file\n' "$ALPINE_IMAGE" | docker build -q -t "$img" - > /dev/null
fi
file -b "$bin/gnome-server" | grep -q 'ARM aarch64' || { echo "arm64.sh: $bin/gnome-server is not an aarch64 binary" >&2; exit 1; }
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --user 65532:65532 \
  --tmpfs /tmp:size=64m -v "$bin:/bin-arm64:ro" "$img" sh -euc '
    q=qemu-aarch64
    file -b /bin-arm64/gnome-server
    $q /bin-arm64/gnome-server version
    mkdir -p /tmp/data /tmp/static
    export GNOME_DATA_DIR=/tmp/data GNOME_STATIC_DIR=/tmp/static GNOME_BIND=127.0.0.1:11980 GNOME_ADMIN_BIND= \
      GNOME_WISP_UPSTREAM=127.0.0.1:9 GNOME_ARGON2_MEMORY_KIB=1024 GNOME_FILTERS_REFRESH_HOURS=0 \
      GNOME_CATALOG_REFRESH_HOURS=0 GNOME_OSS_FETCH=manual GNOME_LOG=warn
    $q /bin-arm64/gnome-server config check > /tmp/cc.txt && tail -1 /tmp/cc.txt
    $q /bin-arm64/gnome-server serve & pid=$!
    i=0; until $q /bin-arm64/gnome-server health --timeout-ms 1000 > /tmp/h.txt 2>&1; do
      i=$((i + 1)); [ $i -lt 60 ] || { cat /tmp/h.txt; exit 1; }; sleep 0.5; done
    echo "health: $(cat /tmp/h.txt)"
    kill $pid; wait $pid || true
    if [ -x /bin-arm64/holywisp ]; then $q /bin-arm64/holywisp --version; fi
    echo "arm64.sh: ok"'
