#!/usr/bin/env bash
# fetch-build.sh: fetch the HolyWisp commit pinned in VERSION, verify it, then build it and run
# upstream's test suite inside Docker. Binaries land in services/holywisp/build/<arch>/.
#
# Nothing from the HolyWisp repository runs on the host: git fetches objects into a bare cache
# repository, `git archive` exports the pinned tree, and every compile and test step runs in the
# Dockerfile's build stages with the source bind-mounted read-only and --network=none.
# Safe to re-run: the cache is reused, Docker's layer cache skips unchanged steps, and each
# build/<arch>/ directory is replaced only after its build and tests succeeded.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROG=fetch-build.sh

usage() {
  cat <<EOF
usage: $PROG [--arch LIST] [--image [TAG]] [--no-cache] [-h]

Fetch, verify, build and test the HolyWisp commit pinned in services/holywisp/VERSION.

  --arch LIST     comma-separated: x86_64 (amd64), aarch64 (arm64), or all.
                  Default: this machine's architecture ($(uname -m)).
  --image [TAG]   also build the FROM scratch runtime image for the same architectures and load it
                  into Docker (default tag gnome-holywisp:<version>-<commit7>)
  --no-cache      rebuild every Docker layer and re-run the tests even when nothing changed
  -h, --help      this text

Outputs, per architecture, in services/holywisp/build/<arch>/:
  holywisp, holywisp-client   stripped static-pie binaries
  LICENSE, LICENSE.musl       HolyWisp (ISC) and statically linked musl (MIT): ship them with the binaries
  BUILDINFO, SHA256SUMS       provenance and checksums
  test-results.log            upstream ctest output (16 suites; cross builds run under QEMU)
  build.log                   full docker build log

Environment:
  HOLYWISP_CACHE_DIR   git cache and source export (default \${XDG_CACHE_HOME:-~/.cache}/gnome/holywisp)
  HOLYWISP_GIT_URL     fetch from this URL instead of VERSION's HOLYWISP_REPO (a mirror); the pinned
                       commit and tree hashes are still verified
  HOLYWISP_OUT_DIR     output root instead of services/holywisp/build
EOF
}

log() { printf '%s: %s\n' "$PROG" "$*" >&2; }
die() {
  printf '%s: error: %s\n' "$PROG" "$*" >&2
  exit 1
}

# ------------------------------------------------------------------------------------ arguments
ARCH_ARG=""
IMAGE_TAG=""
WANT_IMAGE=0
NO_CACHE=()
while (($#)); do
  case $1 in
  --arch)
    (($# >= 2)) || die "--arch needs a value"
    ARCH_ARG=$2
    shift 2
    ;;
  --arch=*)
    ARCH_ARG=${1#--arch=}
    shift
    ;;
  --image)
    WANT_IMAGE=1
    if (($# >= 2)) && [[ $2 != -* ]]; then
      IMAGE_TAG=$2
      shift
    fi
    shift
    ;;
  --image=*)
    WANT_IMAGE=1
    IMAGE_TAG=${1#--image=}
    shift
    ;;
  --no-cache)
    NO_CACHE=(--no-cache)
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
  esac
done

normalize_arch() {
  case $1 in
  x86_64 | amd64) echo x86_64 ;;
  aarch64 | arm64) echo aarch64 ;;
  *) return 1 ;;
  esac
}
platform_of() {
  case $1 in
  x86_64) echo linux/amd64 ;;
  aarch64) echo linux/arm64 ;;
  esac
}
elf_machine_of() { # e_machine, little-endian u16 at offset 18 of the ELF header
  case $1 in
  x86_64) echo 62 ;;   # EM_X86_64
  aarch64) echo 183 ;; # EM_AARCH64
  esac
}

ARCHES=()
if [[ -z $ARCH_ARG ]]; then
  host=$(normalize_arch "$(uname -m)") || die "no default build for this machine ($(uname -m)); pass --arch x86_64 or --arch aarch64"
  ARCHES=("$host")
elif [[ $ARCH_ARG == all ]]; then
  ARCHES=(x86_64 aarch64)
else
  IFS=, read -r -a requested <<<"$ARCH_ARG"
  for a in "${requested[@]}"; do
    n=$(normalize_arch "$a") || die "unsupported architecture '$a' (GNOME builds x86_64/amd64 and aarch64/arm64)"
    [[ " ${ARCHES[*]-} " == *" $n "* ]] || ARCHES+=("$n")
  done
fi
((${#ARCHES[@]})) || die "no architecture selected"

# ------------------------------------------------------------------------------- the pin (VERSION)
REPO="" COMMIT="" TREE="" VERSION=""
while IFS= read -r line || [[ -n $line ]]; do
  [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
  [[ $line =~ ^([A-Z_]+)=([A-Za-z0-9._:/+@-]*)$ ]] || die "VERSION: unexpected line: $line"
  case ${BASH_REMATCH[1]} in
  HOLYWISP_REPO) REPO=${BASH_REMATCH[2]} ;;
  HOLYWISP_COMMIT) COMMIT=${BASH_REMATCH[2]} ;;
  HOLYWISP_TREE) TREE=${BASH_REMATCH[2]} ;;
  HOLYWISP_VERSION) VERSION=${BASH_REMATCH[2]} ;;
  esac
done <"$HERE/VERSION"
[[ $COMMIT =~ ^[0-9a-f]{40}$ ]] || die "VERSION: HOLYWISP_COMMIT must be a full 40-character commit hash"
[[ $TREE =~ ^[0-9a-f]{40}$ ]] || die "VERSION: HOLYWISP_TREE must be a full 40-character tree hash"
[[ -n $REPO && -n $VERSION ]] || die "VERSION: HOLYWISP_REPO and HOLYWISP_VERSION are required"

docker_arg() { sed -n "s/^ARG $1=//p" "$HERE/Dockerfile" | head -n 1; }
df_commit=$(docker_arg HOLYWISP_COMMIT)
[[ $df_commit == "$COMMIT" ]] ||
  die "Dockerfile pins HOLYWISP_COMMIT=${df_commit:-<none>} but VERSION pins $COMMIT; update both together"
ALPINE_IMAGE=$(docker_arg ALPINE_IMAGE)
[[ -n $ALPINE_IMAGE ]] || die "Dockerfile: ARG ALPINE_IMAGE not found"

SHORT=${COMMIT:0:7}
[[ -n $IMAGE_TAG ]] || IMAGE_TAG="gnome-holywisp:$VERSION-$SHORT"
GIT_URL=${HOLYWISP_GIT_URL:-$REPO}
CACHE_DIR=${HOLYWISP_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/gnome/holywisp}
OUT_ROOT=${HOLYWISP_OUT_DIR:-$HERE/build}

# --------------------------------------------------------------------------------- prerequisites
command -v git >/dev/null || die "git is required"
command -v docker >/dev/null || die "docker is required"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running, and may this user use it?)"
docker buildx version >/dev/null 2>&1 || die "docker buildx (BuildKit) is required"

mkdir -p "$CACHE_DIR" "$OUT_ROOT"
if command -v flock >/dev/null; then
  exec 9>"$CACHE_DIR/.lock"
  flock -n 9 || {
    log "another $PROG is using $CACHE_DIR; waiting"
    flock 9
  }
fi

# ----------------------------------------------------------------------------- fetch and verify
GIT_DIR_CACHE=$CACHE_DIR/holyWisp.git
git_c() { git -C "$GIT_DIR_CACHE" -c core.hooksPath=/dev/null "$@"; }

if [[ ! -d $GIT_DIR_CACHE ]]; then
  git init --quiet --bare "$GIT_DIR_CACHE.tmp.$$"
  mv "$GIT_DIR_CACHE.tmp.$$" "$GIT_DIR_CACHE"
fi
if git_c cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  log "commit $SHORT already in $GIT_DIR_CACHE"
else
  log "fetching $COMMIT from $GIT_URL"
  if ! git_c fetch --quiet --no-tags --depth=1 "$GIT_URL" "$COMMIT" 2>"$CACHE_DIR/fetch.err"; then
    # Servers that refuse fetching a commit by hash: fetch the branches and look for it there.
    log "fetch by hash refused ($(head -n 1 "$CACHE_DIR/fetch.err")); fetching all branches"
    git_c fetch --quiet --no-tags "$GIT_URL" '+refs/heads/*:refs/remotes/origin/*' ||
      die "cannot fetch $GIT_URL (network down, or set HOLYWISP_GIT_URL to a mirror)"
  fi
  git_c cat-file -e "$COMMIT^{commit}" 2>/dev/null ||
    die "commit $COMMIT is not in $GIT_URL (pin rewritten upstream? use a mirror that has it)"
fi
git_c update-ref refs/gnome/pinned "$COMMIT" # keeps the commit across `git gc`
actual_tree=$(git_c rev-parse "$COMMIT^{tree}")
[[ $actual_tree == "$TREE" ]] ||
  die "commit $COMMIT has tree $actual_tree, VERSION expects $TREE: refusing to build"
log "verified: commit $COMMIT, tree $TREE"

# Export the exact tree (not a working copy anyone could have edited) and make it read-only.
SRC_DIR=$CACHE_DIR/src-$COMMIT
tmp_src=$SRC_DIR.tmp.$$
remove_tree() { if [[ -e $1 ]]; then chmod -R u+w -- "$1" && rm -rf -- "$1"; fi; }
cleanup() {
  remove_tree "$tmp_src"
  [[ -z ${tmp_out-} ]] || remove_tree "$tmp_out"
}
trap cleanup EXIT
mkdir -p "$tmp_src"
git_c archive --format=tar "$COMMIT" | tar -x -f - -C "$tmp_src"
[[ -f $tmp_src/LICENSE && -f $tmp_src/CMakeLists.txt ]] || die "export of $COMMIT looks incomplete"
[[ ! -e $tmp_src/.dockerignore ]] || die "upstream tree has a .dockerignore; review it before building (it would filter the build context)"
chmod -R a-w "$tmp_src"
remove_tree "$SRC_DIR"
mv "$tmp_src" "$SRC_DIR"

# ---------------------------------------------------------------------------- build, test, export
build_one() {
  local arch=$1 platform log_file
  platform=$(platform_of "$arch")
  tmp_out=$OUT_ROOT/.$arch.tmp.$$
  log_file=$OUT_ROOT/.$arch.build.log
  remove_tree "$tmp_out"
  log "building $platform (compile + upstream tests inside Docker; log: $log_file)"
  if ! docker buildx build --progress=plain "${NO_CACHE[@]}" \
    --platform "$platform" \
    --build-context "holywisp-src=$SRC_DIR" \
    --build-arg "HOLYWISP_REPO=$REPO" --build-arg "HOLYWISP_COMMIT=$COMMIT" \
    --target artifacts --output "type=local,dest=$tmp_out" \
    -f "$HERE/Dockerfile" "$HERE" >"$log_file" 2>&1; then
    grep -E '^#[0-9]+ [0-9.]+ ' "$log_file" | tail -n 40 >&2 || tail -n 40 "$log_file" >&2
    die "$platform: docker build failed (compile or upstream tests); full log: $log_file"
  fi

  local f
  for f in holywisp holywisp-client LICENSE LICENSE.musl SHA256SUMS BUILDINFO test-results.log; do
    [[ -s $tmp_out/$f ]] || die "$platform: build produced no $f"
  done
  (cd "$tmp_out" && sha256sum --check --quiet SHA256SUMS) || die "$platform: checksum mismatch in the exported binaries"
  grep -Eq '^100% tests passed, 0 tests failed out of [1-9][0-9]*$' "$tmp_out/test-results.log" ||
    die "$platform: upstream tests did not all pass (see $tmp_out/test-results.log)"
  for f in holywisp holywisp-client; do
    local magic machine
    magic=$(od -An -tx1 -N4 "$tmp_out/$f" | tr -d ' \n')
    machine=$(od -An -tu2 -j18 -N2 --endian=little "$tmp_out/$f" | tr -d ' \n')
    [[ $magic == 7f454c46 && $machine == "$(elf_machine_of "$arch")" ]] ||
      die "$platform: $f is not an ELF binary for $arch"
  done
  mv "$log_file" "$tmp_out/build.log"
  # BuildKit's local exporter creates the directory 0700; containers running as another UID (and
  # other users) must be able to read the binaries.
  chmod 0755 "$tmp_out" "$tmp_out/holywisp" "$tmp_out/holywisp-client"
  chmod 0644 "$tmp_out/LICENSE" "$tmp_out/LICENSE.musl" "$tmp_out/SHA256SUMS" "$tmp_out/BUILDINFO" "$tmp_out/test-results.log" "$tmp_out/build.log"
  remove_tree "$OUT_ROOT/$arch"
  mv "$tmp_out" "$OUT_ROOT/$arch"
  tmp_out=""
}

for arch in "${ARCHES[@]}"; do
  build_one "$arch"
done

# Prove the native binary starts, in a locked-down container (never on the host).
native=$(normalize_arch "$(uname -m)" || true)
for arch in "${ARCHES[@]}"; do
  [[ $arch == "$native" ]] || continue
  out=$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user 65534:65534 -v "$OUT_ROOT/$arch:/opt/holywisp:ro" --entrypoint /opt/holywisp/holywisp \
    "$ALPINE_IMAGE" --version 2>&1) || die "$arch: holywisp --version failed in a container: $out"
  [[ $out == "holywisp $VERSION+$SHORT" ]] || die "$arch: unexpected version output: $out"
  log "$arch: '$out' runs (container, no network, UID 65534)"
done

if ((WANT_IMAGE)); then
  platforms=()
  for arch in "${ARCHES[@]}"; do platforms+=("$(platform_of "$arch")"); done
  platform_list=$(
    IFS=,
    echo "${platforms[*]}"
  )
  log "building runtime image $IMAGE_TAG for $platform_list"
  img_log=$OUT_ROOT/image.build.log
  if ! docker buildx build --progress=plain "${NO_CACHE[@]}" \
    --platform "$platform_list" \
    --build-context "holywisp-src=$SRC_DIR" \
    --build-arg "HOLYWISP_REPO=$REPO" --build-arg "HOLYWISP_COMMIT=$COMMIT" \
    --target runtime --load -t "$IMAGE_TAG" \
    -f "$HERE/Dockerfile" "$HERE" >"$img_log" 2>&1; then
    tail -n 30 "$img_log" >&2
    die "image build failed; full log: $img_log (loading several platforms at once needs Docker's containerd image store)"
  fi
  log "loaded image $IMAGE_TAG ($platform_list)"
fi

# -------------------------------------------------------------------------------------- summary
printf '\nHolyWisp %s (%s), source verified, built and tested in Docker:\n' "$VERSION" "$SHORT"
for arch in "${ARCHES[@]}"; do
  d=$OUT_ROOT/$arch
  printf '  %-8s holywisp %s B, holywisp-client %s B, %s\n' "$arch" \
    "$(stat -c %s "$d/holywisp")" "$(stat -c %s "$d/holywisp-client")" \
    "$(grep -E '^100% tests passed' "$d/test-results.log")"
  printf '           %s\n' "$d"
done
