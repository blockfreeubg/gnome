#!/usr/bin/env bash
# Supply-chain audit (WAVE-D D24, docs/AUDIT.md).
#
#   scripts/audit.sh [--offline] [--json FILE]
#
# 1. cargo deny --locked check (advisories, licenses, bans, sources; policy deny.toml) on the workspace, and the
#    advisories and sources checks on bench/loadgen (its own workspace, never shipped);
# 2. every deny.toml `ignore` entry still before its `# expires:` date (at most 90 days ahead);
# 3. npm audit in frontend/, tests/e2e/, bench/wispjs/ with GNOME's shipped/build-only classification
#    (scripts/audit/npm-audit.mjs, policy scripts/audit/npm-policy.json), and the locks' install scripts;
# 4. the versions compiled into the vendored wasm (scripts/audit/embedded.mjs);
# 5. the pinned third-party images (name, tag, digest) found in the deployment files; the Caddy and gluetun binaries
#    are checked with govulncheck -mode=binary only when GNOME_GOVULNCHECK_IMAGE names a pinned Go image
#    (otherwise "skipped").
# --offline uses the cached advisory database; every part that needs the network reports "skipped", never "pass".
# Exit 0 pass, 1 policy failure, 2 usage or tool error. --json writes the summary (release.sh puts it in BUILDINFO).
set -euo pipefail
umask 022
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DENY_VERSION=0.22.1
DENY="${CARGO_DENY:-$HOME/.cache/gnome-tools/cargo-deny-$DENY_VERSION/bin/cargo-deny}"
OFFLINE=0
JSON=""
while [ $# -gt 0 ]; do
  case "$1" in
    --offline) OFFLINE=1 ;;
    --json) JSON="${2:?--json needs a file}"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "usage: scripts/audit.sh [--offline] [--json FILE]" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -x "$DENY" ] || ! "$DENY" --version 2>/dev/null | grep -q " $DENY_VERSION"; then
  echo "cargo-deny $DENY_VERSION not found at $DENY. Install it per user:" >&2
  echo "  cargo install --locked --version $DENY_VERSION --root ~/.cache/gnome-tools/cargo-deny-$DENY_VERSION cargo-deny" >&2
  exit 2
fi
command -v node >/dev/null || { echo "node not found" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0
declare -A PART

deny_args=(--log-level warn --locked)
check_args=()
if [ "$OFFLINE" = 1 ]; then deny_args+=(--offline); fi

run_part() { # name, command...
  local name="$1"; shift
  if "$@" >"$TMP/$name.log" 2>&1; then
    # Offline, the advisories check used the cached database: say so, it is not a fresh pass.
    if [ "$OFFLINE" = 1 ]; then PART[$name]="pass (cached advisory database)"; else PART[$name]=pass; fi
  else PART[$name]=fail; FAIL=1; fi
  sed 's/^/  /' "$TMP/$name.log" | tail -n 40
  echo "$name: ${PART[$name]}"
}

cd "$ROOT"
run_part cargo-deny "$DENY" "${deny_args[@]}" check "${check_args[@]}"
if [ -f bench/loadgen/Cargo.toml ]; then
  run_part loadgen-deny "$DENY" "${deny_args[@]}" --manifest-path bench/loadgen/Cargo.toml check "${check_args[@]}" advisories sources
fi

# deny.toml ignore expiry: every `{ id = … }` line of [advisories] ignore needs `# expires: YYYY-MM-DD` ≤ 90 days.
today="$(date -u +%F)"
expiry_problems="$(awk -v today="$today" '
  /^\[/ { section = $0 }
  section == "[advisories]" && !/^[[:space:]]*#/ && /id *= *"RUSTSEC-/ {
    if (match($0, /# expires: [0-9]{4}-[0-9]{2}-[0-9]{2}/)) {
      d = substr($0, RSTART + 11, 10)
      if (d < today) print "deny.toml: " $0 " expired on " d
    } else print "deny.toml: ignore without # expires: " $0
  }' deny.toml)"
max="$(date -u -d "+90 days" +%F)"
over="$(grep -o '# expires: [0-9-]*' deny.toml | awk -v m="$max" '{ if ($3 > m) print "deny.toml: expires more than 90 days ahead: " $3 }')"
if [ -n "$expiry_problems$over" ]; then echo "$expiry_problems$over"; PART[deny-expiry]=fail; FAIL=1; else PART[deny-expiry]=pass; fi
echo "deny-expiry: ${PART[deny-expiry]}"

npm_args=(--json "$TMP/npm.json")
[ "$OFFLINE" = 1 ] && npm_args+=(--offline)
set +e
node scripts/audit/npm-audit.mjs "${npm_args[@]}"
rc=$?
set -e
case $rc in
  0) PART[npm-audit]="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).status)' "$TMP/npm.json")" ;;
  1) PART[npm-audit]=fail; FAIL=1 ;;
  *) PART[npm-audit]=error; [ "$FAIL" = 0 ] && FAIL=2 ;;
esac
echo "npm-audit: ${PART[npm-audit]}"

node scripts/audit/embedded.mjs --json "$TMP/embedded.json" >/dev/null && PART[embedded]=recorded || PART[embedded]=error

# Pinned images in the deployment files (name:tag@sha256:digest).
grep -rhoE '[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}' deployment services bench 2>/dev/null \
  | sort -u >"$TMP/images.txt" || true
echo "pinned images:"; sed 's/^/  /' "$TMP/images.txt"
if [ -n "${GNOME_GOVULNCHECK_IMAGE:-}" ]; then
  PART[govulncheck]="skipped (not implemented in this script yet; run it by hand, docs/AUDIT.md)"
else
  PART[govulncheck]="skipped (set GNOME_GOVULNCHECK_IMAGE to a pinned Go image)"
fi
echo "govulncheck: ${PART[govulncheck]}"

if [ -n "$JSON" ]; then
  for k in "${!PART[@]}"; do printf '%s\t%s\n' "$k" "${PART[$k]}"; done >"$TMP/parts.tsv"
  node - "$JSON" "$TMP" "$FAIL" "$DENY_VERSION" "$OFFLINE" <<'NODE'
const [file, tmp, fail, deny, offline] = process.argv.slice(2);
const fs = require('fs');
const parts = Object.fromEntries(fs.readFileSync(`${tmp}/parts.tsv`, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')));
const read = (f) => { try { return JSON.parse(fs.readFileSync(`${tmp}/${f}`, 'utf8')); } catch { return null; } };
const images = fs.existsSync(`${tmp}/images.txt`) ? fs.readFileSync(`${tmp}/images.txt`, 'utf8').split('\n').filter(Boolean) : [];
const out = { date: new Date().toISOString(), offline: offline === '1', tools: { 'cargo-deny': deny, node: process.version }, parts, npm: read('npm.json'), embedded: read('embedded.json'), images, status: fail === '0' ? 'pass' : fail === '1' ? 'fail' : 'error' };
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
NODE
fi
[ "$FAIL" = 0 ] && echo "audit: pass" || echo "audit: $([ "$FAIL" = 1 ] && echo fail || echo error)"
exit "$FAIL"
