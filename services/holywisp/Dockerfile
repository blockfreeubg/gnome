# syntax=docker/dockerfile:1
#
# HolyWisp for GNOME: the upstream commit pinned in VERSION, built as a static (static-pie) musl
# binary, tested with upstream's own suite, and shipped in a FROM scratch image with gnome.conf.
#
#   docker buildx build --platform linux/amd64 -t gnome-holywisp services/holywisp
#   docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/gnome-holywisp --push services/holywisp
#   services/holywisp/fetch-build.sh       # same build from a verified local clone; binaries in build/<arch>/
#
# The toolchain stage runs on the build machine's platform and cross-compiles with clang
# (tonistiigi/xx), so a linux/arm64 image builds on an amd64 host without QEMU binfmt emulation.
# Cross-built test binaries run under QEMU user-mode inside the build container.
# Compilation and tests run with --network=none and the source bind-mounted read-only.

# Base images, pinned by digest (multi-arch index digests).
ARG ALPINE_IMAGE=alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
ARG XX_IMAGE=tonistiigi/xx:1.10.0@sha256:40fe21f44bb8cddf1eb1226db190d0a984118f62ee02a91b77d99448d28264a6

# Keep in sync with VERSION; fetch-build.sh refuses to build when they differ.
ARG HOLYWISP_REPO=https://github.com/Fracital/holyWisp.git
ARG HOLYWISP_COMMIT=e0a0f159eb6a168cbf67a7628687f9b244cbab48

# ---- source -------------------------------------------------------------------------------------
# A plain `docker build` fetches the pinned commit here. fetch-build.sh replaces this stage with its
# own verified export (`--build-context holywisp-src=<dir>`), so its builds never fetch anything.
FROM scratch AS holywisp-src
ARG HOLYWISP_REPO
ARG HOLYWISP_COMMIT
ADD --keep-git-dir=false ${HOLYWISP_REPO}#${HOLYWISP_COMMIT} /

FROM --platform=$BUILDPLATFORM ${XX_IMAGE} AS xx

# ---- toolchain ----------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${ALPINE_IMAGE} AS toolchain
COPY --from=xx / /
RUN apk add --no-cache bash clang lld llvm cmake ninja-build file
ARG TARGETPLATFORM
ARG TARGETARCH
# Target sysroot (the build root itself for native builds): musl libc and crt files, libgcc for the
# static link, kernel headers, and fortify-headers for _FORTIFY_SOURCE on musl.
RUN xx-apk add --no-cache musl-dev gcc linux-headers fortify-headers
RUN <<'EOS'
#!/bin/bash
set -euo pipefail
case "$TARGETARCH" in
  amd64|arm64) ;;
  *) echo "GNOME builds HolyWisp for linux/amd64 and linux/arm64, not $TARGETPLATFORM" >&2; exit 1 ;;
esac
xx-clang --setup-target-triple
# Cross-built test binaries are static, so QEMU user-mode runs them without a sysroot or binfmt.
if xx-info is-cross; then apk add --no-cache "qemu-$(xx-info march)"; fi
EOS

# ---- build --------------------------------------------------------------------------------------
FROM toolchain AS build
ARG HOLYWISP_COMMIT
RUN --network=none --mount=type=bind,from=holywisp-src,target=/src \
    --mount=type=bind,source=licenses,target=/licenses <<'EOS'
#!/bin/bash
set -euo pipefail
short=${HOLYWISP_COMMIT:0:7}
# Upstream's Release flags (-O2, its warning set with -Werror) plus hardening: stack protector and
# stack-clash protection, FORTIFY, static-pie (ASLR for a static binary), full RELRO, no exec stack.
cflags="-fstack-protector-strong -fstack-clash-protection -D_FORTIFY_SOURCE=2"
ldflags="-static-pie -Wl,-z,relro,-z,now -Wl,-z,noexecstack"
cross=()
if xx-info is-cross; then
  cross=(-DCMAKE_SYSTEM_NAME=Linux "-DCMAKE_SYSTEM_PROCESSOR=$(xx-info march)"
         "-DCMAKE_CROSSCOMPILING_EMULATOR=/usr/bin/qemu-$(xx-info march)")
fi
# shellcheck disable=SC2046  # xx prints several -D flags on purpose
# Alpine's ninja-build package installs ninja outside PATH.
cmake -S /src -B /build --no-warn-unused-cli -G Ninja -DCMAKE_MAKE_PROGRAM=/usr/lib/ninja-build/bin/ninja \
  $(xx-clang --print-cmake-defines) "${cross[@]}" \
  -DCMAKE_AR=/usr/bin/llvm-ar -DCMAKE_RANLIB=/usr/bin/llvm-ranlib \
  -DCMAKE_BUILD_TYPE=Release -DHW_WERROR=ON -DHW_SANITIZE=OFF -DHW_BUILD_TESTS=ON \
  "-DHW_VERSION_SUFFIX=+$short" \
  "-DCMAKE_C_FLAGS=$cflags" "-DCMAKE_EXE_LINKER_FLAGS=$ldflags"
cmake --build /build --parallel
mkdir -p /out
for b in holywisp holywisp-client; do
  llvm-strip --strip-all -o "/out/$b" "/build/$b"
  xx-verify --static "/out/$b"
done
cp /src/LICENSE /out/LICENSE
(cd /out && sha256sum holywisp holywisp-client > SHA256SUMS)
musl=$(awk '/^P:musl$/ {p = 1} p && /^V:/ {print substr($0, 3); exit}' "$(xx-info sysroot)lib/apk/db/installed")
# musl (MIT) is linked into both binaries, so its notice ships with them. The text is vendored per
# release (licenses/); a musl update in Alpine fails here until its COPYRIGHT is added.
notice=/licenses/musl-${musl%-r*}.COPYRIGHT
[[ -f $notice ]] || { echo "no $notice for the linked musl $musl: add it (README.md, section 'Upstream pin and license')" >&2; exit 1; }
cp "$notice" /out/LICENSE.musl
version=$(sed -n 's/^#define HW_VERSION "\(.*\)"$/\1/p' /src/include/holywisp/hw.h)
cat > /out/BUILDINFO <<EOF
project:  holyWisp https://github.com/Fracital/holyWisp (license ISC, see LICENSE; statically
          linked musl libc: MIT, see LICENSE.musl)
commit:   $HOLYWISP_COMMIT
version:  holywisp $version+$short
target:   $(xx-info triple) ($TARGETPLATFORM), static-pie
builder:  $(clang --version | head -n 1), cmake $(cmake --version | sed -n 's/^cmake version //p'), Alpine $(cat /etc/alpine-release), musl $musl
cflags:   -O2 (upstream Release) $cflags
ldflags:  $ldflags
built by: GNOME services/holywisp/Dockerfile
EOF
cat /out/BUILDINFO /out/SHA256SUMS
file /out/holywisp /out/holywisp-client
EOS

# ---- test: upstream's 16 suites against the release build (unit, e2e, security, flow control) ----
FROM build AS test
RUN --network=none --mount=type=bind,from=holywisp-src,target=/src <<'EOS'
#!/bin/bash
set -euo pipefail
# test_config runs in /src (it loads upstream's shipped configs); nothing writes to the source tree.
ctest --test-dir /build --output-on-failure --no-tests=error -j "$(nproc)" 2>&1 | tee /out/test-results.log
EOS

# ---- artifacts: what fetch-build.sh exports to build/<arch>/ (only reachable when the tests pass) -
FROM scratch AS artifacts
COPY --from=test /out/ /

# ---- runtime image (default target) -------------------------------------------------------------
FROM scratch AS runtime
ARG HOLYWISP_COMMIT
LABEL org.opencontainers.image.title="gnome-holywisp" \
      org.opencontainers.image.description="HolyWisp Wisp server (static musl build of the commit GNOME pins) with GNOME's hardened config" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.revision="${HOLYWISP_COMMIT}" \
      org.opencontainers.image.source="https://github.com/Fracital/holyWisp" \
      org.opencontainers.image.licenses="ISC AND MIT AND AGPL-3.0-only"
COPY --from=test /out/holywisp /usr/local/bin/holywisp
COPY --from=test /out/LICENSE /usr/share/licenses/holywisp/LICENSE
COPY --from=test /out/LICENSE.musl /usr/share/licenses/musl/COPYRIGHT
COPY gnome.conf /etc/holywisp/holywisp.conf
USER 65534:65534
EXPOSE 6001
# The config binds 127.0.0.1: share the gateway's network namespace, or run with
# `--host 0.0.0.0 --trusted-proxy <gateway ip>` appended (flags override the file). See README.md.
ENTRYPOINT ["/usr/local/bin/holywisp", "--config", "/etc/holywisp/holywisp.conf"]
