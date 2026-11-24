#!/usr/bin/env bash
# GNOME release (WAVE-D §4.5, D13): from one source tree, the Corresponding Source tarball, then everything else built
# from that tarball: gnome-<v>-linux-<arch>.tar.gz for x86_64 and aarch64 (static musl gnome-server cross-compiled
# with tonistiigi/xx, never binfmt; HolyWisp at its pin; the release dist/; examples; the licenses bundle; BUILDINFO;
# an inner SHA256SUMS), an outer SHA256SUMS, optionally the images, a reproducibility check and a signature.
#
#   scripts/release.sh [--version V] [--arch x86_64,aarch64] [--out release/] [--image] [--verify-reproducible]
#                      [--allow-budget-overrun "<reason>"] [--skip-audit "<reason>"]
#                      [--third-party-source | --no-third-party-source] [--allow-missing-source "<reason>"]
#                      [--sign <ssh-key-file|gpg-key-id>] [--source-url-base URL] [--reuse-holywisp]
#
# --source-url-base URL   where the archives will be published; compiled in as GNOME_DEFAULT_SOURCE_URL (D27)
# --reuse-holywisp        use services/holywisp/build/<arch>/ when its BUILDINFO matches the pin (no rebuild)
# Exit: 0 ok, 1 failure, 2 usage or preflight.
set -euo pipefail
umask 022
export LC_ALL=C TZ=UTC

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/release-lib.sh
source "$repo/scripts/lib/release-lib.sh"

version="" archs="x86_64,aarch64" out="$repo/release" want_image=0 repro=0 overrun="" skip_audit=""
tps=1 missing_ok="" sign_key="" url_base="" reuse_hw=0
while (($#)); do
  case $1 in
  --version) version=${2:?}; shift ;;
  --arch) archs=${2:?}; shift ;;
  --out) out=$(realpath -m "${2:?}"); shift ;;
  --image) want_image=1 ;;
  --verify-reproducible) repro=1 ;;
  --allow-budget-overrun) overrun=${2:?--allow-budget-overrun needs a reason}; shift ;;
  --skip-audit) skip_audit=${2:?--skip-audit needs a reason}; shift ;;
  --third-party-source) tps=1 ;;
  --no-third-party-source) tps=0 ;;
  --allow-missing-source) missing_ok=${2:?--allow-missing-source needs a reason}; shift ;;
  --sign) sign_key=${2:?}; shift ;;
  --source-url-base) url_base=${2%/}; shift ;;
  --reuse-holywisp) reuse_hw=1 ;;
  -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
  *) die "unknown option $1 (see --help)" 2 ;;
  esac
  shift
done

# ---- 1. preflight ------------------------------------------------------------------------------------------------
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' ||
  die "Node >= 22.12 is required" 2
docker buildx version > /dev/null 2>&1 || die "Docker with buildx is required" 2
[[ -f $repo/Cargo.lock && -f $repo/frontend/package-lock.json ]] || die "Cargo.lock and frontend/package-lock.json are required" 2
cargo_v=$(sed -n '/^\[workspace.package\]/,/^\[/{s/^version = "\(.*\)"/\1/p}' "$repo/Cargo.toml")
npm_v=$(node -p 'require(process.argv[1]).version' "$repo/frontend/package.json")
[[ $cargo_v == "$npm_v" ]] || die "version mismatch: Cargo.toml $cargo_v, frontend/package.json $npm_v" 2
version=${version:-$cargo_v}
[[ $version == "$cargo_v" ]] || die "--version $version differs from the tree's $cargo_v" 2
IFS=, read -r -a arch_list <<< "$archs"
for a in "${arch_list[@]}"; do [[ $a == x86_64 || $a == aarch64 ]] || die "unknown arch $a" 2; done
platform() { [[ $1 == x86_64 ]] && echo linux/amd64 || echo linux/arm64; }

audit_result="skipped: $skip_audit"
if [[ -z $skip_audit ]]; then
  [[ -x $repo/scripts/audit.sh ]] || die "scripts/audit.sh is missing; pass --skip-audit \"<reason>\"" 2
  log "audit"
  "$repo/scripts/audit.sh" || die "scripts/audit.sh failed"
  audit_result="passed $(date -u +%F)"
fi

mkdir -p "$out"
work=$out/work
rm -rf "$work"
mkdir -p "$work"

# ---- 2. source tarball -------------------------------------------------------------------------------------------
log "source tarball"
source_files "$repo" "$repo/scripts/lib/source-allowlist.txt" > "$work/src.files"
grep -qx LICENSE "$work/src.files" || die "the root LICENSE is missing"
if ! deny_scan "$repo" < "$work/src.files" > "$work/deny.txt"; then
  cat "$work/deny.txt" >&2
  die "the source deny-scan failed (above); fix the tree or the allow-list"
fi
SOURCE_DATE_EPOCH=$(cd "$repo" && tr '\n' '\0' < "$work/src.files" | xargs -0 stat -c %Y | sort -n | tail -1)
export SOURCE_DATE_EPOCH
# Directories too, so the tarball unpacks with the same modes everywhere.
{ cat "$work/src.files"; awk -F/ '{p = $1; for (i = 2; i <= NF; i++) { print p; p = p "/" $i }}' "$work/src.files"; } |
  sort -u | tr '\n' '\0' > "$work/src.list0"
src_tar=$out/gnome-$version-src.tar.gz
det_tar "$src_tar" "$repo" "$work/src.list0" "gnome-$version"
src_sha=$(sha256sum "$src_tar" | cut -d' ' -f1)
build_id="$version+${src_sha:0:12}"
log "build id $build_id (SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)"
src_url="" tps_url=""
if [[ -n $url_base ]]; then
  src_url="$url_base/gnome-$version-src.tar.gz"
  tps_url="$url_base/gnome-$version-third-party-src.tar.gz"
fi

# ---- 10 (first: SOURCE.txt names it). Third-party source (D27) --------------------------------------------------
tps_tar="" tps_sha="" missing_reason=""
if ((tps)); then
  log "third-party source"
  unverified=$(node -e '
    const s = require(process.argv[1]).packages;
    console.log(Object.entries(s).filter(([, v]) => !v.verified).map(([k]) => k).join(" "));' "$repo/scripts/third-party-sources.json")
  if [[ -n $unverified ]]; then
    [[ -n $missing_ok ]] || die "copyleft/MPL components without a verified upstream revision: $unverified (pass --allow-missing-source \"<reason>\" or --no-third-party-source)"
    missing_reason="$missing_ok (unverified: $unverified)"
  fi
  tdir=$work/third-party/gnome-$version-third-party-src
  mkdir -p "$tdir/npm" "$tdir/git"
  # Verified entries: fetched by commit, tree hash checked.
  node -e '
    const s = require(process.argv[1]).packages;
    for (const [k, v] of Object.entries(s)) if (v.verified) console.log([k, v.repository, v.commit, v.tree].join(" "));' \
    "$repo/scripts/third-party-sources.json" | while read -r key url commit tree; do
    d=$tdir/git/${key//\//_}
    git init -q "$d"
    git -C "$d" fetch -q --depth 1 "$url" "$commit"
    got=$(git -C "$d" rev-parse "FETCH_HEAD^{tree}")
    [[ $got == "$tree" ]] || die "$key: tree $got, expected $tree"
    git -C "$d" archive --format=tar FETCH_HEAD | tar -x -C "$d" && rm -rf "$d/.git"
  done
  # The npm tarballs GNOME ships, integrity-checked against the lock.
  node -e '
    const s = require(process.argv[1]).packages, lock = require(process.argv[2]).packages;
    for (const k of Object.keys(s)) {
      const name = k.replace(/@[^@]*$/, ""), l = lock["node_modules/" + name];
      if (!l) { console.error("not in package-lock.json: " + k); process.exit(1); }
      console.log([k, l.resolved, l.integrity].join(" "));
    }' "$repo/scripts/third-party-sources.json" "$repo/frontend/package-lock.json" | while read -r key url integrity; do
    f=$tdir/npm/$(basename "$url")
    curl -fsSL --proto '=https' -o "$f" "$url"
    npm_integrity_ok "$f" "$integrity" || die "$key: npm tarball integrity mismatch"
    printf '%s %s %s\n' "$key" "$url" "$integrity" >> "$tdir/npm/INDEX.txt"
  done
  cp "$repo/scripts/third-party-sources.json" "$tdir/"
  tree_list "$work/third-party" "$work/tps.list0"
  tps_tar=$out/gnome-$version-third-party-src.tar.gz
  det_tar "$tps_tar" "$work/third-party" "$work/tps.list0"
  tps_sha=$(sha256sum "$tps_tar" | cut -d' ' -f1)
fi

# ---- 3-7 build pass (repeated by --verify-reproducible) -----------------------------------------------------------
build_pass() { # dir nocache
  local dir=$1 nocache=$2 src a p arch_dir art
  local -a bx=(docker buildx build -f deployment/Dockerfile --progress plain
    --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" --build-arg "GNOME_BUILD_ID=$build_id"
    --build-arg "GNOME_DEFAULT_SOURCE_URL=$src_url" --build-arg "GNOME_THIRD_PARTY_SOURCE_URL=$tps_url"
    --build-arg "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-3}")
  ((nocache)) && bx+=(--no-cache)
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/out" "$dir/logs"
  tar -xzf "$src_tar" -C "$dir/src"
  src=$dir/src/gnome-$version
  for a in "${arch_list[@]}"; do
    p=$(platform "$a")
    # 3. the release dist/ (pinned Node image), 4. the static binary and 5. the licenses: one build per architecture
    log "build $a ($p): release dist/, static musl gnome-server, licenses"
    (cd "$src" && "${bx[@]}" --platform "$p" --target release-out --output "type=local,dest=$dir/out/$a" . ) \
      > "$dir/logs/build-$a.log" 2>&1 || { tail -30 "$dir/logs/build-$a.log" >&2; die "build $a failed (log: $dir/logs/build-$a.log)"; }
    if [[ ! -d $dir/out/dist ]]; then
      mv "$dir/out/$a/dist" "$dir/out/dist"
    else
      # The frontend does not depend on the target: both builds must give the same dist/.
      diff -r -q "$dir/out/dist" "$dir/out/$a/dist" > /dev/null || die "the release dist/ of $a differs from the first architecture's"
      rm -rf "$dir/out/$a/dist"
    fi
    if [[ ! -f $dir/logs/postbuild-check.log ]]; then
      node "$src/frontend/scripts/postbuild.mjs" --dist "$dir/out/dist" --check > "$dir/logs/postbuild-check.log" 2>&1 ||
        { cat "$dir/logs/postbuild-check.log" >&2; die "postbuild --check failed on the release dist/"; }
      if grep -q ' OVER ' "$dir/logs/postbuild-check.log" && [[ -z $overrun ]]; then die "an enforced budget is over (see $dir/logs/postbuild-check.log)"; fi
    fi
    check_pins "$src/deployment/Dockerfile" "$dir/out/$a/server/BUILDINFO"
    # HolyWisp at its pin
    holywisp "$a" "$dir"
    # 6. assemble
    arch_dir=$dir/stage/gnome-$version-linux-$a
    assemble "$src" "$dir" "$a" "$arch_dir"
    # 7. tarball
    tree_list "$dir/stage" "$dir/stage.$a.list0"
    grep -z "^gnome-$version-linux-$a" "$dir/stage.$a.list0" > "$dir/stage.$a.sel0" || true
    art=$dir/out/gnome-$version-linux-$a.tar.gz
    det_tar "$art" "$dir/stage" "$dir/stage.$a.sel0"
  done
  # Base images resolved by digest show as CACHED; every RUN/COPY/ADD step must have run again.
  if ((nocache)); then
    local cached
    cached=$(awk '$2 ~ /^\[/ && $0 ~ /\] (RUN|COPY|ADD) / {step[$1] = $0} $2 == "CACHED" && ($1 in step) {print step[$1]}' "$dir"/logs/build-*.log)
    [[ -z $cached ]] || die "the no-cache pass used a cached build step: $cached"
  fi
}

check_pins() { # dockerfile buildinfo
  local pins pin name ver
  pins=$(sed -n 's/^ARG \(XX_\)\{0,1\}APK_PINS="\(.*\)"$/\2/p' "$1")
  for pin in $pins; do
    name=${pin%%=*} ver=${pin#*=}
    grep -q -- "$name-$ver" "$2" || die "Alpine package drift: $pin not in $(basename "$(dirname "$2")") BUILDINFO"
  done
}

holywisp() { # arch dir
  local a=$1 dir=$2 hw=$repo/services/holywisp/build/$1 commit
  commit=$(sed -n 's/^HOLYWISP_COMMIT=//p' "$repo/services/holywisp/VERSION")
  if ((reuse_hw)) && [[ -x $hw/holywisp ]] && grep -q "$commit" "$hw/BUILDINFO"; then
    log "holywisp $a: reusing $hw (pin ${commit:0:7})"
  else
    log "holywisp $a: services/holywisp/fetch-build.sh --arch $a"
    local nc=()
    ((repro)) && [[ $dir == *work2 ]] && nc=(--no-cache)
    "$repo/services/holywisp/fetch-build.sh" --arch "$a" "${nc[@]}" > "$dir/logs/holywisp-$a.log" 2>&1 ||
      { tail -20 "$dir/logs/holywisp-$a.log" >&2; die "HolyWisp $a build failed"; }
  fi
  (cd "$hw" && sha256sum -c --quiet SHA256SUMS) || die "HolyWisp $a: SHA256SUMS do not verify"
  mkdir -p "$dir/out/$a/holywisp"
  cp "$hw/holywisp" "$hw/LICENSE" "$hw/LICENSE.musl" "$hw/BUILDINFO" "$dir/out/$a/holywisp/"
}

assemble() { # src dir arch dest
  local src=$1 dir=$2 a=$3 d=$4
  rm -rf "$d"
  mkdir -p "$d/bin" "$d/share/gnome" "$d/share/licenses" "$d/etc/caddy" "$d/etc/systemd" "$d/libexec"
  install -m 0755 "$dir/out/$a/server/gnome-server" "$d/bin/gnome-server"
  install -m 0755 "$dir/out/$a/holywisp/holywisp" "$d/bin/holywisp"
  cp -a "$dir/out/dist" "$d/share/gnome/dist"
  cp -a "$dir/out/$a/licenses/." "$d/share/licenses/"
  mkdir -p "$d/share/licenses/holywisp"
  cp "$dir/out/$a/holywisp/"{LICENSE,LICENSE.musl,BUILDINFO} "$d/share/licenses/holywisp/"
  {
    echo "GNOME is free software: GNU Affero General Public License, version 3 only (GNOME-AGPL-3.0.txt)."
    echo
    echo "Corresponding Source of this build ($build_id):"
    echo "  gnome-$version-src.tar.gz  sha256 $src_sha  ${src_url:-(publish it next to this artifact)}"
    [[ -n $tps_tar ]] && echo "  gnome-$version-third-party-src.tar.gz  sha256 $tps_sha  ${tps_url:-(publish it next to this artifact)}"
    [[ -n $missing_reason ]] && echo "  missing third-party revisions: $missing_reason"
    echo "Default GNOME_SOURCE_URL compiled into gnome-server: ${src_url:-(none)}"
    echo
    echo "If you run a modified GNOME for other people over a network, AGPL-3.0 section 13 requires you to offer them"
    echo "the Corresponding Source of your version (set GNOME_SOURCE_URL; About links to it)."
  } > "$d/share/licenses/SOURCE.txt"
  cp "$src/deployment/systemd/gnome.env.example" "$src/deployment/systemd/route-b.env.example" "$d/etc/"
  cp "$src/deployment/Caddyfile" "$d/etc/"
  cp "$src/deployment/caddy/"*.caddy "$d/etc/caddy/"
  cp "$src/services/holywisp/gnome.conf" "$d/etc/holywisp.conf"
  cp "$src/services/holywisp/vpn-egress.conf.example" "$d/etc/"
  cp "$src/deployment/systemd/gnome-server.service" "$src/services/holywisp/holywisp.service" \
    "$src/services/holywisp/holywisp@.service" "$d/etc/systemd/"
  cp -r "$src/deployment/systemd/gnome-server.service.d" "$src/deployment/systemd/holywisp.service.d" "$d/etc/systemd/"
  install -m 0755 "$src/services/holywisp/check-egress.sh" "$d/libexec/check-egress"
  cat > "$d/README.txt" << EOF
GNOME $version ($build_id) for linux-$a

bin/gnome-server and bin/holywisp are static binaries. Install and run them as docs/DEPLOYMENT.md "Route B"
describes (in the source tarball gnome-$version-src.tar.gz): verify SHA256SUMS(.sig) before unpacking, then
  install -m 0755 bin/gnome-server bin/holywisp /usr/local/bin/
  cp -r share/gnome /usr/local/share/          # the web app: /usr/local/share/gnome/dist
  cp etc/systemd/*.service /etc/systemd/system/
Licenses: share/licenses/ (SOURCE.txt says where the source is).
EOF
  {
    echo "GNOME $version"
    echo "build id:           $build_id"
    echo "arch:               $a ($(platform "$a"))"
    echo "SOURCE_DATE_EPOCH:  $SOURCE_DATE_EPOCH"
    echo "source tarball:     gnome-$version-src.tar.gz sha256 $src_sha"
    [[ -n $tps_tar ]] && echo "third-party source: gnome-$version-third-party-src.tar.gz sha256 $tps_sha"
    echo "default source URL: ${src_url:-(none)}"
    echo "audit:              $audit_result"
    [[ -n $overrun ]] && echo "budget overrun:     $overrun"
    [[ -n $missing_reason ]] && echo "missing source:     $missing_reason"
    ((tps)) || echo "third-party source: not built (--no-third-party-source; not for a published release)"
    echo "base images:        $(grep -E '^ARG (XX|NODE|RUST)_IMAGE=' "$src/deployment/Dockerfile" | sed 's/^ARG //' | tr '\n' ' ')"
    echo
    echo "--- gnome-server ---"
    cat "$dir/out/$a/server/BUILDINFO"
    echo
    echo "--- holywisp ---"
    cat "$dir/out/$a/holywisp/BUILDINFO"
    echo
    echo "--- budgets (release dist/) ---"
    grep -E '^ +BB[0-9]' "$dir/logs/postbuild-check.log" || true
  } > "$d/BUILDINFO"
  # Deterministic metadata of the staged files (tar takes the mtime from SOURCE_DATE_EPOCH anyway).
  sums_of_tree "$d" "$d/SHA256SUMS"
}

build_pass "$work/pass1" 0

publish() { # from
  local f
  for f in "$1"/out/gnome-"$version"-linux-*.tar.gz; do cp "$f" "$out/"; done
}
publish "$work/pass1"

# ---- 8. images ------------------------------------------------------------------------------------------------------
if ((want_image)); then
  log "images"
  : > "$out/BUILDINFO-images.txt"
  src=$work/pass1/src/gnome-$version
  for a in "${arch_list[@]}"; do
    p=$(platform "$a")
    oci=$out/gnome-server-$version-$a.oci.tar
    (cd "$src" && docker buildx build -f deployment/Dockerfile --progress plain --platform "$p" --target runtime \
      --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" --build-arg "GNOME_BUILD_ID=$build_id" \
      --build-arg "GNOME_DEFAULT_SOURCE_URL=$src_url" --build-arg "GNOME_THIRD_PARTY_SOURCE_URL=$tps_url" \
      --build-arg "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-3}" \
      --output "type=oci,dest=$oci,rewrite-timestamp=true" . ) > "$work/pass1/logs/image-$a.log" 2>&1 ||
      { tail -30 "$work/pass1/logs/image-$a.log" >&2; die "image $a failed"; }
    digest=$(tar -xOf "$oci" index.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).manifests[0].digest))')
    printf '%s %s %s bytes %s\n' "gnome-server:$version" "$p" "$(stat -c %s "$oci")" "$digest" >> "$out/BUILDINFO-images.txt"
    if [[ $a == x86_64 ]]; then
      (cd "$src" && docker buildx build -f deployment/Dockerfile --platform "$p" --target runtime -q \
        --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" --build-arg "GNOME_BUILD_ID=$build_id" \
        --build-arg "GNOME_DEFAULT_SOURCE_URL=$src_url" --build-arg "GNOME_THIRD_PARTY_SOURCE_URL=$tps_url" \
        --build-arg "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-3}" -t "gnome-server:$version" --load . ) > /dev/null
      log "loaded gnome-server:$version (amd64)"
    fi
  done
fi

# ---- outer SHA256SUMS -------------------------------------------------------------------------------------------------
# The image archives too: a downloaded .oci.tar must verify like the tarballs (BUILDINFO-images.txt holds the
# manifest digests, which `sha256sum -c` does not check).
mapfile -t sums < <(cd "$out" && ls gnome-"$version"-*.tar.gz && if ((want_image)); then ls gnome-server-"$version"-*.oci.tar; fi)
[[ -f $out/BUILDINFO-images.txt ]] && sums+=(BUILDINFO-images.txt)
(cd "$out" && sha256sum "${sums[@]}" > SHA256SUMS)
log "artifacts in $out:"
(cd "$out" && sed 's/^/    /' SHA256SUMS >&2)

# ---- 9. reproducibility --------------------------------------------------------------------------------------------
if ((repro)); then
  log "verify-reproducible: second pass without any build cache"
  build_pass "$work/work2" 1
  for a in "${arch_list[@]}"; do
    f=gnome-$version-linux-$a.tar.gz
    h1=$(sha256sum "$out/$f" | cut -d' ' -f1) h2=$(sha256sum "$work/work2/out/$f" | cut -d' ' -f1)
    if [[ $h1 != "$h2" ]]; then
      first=$(diff <(cd "$work/pass1/stage/gnome-$version-linux-$a" && cat SHA256SUMS) \
        <(cd "$work/work2/stage/gnome-$version-linux-$a" && cat SHA256SUMS) | grep -m2 '^[<>]' | tr '\n' ' ')
      die "not reproducible: $f $h1 vs $h2; first differing file: $first"
    fi
    log "reproducible: $f $h1"
  done
  echo "reproducible: $(date -u +%FT%TZ) second pass --no-cache, no cached RUN/COPY step; identical: ${arch_list[*]}" > "$out/REPRODUCIBLE.txt"
fi

# ---- 11. signature ---------------------------------------------------------------------------------------------------
if [[ -n $sign_key ]]; then
  if [[ -f $sign_key ]]; then
    ssh-keygen -Y sign -n gnome-release -f "$sign_key" "$out/SHA256SUMS" > /dev/null
  else
    gpg --batch --yes --local-user "$sign_key" --detach-sign --output "$out/SHA256SUMS.sig" "$out/SHA256SUMS"
  fi
  log "signed: $out/SHA256SUMS.sig"
fi
log "done: $build_id"
