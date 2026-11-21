# HolyWisp for GNOME (`services/holywisp/`)

GNOME's primary [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) server. The proxy engines
(Scramjet, Ultraviolet) open TCP streams through a Wisp transport (libcurl or epoxy) in the user's
browser; `gnome-server`'s `/wisp/` gateway authenticates the WebSocket and splices it to HolyWisp on
`127.0.0.1:6001`, which opens the streams to the internet. TLS to destination sites is negotiated
inside the browser, so neither the gateway nor HolyWisp sees page contents of HTTPS sites.

```
browser ──wss://<proxy origin>/wisp/?t=<ticket>&/──▶ gnome-server gateway ──ws──▶ holywisp 127.0.0.1:6001 ──▶ internet
          (Origin + Wisp ticket + caps checked)       (headers rewritten, spliced)  (egress policy after DNS)
browser ──wss://<proxy origin>/wisp/p/<id>/?t=…&/──▶ gnome-server gateway ──ws──▶ holywisp@<id> 127.0.0.1:60xx ──SOCKS5──▶ VPN relay
```

Why HolyWisp: a C11 server with no third-party dependencies, a ~230 KB static binary and a few MiB of
memory (it fits a Raspberry Pi 4), the leader of upstream's own benchmark in its multi-connection
scenarios (upstream's numbers, not re-measured here), Wisp v1 and v2 on one port, an egress policy
that is applied to every resolved address (loopback, RFC 1918, CGNAT, link-local/metadata, reserved
and wrapped-IPv4 ranges are refused), and an upstream SOCKS5/HTTP proxy for the VPN egress instances.
GNOME keeps authentication, Origin checks, per-user caps and quotas in the Rust gateway; HolyWisp
only relays and enforces egress.
Research: `docs/research/holywisp.md`; architecture: `docs/ARCHITECTURE.md` §4.4 and §7.

## Files

| Path | What |
| --- | --- |
| `VERSION` | the pin: upstream repo, commit, tree hash, version, license (parsed by `fetch-build.sh`) |
| `Dockerfile` | static musl build of the pinned commit, upstream test suite, `FROM scratch` runtime image |
| `fetch-build.sh` | fetch + verify the pin, build and test inside Docker, export `build/<arch>/` |
| `gnome.conf` | the hardened config (installed as `/etc/holywisp/holywisp.conf`, baked into the image) |
| `vpn-egress.conf.example` | overlay for one VPN exit location (`/etc/holywisp/egress/<id>.conf`) |
| `holywisp.service`, `holywisp@.service` | hardened systemd units: direct egress; one instance per VPN location |
| `check-egress.sh` | refuses egress overlays HolyWisp would start with but that leak or bypass the VPN (`holywisp@.service`'s `ExecStartPre`) |
| `licenses/` | license texts of code linked into the binaries that are not in the HolyWisp tree (musl) |
| `tests/smoke.sh` | black-box policy and lifecycle checks of a build (87 checks) |
| `tests/syscalls.sh` | checks the units' sandbox against a traced HolyWisp workload |
| `tests/socks5_stub.py` | local SOCKS5 stand-in for a VPN relay, used by `smoke.sh` |
| `build/` | outputs (gitignored) |

## Upstream pin and license

| | |
| --- | --- |
| Repository | https://github.com/Fracital/holyWisp |
| Commit | `e0a0f159eb6a168cbf67a7628687f9b244cbab48` (2026-11-07, "Add a benchmark harness ...") |
| Tree | `b3f0b497c3cde815e3a9125d8e7390d60df7bfcd` |
| Version | `holywisp 0.1.0`; GNOME's builds report `holywisp 0.1.0+e0a0f15` |
| License | **ISC**, "Copyright (c) 2026 David Reed" (`LICENSE`) |

This is the revision the research verified. Upstream has 8 newer commits (`fc9cd24` .. `9f75cc4`,
2026-11-09/10): a rewrite of the relay data path (per-stream splice pipes, new flow-control defaults of
128 MiB per stream and 256 MiB per client), macOS/Windows ports and an npm wrapper. None of them touches
the egress policy, header parsing or signal handling; SIGHUP still kills the server at HEAD. The one fix
relevant to GNOME's targets (32-bit builds rejecting two config keys) does not matter here: GNOME builds
amd64/arm64 only and `gnome.conf` never sets those keys. Re-evaluate the pin when the new data path has
settled (see "Updating the pin").

Licenses: upstream `README.md` and its RPM spec say "MIT"; the `LICENSE` file (ISC) is the operative
text. ISC requires the copyright and permission notice to accompany copies, so every build ships
`LICENSE` next to the binaries (`build/<arch>/LICENSE`, `/usr/share/licenses/holywisp/LICENSE` in the
image). The binaries statically link **musl libc (MIT)**; its notice is vendored verbatim in
`licenses/musl-1.2.5.COPYRIGHT` (identical in musl's `v1.2.5` git tag and in the release tarball,
sha256 `a9a118bb...75e4`) and shipped as `LICENSE.musl` / `/usr/share/licenses/musl/COPYRIGHT`. The
build fails if Alpine ever links another musl release until its COPYRIGHT is added here. Also linked:
fortify-headers (0BSD) and libgcc (GCC Runtime Library Exception); neither requires a notice. The build
tools (Alpine 3.22, clang 20, tonistiigi/xx 1.10.0) are not shipped. GNOME's own files in this directory
are AGPL-3.0-only, like the rest of GNOME.

## Build

```sh
services/holywisp/fetch-build.sh                 # this machine's architecture
services/holywisp/fetch-build.sh --arch all      # x86_64 and aarch64
services/holywisp/fetch-build.sh --arch all --image        # also load gnome-holywisp:0.1.0-e0a0f15
services/holywisp/fetch-build.sh --no-cache      # rebuild every layer and re-run the tests
```

What it does:

1. Parses `VERSION` (never executes it) and refuses to run if `Dockerfile`'s `ARG HOLYWISP_COMMIT`
   disagrees.
2. Fetches the commit by hash into a bare cache repository
   (`${XDG_CACHE_HOME:-~/.cache}/gnome/holywisp/holyWisp.git`), checks that it has the expected tree
   hash, and exports exactly that tree with `git archive` into a read-only directory. No HolyWisp code
   runs on the host; nothing is checked out.
3. Builds the Dockerfile's `artifacts` target with that export as the `holywisp-src` build context:
   compile with `-Werror`, then upstream's 16 test suites (`ctest`; unit, e2e, security, flow control),
   both with `--network=none` and the source bind-mounted read-only. Cross-compiled tests run under QEMU
   user-mode inside the build container.
4. Checks the exported files (checksums, ELF machine, `100% tests passed`), then replaces
   `build/<arch>/` and runs `holywisp --version` in a locked-down container.

Outputs in `build/<arch>/` (`x86_64`, `aarch64`): `holywisp`, `holywisp-client` (stripped static-pie
binaries), `LICENSE`, `LICENSE.musl`, `BUILDINFO` (commit, toolchain, flags), `SHA256SUMS`,
`test-results.log`, `build.log`. Re-running is safe: the git cache is reused, Docker's layer cache skips
unchanged steps, and `build/<arch>/` is only replaced after a successful build.
Environment: `HOLYWISP_CACHE_DIR` (cache location), `HOLYWISP_GIT_URL` (fetch from a mirror; the hashes
are still verified), `HOLYWISP_OUT_DIR` (output root). Requirements: Docker with BuildKit/buildx, git,
coreutils; network for the first fetch, the pinned base images and Alpine packages.

The Dockerfile also builds on its own, fetching the pinned commit itself
(`ADD https://github.com/Fracital/holyWisp.git#<commit>`); the result is byte-identical to the
`fetch-build.sh` build:

```sh
docker buildx build --platform linux/amd64 -t gnome-holywisp services/holywisp
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/gnome-holywisp:0.1.0-e0a0f15 --push services/holywisp
```

The toolchain stage runs on the build machine's platform and cross-compiles with clang (tonistiigi/xx),
so an arm64 image builds on an amd64 host without binfmt emulation. Flags: upstream's Release build
(`-O2`, its warning set, `-Werror`) plus `-fstack-protector-strong -fstack-clash-protection
-D_FORTIFY_SOURCE=2`, `-static-pie` (ASLR for a static binary), full RELRO and a non-executable stack.

| Build (e0a0f15) | `holywisp` | `holywisp-client` | upstream tests | runtime image (compressed) |
| --- | --- | --- | --- | --- |
| x86_64 | 229,096 B | 96,760 B | 16/16 | 142 kB |
| aarch64 | 247,344 B | 107,120 B | 16/16 under QEMU user-mode | 156 kB |

The aarch64 build has not run on arm64 hardware: its 16 test suites run under `qemu-aarch64` in the
build container (this host has neither arm64 hardware nor binfmt emulation to run it directly).
32-bit ARM (armhf) is not built: at this pin, 32-bit builds reject `ws-write-high-water` and
`stream-queue-max`.

## Run

`holywisp --config gnome.conf` listens on `127.0.0.1:6001`. Every config key is also a flag and flags
override the file (`--port 7000`, `--log-level info`). `holywisp-client` is a debugging client, e.g.:

```sh
printf 'GET / HTTP/1.0\r\nHost: example.org\r\n\r\n' | holywisp-client -v -s ws://127.0.0.1:6001/ example.org 80
holywisp-client -v -s ws://127.0.0.1:6001/ 169.254.169.254 80 </dev/null   # -> CLOSE host blocked (0x48)
```

**Docker** (`gnome-holywisp` image: `FROM scratch`, UID 65534, `EXPOSE 6001`, config at
`/etc/holywisp/holywisp.conf`, nothing written at runtime, so `--read-only` works):

- Same network namespace as the gateway (compose `network_mode: "service:gnome"`): use the image as is.
- Its own container on a private network: append `--host 0.0.0.0 --trusted-proxy <gateway IP>/32`
  (flags override the file) and point `GNOME_WISP_UPSTREAM` at it (`holywisp:6001`). Never publish
  6001 and attach nothing but the gateway to that network: the port has no authentication. Docker's
  ranges are "private", so the relay cannot reach other containers.
- Run with `--read-only --cap-drop ALL --security-opt no-new-privileges --ulimit nofile=65536:65536`
  (HolyWisp never raises its own fd limit; each WebSocket and each stream is a descriptor).
- Do **not** add `--init` / `init: true`: as PID 1 HolyWisp ignores a stray SIGHUP (no handler, and the
  kernel drops default-action signals to a namespace's init), while tini forwards SIGHUP and kills it.
- Health: `GET /health` on the Wisp port from the gateway side; the image has no shell or HTTP client.

**systemd** (static build, installed by hand):

```sh
install -m 0755 build/<arch>/holywisp /usr/local/bin/holywisp
install -D -m 0644 gnome.conf /etc/holywisp/holywisp.conf
install -m 0644 holywisp.service holywisp@.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now holywisp.service
curl -s http://127.0.0.1:6001/health        # {"status":"ok"}
```

Change the config, then `systemctl restart holywisp` (open Wisp connections drop; the transports
reconnect). `systemctl reload` is refused on purpose. Logs: `journalctl -u holywisp` (HolyWisp logs to
stderr only, `YYYY-MM-DDTHH:MM:SS.mmmZ [level] tag: message`). The units run HolyWisp as a dynamic UID
with no capabilities, `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, `ProtectProc=invisible`,
`MemoryDenyWriteExecute`, `RestrictAddressFamilies=AF_INET AF_INET6`, `@system-service` minus the
privileged/obsolete/mount/debug/raw-io/resources groups, `MemoryMax`, `Restart=always` with backoff
(not after exit 2, a config parse error). `systemd-analyze security` rates them 1.2 and 1.1 ("OK").
Optional defence in depth: the commented `IPAddressDeny=`/`IPAddressAllow=` lines in
`holywisp.service` also drop private and link-local destinations at the cgroup level. Keep the DNS
server reachable if you enable them (a resolver on the LAN, such as `192.168.1.1`, must be allowed
explicitly; `127.0.0.53` is covered by `localhost`).

**Raspberry Pi 4**: use the aarch64 build (static, so no glibc version constraints). `workers = 0`
already gives 4 there; consider `max-concurrent-connections = 2000` and `max-streams-per-conn = 256`.
`MemoryMax=1G` (512M per egress instance) is a ceiling, not a reservation. With reputation off
HolyWisp writes nothing to disk (no SD-card wear).

## The config keys GNOME relies on (`gnome.conf`)

| Key | Value | Why |
| --- | --- | --- |
| `host` / `port` | `127.0.0.1` / `6001` | no auth and no Origin check on the port: loopback only, behind the gateway |
| `trusted-proxy` | `127.0.0.1/32` | only the local gateway may state the client IP |
| `trusted-headers-reset` + `trusted-header` | `on` + `X-Forwarded-For` | drop the compiled-in `CF-Connecting-IP`, which a client could use to spoof its IP |
| `parse-real-ip` | `on` | per-IP limits and logs use the real client IP |
| `allow-private` / `allow-loopback` / `allow-link-local` | `off` | the SSRF boundary: LAN, this host, cloud metadata |
| `allow-direct-ip` | `on` | public IP literals work; the classes above still apply to literals |
| `block-port` | Fetch "bad ports" (82 ports) | no SMTP/SSH/IRC/SIP relaying; browsers never use them for the web |
| `allow-udp` | `off` | the browser transports are TCP-only |
| `enable-v2` | `on` | libcurl/epoxy speak v1, wisp-js and epoxy v2 mode speak v2 |
| `enable-twisp`, `password-*` | off / none | Twisp is a remote shell; transports cannot send Wisp passwords |
| `reputation` | `off` | it locks ordinary users out for hours; the gateway authenticates instead |
| `bandwidth-limit-kbps` | `0` | broken upstream; quotas live in the gateway |
| `serve-webclient`, `non-ws-response` | `off`, `""` | nothing but Wisp, `/health` and `/stats` on the port |
| `log-level` | `warn` | `info` logs refused destinations with client IPs, `debug` every stream |
| `connections-limit-per-ip`, `max-streams-per-conn`, `max-concurrent-connections`, `resolver-threads` | 200/10 s, 512, 10000, 8 | per-client and server-wide bounds |

Not set on purpose: `ws-write-high-water`, `stream-queue-max`, `max-message-size` (defaults; the first
two break 32-bit builds, a smaller third closes WebSockets with 1009), `dns-server` (system resolver).

## How the Rust gateway talks to HolyWisp (ARCHITECTURE §4.4)

`gnome-server` connects to `GNOME_WISP_UPSTREAM` (default `127.0.0.1:6001`; always an IP literal for
local instances, never `localhost`, which may resolve to `::1`) and writes a reconstructed upgrade:

```http
GET /wisp/ HTTP/1.1
Host: 127.0.0.1:6001
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <browser's key, unchanged>
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: <browser's value, unchanged, only if sent>
X-Forwarded-For: <bare client ip>

```

- HolyWisp ignores the path, `Host` and `Origin` (any path works; the ticket query must be stripped
  anyway). It computes `Sec-WebSocket-Accept` from the key and echoes the first subprotocol token, and
  the browser checks both, so they must pass unchanged. `Sec-WebSocket-Extensions` is never accepted.
- Every client-supplied `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`,
  `True-Client-IP` is dropped and exactly one `X-Forwarded-For` with a bare IP (no port, no list) is
  written: HolyWisp reads the **first** occurrence, truncated to 511 characters, and stores only 48
  headers. `Cookie` and `Authorization` are never forwarded (head limit 8192 bytes, else `400`).
- Relay the response head: `101 Switching Protocols`, or `400` (bad head), `426` (not an upgrade), `429`
  (`connections-limit-per-ip`), `503` (`max-concurrent-connections`); the gateway answers non-101 with
  its own `502`. The first Wisp frame follows the `101` head immediately, so bytes read after
  `\r\n\r\n` belong to the WebSocket.
- Then splice both ways. HTTP/1.1 only (no RFC 8441 WebSockets over HTTP/2), no short idle timeout
  (HolyWisp sends no pings), per-user connection caps and byte quotas in the gateway. HolyWisp's
  `SIGTERM` stop is immediate (no draining): clients see the TCP connection close and reconnect.
- Status: `GET /health` -> `{"status":"ok"}` and `GET /stats` -> JSON counters (connections, streams,
  bytes, refusals) on the same port, unauthenticated. The backend may poll them on loopback; never route
  them publicly.
- VPN profiles: `/wisp/p/<id>/` goes to that profile's `wisp_upstream` in `GNOME_VPN_PROFILES` (the
  `holywisp@<id>` instance's `127.0.0.1:<port>`, or `gluetun:<port>` in `services/vpn/` recipe A), with the same
  request rules and the canonical path `/wisp/p/<id>/` (never the client's query).

`tests/smoke.sh` sends exactly such a hand-made upgrade and checks that `X-Forwarded-For` sets the
client IP, that `CF-Connecting-IP` is ignored (alone and next to XFF), and that the right-most
untrusted address of an XFF list wins.

## VPN egress instances (`holywisp@.service`, `vpn-egress.conf.example`)

One HolyWisp instance per offered exit location (`docs/research/mullvad-vpn.md` §5): HolyWisp's `proxy`
is one setting per process. Instance `<id>` runs
`holywisp --config /etc/holywisp/holywisp.conf --config /etc/holywisp/egress/<id>.conf`, so the overlay
only states what differs (port, `proxy = socks5://<relay ip>:1080`, `dns-server` through the tunnel,
`trusted-proxy` = the gateway's address, fewer workers) and inherits the whole hardened policy;
`smoke.sh` proves the inherited port blocks and address classes still apply and that refused
destinations never reach the proxy.

```sh
install -D -m 0755 check-egress.sh /usr/local/libexec/holywisp/check-egress
install -D -m 0644 vpn-egress.conf.example /etc/holywisp/egress/se-sto.conf   # fill in every <...>
/usr/local/libexec/holywisp/check-egress /etc/holywisp/egress/se-sto.conf
systemctl edit holywisp@se-sto.service      # the IPAddressAllow= / BindsTo= drop-in below
systemctl enable --now holywisp@se-sto.service
```

- **`check-egress.sh` before every start** (`ExecStartPre=+`): HolyWisp only logs a malformed
  `dns-server` (a leftover placeholder, a bare IPv6 address such as `fd00::1`, which it splits at the
  last colon) and, with no valid entry, resolves every destination through the host's resolver,
  outside the tunnel. The check refuses that, a missing `dns-server` or `proxy`, a proxy hostname,
  leftover placeholders, port 6001, `allow-private`/`allow-loopback`/`allow-link-local`/`allow-udp`/
  `enable-twisp`/`reputation` switched on, `proxy-udp = direct`, and trusted headers other than
  `X-Forwarded-For`. Accepted `dns-server` forms: `10.64.0.1`, `10.64.0.1:53`, `[fd00::1]:53`. Run it
  by hand for container deployments (POSIX sh + awk; tested with GNU awk, mawk and busybox).
- **Fail-closed unit**: `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1`. Allow the tunnel side per
  instance with a drop-in (`systemctl edit holywisp@se-sto`), e.g. `IPAddressAllow=10.124.0.0/16
  10.64.0.1` for Mullvad SOCKS5 proxies and its in-tunnel DNS, plus `BindsTo=`/`After=` on the tunnel
  unit. Without the drop-in the instance cannot send anything past loopback. wireproxy-style setups
  (proxy and DNS on `127.0.0.1`) need no drop-in. This needs cgroup v2 BPF; check it with
  `systemctl show -p IPAddressDeny,IPAddressAllow holywisp@<id>`.
- **Network namespace** (kernel WireGuard, mullvad-vpn.md §5.8): add `NetworkNamespacePath=` in the
  drop-in, set `host` to the namespace end of the veth pair and allow the gateway's veth address.
- **DNS**: with `dns-server` set, HolyWisp uses its own DNS client for every destination, through the
  tunnel; that client does not read `/etc/hosts` (names such as `localhost` do not resolve there,
  `0x42`). HolyWisp resolves each name itself before it dials the proxy, then hands the proxy the
  hostname (SOCKS5 ATYP 3) and the exit relay resolves it again; a destination that resolves
  differently at the exit is outside HolyWisp's control.
- **Ports**: unique per instance. Under systemd each instance has its own dynamic UID, and the kernel
  only lets sockets of the same effective UID share a port through `SO_REUSEPORT`, so a clash fails with
  `cannot start: Address in use` instead of silently splitting traffic (the UID rule was verified with
  containers; that template instances get distinct dynamic users is systemd's documented behaviour,
  not run under systemd here). Several instances in one netns under one UID (e.g. gluetun) must still
  keep their ports distinct.
- **Credentials**: Mullvad's SOCKS5 proxies need none. An overlay with `user:pass@` in `proxy` must be
  readable by the dynamic UID; systemd's `LoadCredential=` can hand a root-only file to the service
  instead (not exercised by GNOME's tests).
- Mullvad: the operator's own account, for the operator's household only (its terms forbid providing
  VPN service to others). GNOME is not affiliated with or endorsed by Mullvad VPN AB. Tunnel setup
  examples (gluetun, wireproxy, profiles) belong in `services/vpn/`.

## Known upstream issues and GNOME's mitigations

| Issue (holywisp 0.1.0 at e0a0f15) | Mitigation |
| --- | --- |
| No SIGHUP handler: SIGHUP kills the server, and upstream's unit maps `systemctl reload` to it, which stops the relay for good under `Restart=on-failure` | units have no `ExecReload` and use `Restart=always`; config changes need a restart (there is no reload). Docker: run it as PID 1 without `--init` (verified both ways in `smoke.sh`) |
| IP reputation locks a client IP out (403) after ~6 lookups of names that resolve to private addresses, for ~10 h; its store logs client IPs to disk every 30 s | `reputation = off`, no store |
| Real-IP spoofing behind a trusted proxy: `CF-Connecting-IP` checked first, first duplicate wins, values truncated at 511 chars, headers beyond 48 dropped | `trusted-headers-reset` + XFF only; the gateway removes all client copies and writes one bare IP |
| `bandwidth-limit-kbps` does not limit downloads; uploads run ~9x the cap; one bucket for both directions | `0`; quotas in the gateway's splice loop |
| 32-bit builds reject `ws-write-high-water` / `stream-queue-max` (`1L << 31` overflow) | keys not set; no 32-bit builds (fixed upstream after the pin, `fcbf0b6`) |
| `SO_REUSEPORT`: a second instance under the same UID on the same port co-binds silently and takes part of the traffic (verified) | dynamic UID per unit (another UID cannot bind: verified); unique ports; supervisors wait for exit; `smoke.sh` refuses busy ports |
| No authentication and no Origin check on the Wisp port; `/stats` is open | loopback bind; only the gateway connects; never routed publicly |
| HolyWisp never raises `RLIMIT_NOFILE` | `LimitNOFILE` in the units, `--ulimit nofile` for Docker |
| `SIGTERM` stops at once: no WebSocket or Wisp close is sent | transports reconnect on demand; restarts are rare (config changes) |
| NAT64 (`64:ff9b::/96`), 6to4 and IPv4-compatible addresses are refused even when the IPv4 is public, so IPv6-only hosts behind DNS64 cannot reach IPv4-only sites | run on a dual-stack host |
| Built-in DNS client (`dns-server`): no EDNS0, no TCP fallback, predictable query IDs, ignores `/etc/hosts` | the direct instance uses the system resolver; egress instances use it only through the tunnel |
| A malformed `dns-server` (placeholder, bare IPv6) is only logged and skipped; with none left, every name is resolved through the host's resolver (a silent DNS leak on an egress instance) | `check-egress.sh` as `ExecStartPre`; the template's `IPAddressAllow=127.0.0.1` also drops lookups to any other resolver address |
| Twisp (`enable-twisp`) runs a client-chosen command on a PTY | off, no `password-user` |
| `proxy` hostname resolved once at startup; one proxy per process | IP literals; one instance per location |
| Per-destination connect limits (100/s, 3000/min per `ip:port`) are server-wide, shared by all users | defaults kept; raise them for large deployments |
| Shorthand/integer IPv4 literals (`127.1`, `2130706433`) are refused as invalid (`0x41`) rather than blocked (`0x48`) | still refused (checked by `smoke.sh`) |
| `429` lacks `Retry-After` (fixed upstream later); stream-confirm `0x05` honoured but not advertised in v2 INFO | the gateway answers non-101 with its own `502`; the browser transports do not use stream-confirm |
| musl builds cannot verify yescrypt (`$y$`) password hashes | GNOME configures no passwords |
| License metadata: `README.md`/RPM say MIT, `LICENSE` says ISC | `LICENSE` (ISC) governs and is shipped |

## Tests

| Command | What it proves | Result (this pin) |
| --- | --- | --- |
| `fetch-build.sh --arch all` | upstream's 16 suites on the exact release binaries | 16/16 on x86_64, 16/16 on aarch64 (QEMU) |
| `tests/smoke.sh [--port P] [--image TAG] [--offline]` | `gnome.conf` on `127.0.0.1:P`: example.org:80 -> `200` (v1 and v2), public literal allowed; loopback, RFC 1918, CGNAT, link-local/metadata, reserved, multicast and wrapped-IPv6 destinations refused by literal and by hostname (`/etc/hosts` and public DNS answers such as `10.0.0.1.nip.io`); bad ports and UDP refused; `/health`, `/stats`, `426` for plain HTTP; client-IP handling; `check-egress.sh` on good and bad overlays; the egress overlay through a SOCKS5 stand-in; SO_REUSEPORT, SIGHUP and SIGTERM behaviour | 87/87 for the binaries and for the image, repeatedly (64 checks with `--offline`) |
| `tests/syscalls.sh` | every system call HolyWisp makes in a representative workload is inside the units' `SystemCallFilter`; only AF_INET/AF_INET6 sockets; no W+X memory; no `personality()`; no writes, device nodes, non-process `/proc` entries or home directories | 36 distinct calls, all allowed |
| `systemd-analyze verify --root=<dir>` | unit syntax and the `ExecStart`/`ExecStartPre` executables (`/usr/local/bin/holywisp`, `/usr/local/libexec/holywisp/check-egress`) | clean (systemd 262) |

HolyWisp only ever runs in containers: upstream's tests in the BuildKit build sandbox (no network), and
for `smoke.sh` and `syscalls.sh` in unprivileged containers (read-only root, no capabilities, UID
65534) on the host's network namespace or with no network, respectively.
Not covered here: running the units under systemd itself (`IPAddressDeny` BPF filtering, dynamic-UID
allocation per instance, the `reload`/restart behaviour are systemd's documented semantics), and arm64
hardware. Do not test the units by booting systemd in a privileged container on a shared machine:
its early-boot units write host-global state (the binfmt_misc table, `kernel.core_pattern`).

## Updating the pin

1. Pick the commit; read its diff for config keys, defaults, the egress policy (`src/server/egress.c`,
   `src/common/net.c`), header parsing (`src/common/ws.c`, `src/server/conn.c`), signals
   (`src/server/main.c`) and the `dns-server`/proxy parsing that `check-egress.sh` mirrors
   (`src/server/server.c`, `src/server/proxy.c`).
2. Update `VERSION` (commit, tree from `git rev-parse <commit>^{tree}`, date, version) and
   `ARG HOLYWISP_COMMIT` in `Dockerfile` together.
3. `fetch-build.sh --arch all --no-cache --image`, then `tests/smoke.sh`, `tests/smoke.sh --image ...`
   and `tests/syscalls.sh`. Adjust `gnome.conf`, the units and this README (known issues) to what changed.
4. Copy the new `build/x86_64` binaries wherever other tooling expects them.
