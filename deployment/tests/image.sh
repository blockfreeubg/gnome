#!/usr/bin/env bash
# Rows I1-I3 (WAVE-D §5.8) on a built gnome-server image: size, read-only/unprivileged run, no shell, file list.
#
#   deployment/tests/image.sh [image]      # default gnome-server:dev
set -euo pipefail
img=${1:-gnome-server:dev}
run=(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs "/tmp:size=16m,noexec")
fail=0
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }
docker image inspect "$img" --format '{{.Config.User}} {{json .Config.Entrypoint}}' | grep -q '^65532:65532 \["/usr/local/bin/gnome-server"\]' &&
  ok "user 65532, entrypoint gnome-server" || bad "user/entrypoint"
echo "  info  size: $(docker image ls "$img" --format '{{.Size}}')"
"${run[@]}" "$img" version > /dev/null && ok "version" || bad "version"
"${run[@]}" "$img" config check > /dev/null 2>&1 && ok "config check" || bad "config check"
if "${run[@]}" --entrypoint /bin/sh "$img" -c true > /dev/null 2>&1; then bad "a shell exists"; else ok "no shell"; fi
c=$(docker create "$img")
trap 'docker rm -f "$c" > /dev/null' EXIT
list=$(docker export "$c" | tar -t)
grep -q '\.map$' <<< "$list" && bad ".map files in the image" || ok "no .map files"
grep -Eq 'e2e-driver|^bench/|fixtures/' <<< "$list" && bad "test or bench files in the image" || ok "no e2e driver, bench or fixtures"
grep -q '^usr/share/licenses/gnome/rust-crates.txt$' <<< "$list" && ok "licenses bundle" || bad "licenses bundle missing"
vol=gnome-image-test-$$
docker run -d --name "$vol" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:size=16m,noexec -v "$vol:/var/lib/gnome" "$img" > /dev/null
for _ in $(seq 40); do docker exec "$vol" /usr/local/bin/gnome-server health > /dev/null 2>&1 && break; sleep 0.5; done
docker exec "$vol" /usr/local/bin/gnome-server health > /dev/null && ok "serve answers /api/health" || bad "health"
docker rm -f "$vol" > /dev/null
docker volume rm "$vol" > /dev/null
((fail)) && exit 1
echo "image.sh: ok"
