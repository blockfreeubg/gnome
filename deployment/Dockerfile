# syntax=docker/dockerfile:1
#
# gnome-server image (WAVE-D §5.1, D14): the release frontend built once on the build platform, gnome-server
# cross-compiled per target as a static musl binary with clang through tonistiigi/xx (no binfmt, no QEMU
# registration: arm64 binaries run only under a directly invoked qemu-aarch64 inside the build stage), and a
# FROM-scratch runtime with no shell, package manager or CA bundle.
#
# Build context: the repository root, filtered by deployment/Dockerfile.dockerignore.
#
#   docker buildx build -f deployment/Dockerfile --platform linux/amd64 --build-arg CARGO_BUILD_JOBS=3 -t gnome-server:dev --load .
#   docker buildx build -f deployment/Dockerfile --platform linux/arm64 --target server-out --output type=local,dest=out/ .
#
# Targets: runtime (default) · server-out (/gnome-server + /BUILDINFO, what scripts/release.sh exports) ·
# licenses-out (the licenses bundle of that architecture) · frontend-out (the release dist/) · release-out (all three).

# Base images, pinned by multi-arch index digest.
ARG XX_IMAGE=tonistiigi/xx:1.10.0@sha256:40fe21f44bb8cddf1eb1226db190d0a984118f62ee02a91b77d99448d28264a6
ARG NODE_IMAGE=node:26-alpine3.22@sha256:c7932b9e5e337b0e733d6e16abc1b0e104759e8b05e59ed56586cce967d26dfe
ARG RUST_IMAGE=rust:1.99-alpine3.22@sha256:9a744dc47d1ac2a7d17fc3cedfc8b4928b1696dfcba3274ab25bfb40988a9ff0

# ---- build arguments (scripts/release.sh passes all of them) ----------------------------------------------------
ARG GNOME_BUILD_ID=unknown
ARG SOURCE_DATE_EPOCH=0
ARG GNOME_DEFAULT_SOURCE_URL=
ARG GNOME_THIRD_PARTY_SOURCE_URL=
ARG GNOME_REPOSITORY_URL=
ARG CARGO_BUILD_JOBS=3

FROM --platform=$BUILDPLATFORM ${XX_IMAGE} AS xx

# ---- frontend: built once, shared by every target architecture --------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY frontend/ ./
COPY scripts/ /src/scripts/
COPY LICENSE /src/LICENSE
ARG GNOME_BUILD_ID
ARG SOURCE_DATE_EPOCH
RUN --network=none umask 022 && export GNOME_BUILD_ID SOURCE_DATE_EPOCH \
 && npm run build && node scripts/postbuild.mjs --release

FROM scratch AS frontend-out
COPY --from=frontend /src/frontend/dist/ /

# ---- rust: static musl gnome-server per target ----------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${RUST_IMAGE} AS rust
COPY --from=xx / /
# Pinned Alpine 3.22 packages (a drift fails the build; scripts/release.sh compares BUILDINFO with these).
ARG APK_PINS="clang20=20.1.8-r0 lld20=20.1.8-r0 file=5.46-r2"
ARG XX_APK_PINS="musl-dev=1.2.5-r13 gcc=14.2.0-r6"
ARG TARGETPLATFORM
ARG TARGETARCH
RUN apk add --no-cache ${APK_PINS} \
 && { command -v clang >/dev/null || ln -s /usr/lib/llvm20/bin/clang /usr/local/bin/clang; } \
 && { command -v ld.lld >/dev/null || ln -s /usr/lib/llvm20/bin/ld.lld /usr/local/bin/ld.lld; }
RUN xx-apk add --no-cache ${XX_APK_PINS}
RUN <<'EOS'
set -eu
case "$TARGETARCH" in
  amd64|arm64) ;;
  *) echo "GNOME builds gnome-server for linux/amd64 and linux/arm64, not $TARGETPLATFORM" >&2; exit 1 ;;
esac
xx-clang --setup-target-triple
rustup target add "$(xx-cargo --print-target-triple)"
# Cross-built binaries are static, so QEMU user-mode runs them without binfmt (invoked directly below).
if xx-info is-cross; then apk add --no-cache "qemu-$(xx-info march)=10.0.0-r1"; fi
EOS
WORKDIR /src
ENV CARGO_HOME=/cargo
COPY Cargo.toml Cargo.lock ./
COPY backend/ backend/
COPY crates/ crates/
COPY database/ database/
COPY scripts/licenses/ scripts/licenses/
# services/vpn/profiles.example.toml is read only by a unit test; the release build does not need it.
RUN cargo fetch --locked
ARG GNOME_BUILD_ID
ARG SOURCE_DATE_EPOCH
ARG GNOME_DEFAULT_SOURCE_URL
ARG CARGO_BUILD_JOBS
ARG CARGO_FEATURES=
RUN --network=none <<'EOS'
set -eu
triple=$(xx-cargo --print-target-triple)
export GNOME_BUILD_ID SOURCE_DATE_EPOCH GNOME_DEFAULT_SOURCE_URL CARGO_BUILD_JOBS
# Build paths out of the binary (D5): the source tree, the registry and the toolchain.
# rustc applies the last matching flag, so the specific registry prefix comes after /cargo.
remap="--remap-path-prefix=/cargo=/cargo-home --remap-path-prefix=/src=/gnome --remap-path-prefix=$(rustc --print sysroot)=/rustc"
for d in /cargo/registry/src/*/; do remap="$remap --remap-path-prefix=${d%/}=/crates"; done
export RUSTFLAGS="$remap -C target-feature=+crt-static"
features=""
if [ -n "${CARGO_FEATURES}" ]; then features="--features ${CARGO_FEATURES}"; fi
# shellcheck disable=SC2086
xx-cargo build --release --locked --offline -p gnome-server ${features}
mkdir -p /out
cp "target/${triple}/release/gnome-server" /out/gnome-server
xx-verify --static /out/gnome-server
if xx-info is-cross; then "qemu-$(xx-info march)" /out/gnome-server version; else /out/gnome-server version; fi
# musl's COPYRIGHT for the static binary; an Alpine musl update fails here until its text is vendored.
musl=$(awk '/^P:musl$/ {p = 1} p && /^V:/ {print substr($0, 3); exit}' "$(xx-info sysroot)lib/apk/db/installed")
notice=/src/scripts/licenses/musl-${musl%-r*}.COPYRIGHT
[ -f "$notice" ] || { echo "no vendored COPYRIGHT for musl $musl ($notice)" >&2; exit 1; }
mkdir -p /meta/crate-src /meta/rust-std
cp "$notice" /meta/LICENSE.musl
cargo metadata --format-version 1 --locked --offline --filter-platform "$triple" > /meta/cargo-metadata.json
for d in /cargo/registry/src/*/*/; do
  n=$(basename "$d"); mkdir -p "/meta/crate-src/$n"
  for f in "$d"LICEN[CS]E* "$d"COPYING* "$d"NOTICE* "$d"UNLICENSE*; do [ -f "$f" ] && cp "$f" "/meta/crate-src/$n/"; done
done
doc=$(rustc --print sysroot)/share/doc/rust
cp "$doc/licenses/MIT.txt" "$doc/licenses/Apache-2.0.txt" /meta/rust-std/
rustc --version > /meta/rust-std/VERSION
cat > /out/BUILDINFO <<EOF
gnome-server ${GNOME_BUILD_ID}
target:            ${triple} ($TARGETPLATFORM), static musl ${musl}
rustc:             $(rustc --version)
cargo:             $(cargo --version)
SOURCE_DATE_EPOCH: ${SOURCE_DATE_EPOCH}
RUSTFLAGS:         ${RUSTFLAGS}
CARGO_FEATURES:    ${CARGO_FEATURES}
default source:    ${GNOME_DEFAULT_SOURCE_URL}
apk (build):       $(apk info -v 2>/dev/null | grep -E '^(clang20|lld20|file)-[0-9]' | sort | tr '\n' ' ')
apk (target):      $(xx-apk info -v 2>/dev/null | grep -E '^(musl-dev|gcc|musl)-[0-9]' | sort | tr '\n' ' ')
EOF
EOS

FROM scratch AS server-out
COPY --from=rust /out/gnome-server /gnome-server
COPY --from=rust /out/BUILDINFO /BUILDINFO

# ---- licenses: the bundle of WAVE-D §4.4 for this architecture ---------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS licenses
COPY --from=frontend /src/frontend/ /src/frontend/
COPY --from=frontend /src/scripts/ /src/scripts/
COPY --from=frontend /src/LICENSE /src/LICENSE
COPY --from=rust /meta/ /meta/
ARG TARGETARCH
ARG GNOME_DEFAULT_SOURCE_URL
RUN --network=none <<'EOS'
set -eu
case "$TARGETARCH" in amd64) triple=x86_64-unknown-linux-musl ;; arm64) triple=aarch64-unknown-linux-musl ;; esac
node /src/scripts/third-party-licenses.mjs --target "$triple" --dist /src/frontend/dist --out /out \
  --cargo-metadata /meta/cargo-metadata.json --crate-src /meta/crate-src --rust-std /meta/rust-std \
  --musl /meta/LICENSE.musl --source-url "${GNOME_DEFAULT_SOURCE_URL}"
EOS

FROM scratch AS licenses-out
COPY --from=licenses /out/ /

# Everything scripts/release.sh needs from one build per architecture.
FROM scratch AS release-out
COPY --from=rust /out/ /server/
COPY --from=licenses /out/ /licenses/
COPY --from=frontend /src/frontend/dist/ /dist/

# ---- runtime -----------------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS skel
RUN mkdir -p /skel/tmp /skel/var/lib/gnome && chmod 1777 /skel/tmp && chmod 0700 /skel/var/lib/gnome \
 && chown 65532:65532 /skel/var/lib/gnome

FROM scratch AS runtime
ARG GNOME_BUILD_ID
ARG GNOME_DEFAULT_SOURCE_URL
ARG GNOME_THIRD_PARTY_SOURCE_URL
ARG GNOME_REPOSITORY_URL
COPY --from=skel /skel/ /
COPY --from=rust /out/gnome-server /usr/local/bin/gnome-server
COPY --from=frontend /src/frontend/dist/ /usr/share/gnome/dist/
COPY --from=licenses /out/ /usr/share/licenses/gnome/
ENV GNOME_DATA_DIR=/var/lib/gnome \
    GNOME_STATIC_DIR=/usr/share/gnome/dist \
    GNOME_BIND=0.0.0.0:8080 \
    GNOME_LOG_FORMAT=json
LABEL org.opencontainers.image.title="gnome-server" \
      org.opencontainers.image.version="${GNOME_BUILD_ID}" \
      org.opencontainers.image.revision="${GNOME_BUILD_ID}" \
      org.opencontainers.image.source="${GNOME_REPOSITORY_URL}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      io.gnome.source-archive="${GNOME_DEFAULT_SOURCE_URL}" \
      io.gnome.third-party-source-archive="${GNOME_THIRD_PARTY_SOURCE_URL}"
VOLUME ["/var/lib/gnome"]
USER 65532:65532
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/usr/local/bin/gnome-server", "health"]
ENTRYPOINT ["/usr/local/bin/gnome-server"]
CMD ["serve"]
