#!/usr/bin/env bash
# Helpers for scripts/release.sh (WAVE-D §4.5). Sourced, not executed.
# shellcheck shell=bash

log() { printf '\033[1m[release]\033[0m %s\n' "$*" >&2; }
die() {
  printf '[release] error: %s\n' "$*" >&2
  exit "${2:-1}"
}

# Deterministic tar.gz of the paths listed (NUL-separated) in $3, relative to $2, written to $1.
# Every member gets mtime $SOURCE_DATE_EPOCH, owner 0:0 and normalized modes; gzip without name or time.
det_tar() { # out base list [prefix]
  local out=$1 base=$2 list=$3 prefix=${4:-}
  local transform=()
  [[ -n $prefix ]] && transform=(--transform "s,^,${prefix}/,")
  tar --sort=name --format=pax --mtime="@${SOURCE_DATE_EPOCH:?}" --owner=0 --group=0 --numeric-owner \
    --mode=u+rwX,go+rX,go-w --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime "${transform[@]}" \
    -C "$base" --no-recursion --null -cf - -T "$list" |
    gzip -n -9 > "$out"
}

# NUL-separated list of every directory and file under $1 (relative), sorted.
tree_list() { # base out
  (cd "$1" && find . -mindepth 1 \( -type f -o -type d -o -type l \) -printf '%P\0' | LC_ALL=C sort -z) > "$2"
}

# The source file list from the allow-list (relative paths, one per line, files only).
source_files() { # repo allowlist
  local repo=$1 allow=$2 kind arg
  local -a includes=() excludes=() keeps=()
  while read -r kind arg; do
    case $kind in
    include) includes+=("$arg") ;;
    exclude) excludes+=("$arg") ;;
    keep) keeps+=("$arg") ;;
    '' | \#*) ;;
    *) die "source-allowlist: unknown line '$kind $arg'" ;;
    esac
  done < "$allow"
  local ex keep
  ex=$(IFS='|'; echo "${excludes[*]}")
  keep=$(IFS='|'; echo "${keeps[*]:-^$}")
  (cd "$repo" && for p in "${includes[@]}"; do
    if [[ -d $p ]]; then find "$p" -type f -print; elif [[ -f $p ]]; then echo "$p"; fi
  done) | LC_ALL=C sort -u | EX=$ex KEEP=$keep awk '$0 ~ ENVIRON["KEEP"] || $0 !~ ENVIRON["EX"]'
}

# Deny-scan of a source file list (stdin: relative paths) under $1. Prints every hit; returns 1 on any.
deny_scan() { # repo
  local repo=$1 hits=0 f size
  while IFS= read -r f; do
    case ${f##*/} in
    secret.key | *.pem | *.key | .netrc) echo "denied file name: $f"; hits=1 ;;
    *.db | *.db-wal | *.db-shm | *.sqlite | *.sqlite3) echo "denied database file: $f"; hits=1 ;;
    .env | .env.*) [[ ${f##*/} == .env.example ]] || { echo "denied environment file: $f"; hits=1; } ;;
    esac
    case $f in
    deployment/secrets/* | */results/*.log | tests/e2e/engine/results/*) echo "denied generated or secret path: $f"; hits=1 ;;
    esac
    size=$(stat -c %s "$repo/$f")
    if ((size > 4 * 1024 * 1024)) && [[ $f != docs/screenshots/* ]]; then echo "file over 4 MiB: $f ($size bytes)"; hits=1; fi
    if grep -Iq . "$repo/$f" 2>/dev/null; then
      if grep -Eq -- '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----' "$repo/$f"; then
        # Test fixtures that are documented throwaway keys would have to be named here; none exist today.
        echo "private key block: $f"; hits=1
      fi
      if grep -Eq '_authToken[[:space:]]*=[[:space:]]*[^[:space:]]' "$repo/$f" && [[ $f != docs/* && $f != scripts/lib/release-lib.sh ]]; then
        echo "npm auth token: $f"; hits=1
      fi
      case $f in
      docs/* | *.md | scripts/lib/release-lib.sh | scripts/release.sh) ;;
      *) if grep -Eq '/home/[a-z_][a-z0-9_-]*/' "$repo/$f"; then echo "home directory path: $f"; hits=1; fi ;;
      esac
    fi
  done
  return "$hits"
}

# sha256sum lines (relative to $1) for every file under it, sorted, into $2.
sums_of_tree() { # dir out
  (cd "$1" && find . -type f ! -name SHA256SUMS -printf '%P\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$2"
}

# Integrity check of a downloaded npm tarball against the lock's "sha512-<base64>" value.
npm_integrity_ok() { # file integrity
  local want=${2#sha512-} got
  got=$(openssl dgst -sha512 -binary "$1" | base64 -w0)
  [[ $got == "$want" ]]
}
