# HolyWisp (holyWisp 0.1.0): research notes for GNOME

| | |
| --- | --- |
| Project | holyWisp, a Wisp v1/v2 server in C11 plus a C client library and CLI. README links to `https://github.com/Fracital/holyWisp` |
| Revision studied | `e0a0f15` (2026-11-07 00:41 -0500, "Add a benchmark harness and results against wispurr and wisp-server-python"), shallow clone |
| Version string | `holywisp 0.1.0` (`CMakeLists.txt:2`, `include/holywisp/hw.h:10`) |
| License | **ISC** (`LICENSE`). `README.md:229` and `deploy/rpm/holywisp.spec:11` say "MIT": the metadata is inconsistent, and `LICENSE` is the operative text |
| Written | 2026-11-09 |
| How it was verified | Every build and run happened inside Docker containers: Debian trixie/bookworm, Alpine 3.22, and Debian cross toolchains. Builds ran with `--network none`, the source mounted read-only, and `--cap-drop ALL`. Host: CachyOS, kernel 7.3.1, glibc 2.44, AMD Ryzen 5 5600G (12 threads), Docker 29.9.2. Anything marked **UNVERIFIED** was read or inferred but not executed. |

Source paths below are relative to the holyWisp repo root. `SP` means the session scratchpad,
`/tmp/claude-1000/-home-duderucool-gnome/f2049012-6316-4b31-bd8a-a00530b243a1/scratchpad`.

---

## 0. Summary for GNOME implementers

1. **It builds and its tests pass.** `make release` succeeds (63 targets, about 1 s). `make test` passes 16/16 under ASan+UBSan, and `make test-release` passes 16/16. The build has no warnings under `-Werror`. Binaries for other agents are at `SP/bin/holywisp` and `SP/bin/holywisp-client` (x86_64, glibc ≥ 2.38, `libcrypt.so.1`).
2. **The relay works and the default egress policy holds.** The relay to `example.org:80` returns `HTTP/1.1 200 OK`. `127.0.0.1:22`, `169.254.169.254:80`, `10.0.0.1:80`, `[::1]`, `[::ffff:127.0.0.1]`, `localhost` and `*.nip.io` names resolving to private IPs are all refused with Wisp CLOSE `0x48`. The check runs *after* DNS. With the default `allow-direct-ip = off`, **every IP literal is refused, including public ones such as `1.1.1.1`**.
3. **HolyWisp accepts a forwarded upgrade with any path, Host or Origin.** It never inspects the path, Host or Origin of a WebSocket upgrade (`src/server/conn.c:460-548`; tested with `/wisp/`, `/any/deep/path?q=1`, `Host: gnome.example.com`, `Origin: https://evil.example`). **It has no Origin check and no authentication on the Wisp port.** It must listen on `127.0.0.1` only, behind the GNOME gateway.
4. **Real client IP** works with `trusted-proxy = 127.0.0.1/32`, `trusted-headers-reset = on` and `trusted-header = X-Forwarded-For`. The gateway **must strip every client-supplied proxy header and write exactly one `X-Forwarded-For: <ip>`**. Forwarding the browser's headers unchanged lets clients spoof their IP in four verified ways (§5.9).
5. **Browser transports and Wisp versions.** libcurl-transport 2.0.6 and epoxy-transport 3.0.2 (default options) speak **Wisp v1**. wisp-js 0.4.1/0.5.3 and epoxy with `wisp_v2: true` speak **v2**. HolyWisp handles both on the same port. **No browser transport can send Wisp v2 password credentials**, so keep `password-required = off` and let the gateway authenticate.
6. **Twisp** (a remote shell, `stream type 0x03`) is off by default and refused with `0x48`. Keep `enable-twisp = off` and configure no `password-user`.
7. **SIGHUP kills the server.** No handler is installed (`src/server/main.c:45-46`), but the shipped unit's `ExecReload` sends SIGHUP (`deploy/systemd/holywisp.service:22`). systemd treats SIGHUP as a clean exit, so `systemctl reload holywisp` stops the service and `Restart=on-failure` does not restart it. There is **no config reload**: change the config, then restart. SIGTERM/SIGINT stop it immediately and clients see a bare TCP close.
8. **`bandwidth-limit-kbps` does not work.** Measured at a 100 kB/s cap: a 20 MB download took 0.32 s (unlimited) and a 20 MB upload ran at 882 kB/s. Enforce bandwidth in the gateway.
9. **IP reputation can lock users out.** Six lookups of hostnames that resolve to private or loopback addresses raise an IP to score 90 and get HTTP 403 at the next upgrade; the score decays 1 point per hour. GNOME already authenticates users, so the recommended config turns reputation **off**.
10. **Health and metrics:** `GET /health` returns `{"status":"ok"}` and `GET /stats` returns JSON counters, both on the Wisp port and both unauthenticated. Logs go to stderr only: `2026-11-09T23:02:47.219Z [info] server: …`.
11. **Upstream proxy** supports `socks5://`, `socks5h://` (identical) and `http://` (CONNECT), with optional `user:pass@`. It is **one global proxy per process**, TCP only. UDP is refused unless `proxy-udp = direct`. The hostname is sent to the proxy (SOCKS5 ATYP 3), but HolyWisp still resolves it **locally** first for the egress check. Per-user exit locations need one HolyWisp instance per exit.
12. **Portability.**
    - aarch64 cross-builds cleanly.
    - Binaries built on glibc ≥ 2.38 require `GLIBC_2.38`; build on Debian 12 / Ubuntu 22.04 to support Raspberry Pi OS bookworm (`GLIBC_2.34`).
    - **32-bit builds (armhf/i386) reject the `ws-write-high-water` and `stream-queue-max` keys**, so both shipped config files fail to load there.
    - A fully static **musl** build works (16/16 tests, 239 KB stripped, 386 kB `FROM scratch` image) but cannot verify yescrypt (`$y$`) hashes.
    - The systemd unit scores 1.3 "OK" in `systemd-analyze security`.

---

## 1. Artifacts produced in this session

| Path | What | Notes |
| --- | --- | --- |
| `SP/bin/holywisp` | server, x86_64 PIE, `make release`, Debian trixie GCC 14.2.0 | sha256 `4bfa2057707574fa48c462b75268aff7c8d18a8c454af88b55e697e7d67f3047`, 142,144 B. NEEDED `libcrypt.so.1`, `libc.so.6`; max symbol `GLIBC_2.38`. Runs on this host. |
| `SP/bin/holywisp-client` | netcat-style client CLI | sha256 `0663409f68325859c548d4eb05c33dca51de881af877c751e22b102c0e62c905`, 59,472 B |
| `SP/build/holywisp-out/musl-static/holywisp{,-client}` | static musl build (Alpine 3.22, GCC 14.2.0), unstripped | 958,304 / 531,032 B |
| `SP/scripts/holywisp/scratch-image/` | stripped static binaries (239,320 / 100,040 B), `Dockerfile` (`FROM scratch`), config | image `gnome-hw-scratch:test`, 386 kB |
| `SP/build/holywisp-out/bookworm/holywisp` | x86_64, built on Debian 12 | max `GLIBC_2.34` |
| `SP/build/holywisp-out/arm64/holywisp` | aarch64 cross build (trixie) | max `GLIBC_2.38`, not executed (no arm64 emulation on this host) |
| `SP/build/holywisp-out/armhf/` | armhf cross build log | build OK, binary not executed |
| `SP/scripts/holywisp/gnome-holywisp.conf` | the recommended GNOME config (§6.3) | loaded and exercised with the real binary |
| `SP/scripts/holywisp/runtime/t1…t9` | black-box test scripts (bash/python) | logs in `SP/results/holywisp/` |
| `SP/build/holywisp-src` | pristine copy of the clone used for every build | the clone in `SP/repos/holywisp` was never written to |

---

## 2. Build and test (task 1)

### 2.1 Requirements (from `CMakeLists.txt`, `Makefile`, `README.md:50-62`, `AGENTS.md:76-86`)

- Linux only (epoll, `accept4`, `eventfd`, `SO_REUSEPORT`). C11 with `_GNU_SOURCE`. CMake ≥ 3.20. Ninja is used if present.
- Libraries: libc + pthreads + `-lcrypt` (crypt(3)/`crypt_r`, from libxcrypt `libcrypt-dev`/`libxcrypt-devel`) + `-lutil` (`forkpty`, for Twisp) (`CMakeLists.txt:87`). No third-party code, no FetchContent and no pkg-config. SHA-1 and Base64 are in-tree. **No TLS**: terminate `wss://` in front.
- The `Makefile` sets `SHELL := bash` (`Makefile:16`), so **bash is required** (Alpine needs `apk add bash`).
- The build embeds `examples/wisp-webclient.html` as a generated C header (`cmake/embed_file.cmake`); this is the page served on `GET /` when `serve-webclient = on`.
- Options: `HW_WERROR` (ON), `HW_SANITIZE` (OFF; the debug preset turns it on), `HW_BUILD_TESTS` (ON), `HW_VERSION_SUFFIX`. Pass extra CMake flags through `make … CMAKE_FLAGS="…"`. The compiler comes from `CC=` (`Makefile:42-48`).

### 2.2 What was run

Each step ran inside a toolchain-only container (`debian:trixie-slim` + `build-essential cmake ninja-build libcrypt-dev`), with `SP/build/holywisp-src` mounted read-only and copied to `/tmp/work`:

```sh
make release        # -> build/release/holywisp, build/release/holywisp-client (+ test binaries)
make test           # debug build with -fsanitize=address,undefined, then ctest
make test-release   # same tests against the release build
```

| Step | Result |
| --- | --- |
| `make release` | OK, 63/63 targets, 1.05 s wall (12 jobs). GCC 14.2.0, CMake 3.31.6. 0 warnings with `-Werror` |
| `make test` (ASan+UBSan) | **100% tests passed, 0 failed out of 16**, 1.50 s (`test_buf test_crypto test_map test_smap test_net test_wisp test_ws test_loop test_config test_limits test_filter test_dns test_reputation test_e2e test_security test_flow`) |
| `make test-release` | 16/16 passed, 1.39 s |
| Alpine 3.22 musl, `make release CMAKE_FLAGS=-DCMAKE_EXE_LINKER_FLAGS=-static` + `ctest` | build OK, 16/16 passed |

The e2e and security suites run real servers, SOCKS5/HTTP proxies and echo services in-process on
loopback, so they work without network access.

---

## 3. Runtime verification (task 2)

The server ran inside the runtime container on `127.0.0.1:16000` (`holywisp --host 127.0.0.1 --port 16000 --log-level debug`) and was driven with `holywisp-client`. Script: `SP/scripts/holywisp/runtime/t1_basic.sh`.

```sh
printf 'GET / HTTP/1.0\r\nHost: example.org\r\n\r\n' \
  | holywisp-client -v -s ws://127.0.0.1:16000/ example.org 80
# HTTP/1.1 200 OK … Server: cloudflare …        stderr: connected: wisp-v1, window 8
printf 'GET / HTTP/1.0\r\nHost: example.org\r\n\r\n' \
  | holywisp-client -v --v2 --confirm -s ws://127.0.0.1:16000/wisp/ example.org 80
# HTTP/1.1 200 OK                                stderr: connected: wisp-v2, window 8 / [stream 1] CONTINUE 7
```

| Target (default config) | Result | Server log (`info`) |
| --- | --- | --- |
| `example.org 80` (v1, path `/`) | `HTTP/1.1 200 OK` | — |
| `example.org 80` (v2, path `/wisp/`) | `HTTP/1.1 200 OK` | — |
| `127.0.0.1 22` | CLOSE `0x48` | `egress: 127.0.0.1: blocked direct IP 127.0.0.1:22` |
| `169.254.169.254 80` | CLOSE `0x48` | `blocked direct IP 169.254.169.254:80` |
| `10.0.0.1 80`, `192.168.1.1 80` | CLOSE `0x48` | `blocked direct IP …` |
| `[::1] 22`, `[::ffff:127.0.0.1] 80` | CLOSE `0x48` | `blocked direct IP …` |
| `localhost 22` (hostname) | CLOSE `0x48` | `blocked localhost:22 (loopback)`, after DNS |
| `1.1.1.1 80` (public literal) | CLOSE `0x48` | `blocked direct IP 1.1.1.1:80`: `allow-direct-ip` is off by default |

With `--allow-direct-ip`, the class-based policy applies to literals (`t2_policy.sh`). `127.0.0.1` → loopback, `169.254.169.254` → link-local, `10.0.0.1` and `100.64.0.1` → private, `0.0.0.0` → unspecified, `224.0.0.1` → multicast, `[fd00::1]` → private, `[fe80::1]` → link-local, and `[64:ff9b::a00:1]` (NAT64-wrapped 10.0.0.1) → private: all `0x48`. `1.1.1.1:80` is allowed (`301`).

DNS-based private egress is blocked once HolyWisp itself resolves the name (`--dns-server 1.1.1.1`, `t2b_dns.sh`): `10.0.0.1.nip.io`, `127.0.0.1.nip.io`, `169.254.169.254.nip.io` and `localtest.me` → `0x48` ("blocked … (private|loopback|link-local)"). Through this LAN's router resolver the same names returned `0x42`, because the router strips private answers (DNS-rebind protection) before HolyWisp sees them.

Stop: `kill -TERM` gives exit status 0 and the log line `server: shutting down`.

---

## 4. Architecture in one paragraph

`holywisp` is one process. It runs `workers` epoll loops (default: one per CPU, `get_nprocs()`, `src/server/server.c:324`), and each loop has its own `SO_REUSEPORT` listener on the same port, so the kernel load-balances accepts (`src/server/server.c:207-218`, `src/common/net.c:66`). Each connection and its streams live on one loop thread. Shared state is lock-protected: rate limiters, the reputation table and the DNS cache. A resolver thread pool (`resolver-threads`, default 4) runs blocking `getaddrinfo` or the built-in DNS client. One maintenance thread wakes every second, runs eviction, decay and DNS-cache expiry every 60 s, and saves the reputation store on its own cadence and at shutdown (`src/server/server.c:228-266`). HTTP, WebSocket (RFC 6455) and Wisp share the single TCP port. SIGPIPE is ignored (`server.c:421`). All sockets are `SOCK_NONBLOCK|SOCK_CLOEXEC` (`net.c:20-26`).

---

## 5. Configuration and behaviour reference (task 3)

### 5.1 Syntax and precedence (`src/server/config.c`)

- File: `key = value` per line, `#` comments, inline `#` comments when preceded by whitespace (`config.c:292-299`). `"quoted strings"` may contain `#` and spaces, and text after the closing quote is ignored (`config.c:283-290`). Lines are capped at 1023 chars (`fgets` 1024, `config.c:268`).
- CLI: every key is also `--key value` or `--key=value`. A boolean flag may stand alone (`--allow-loopback` means true, `config.c:416-421`). Booleans accept `1/true/yes/on` and `0/false/no/off` (`config.c:16-26`).
- `--config FILE` / `-c FILE` is processed first and may repeat (loaded in order). **Flags override the file** whatever their position (`config.c:360-376`). Also `--help/-h` and `--version/-V`.
- List keys are built by repeating the key: `allow-host`, `block-host`, `allow-port`, `block-port`, `trusted-proxy`, `trusted-header`, `dns-server`, `password-user`, `reputation-weight`, `reputation-dest-weight`.
- An **unknown key is fatal**: `unknown option 'x'`, exit 2 (`config.c:248`). Cross-field validation failures exit 1 with `cannot start: Invalid argument` and an `[error] config:` log line (`server.c:95-146`). Verified: `--enable-twisp` without a user, `--password-required` without a user, `https://` proxy, a proxy URL with `/` in the password, and a bad `webclient-wisp-url`.
- Undocumented key: **`trusted-headers-reset`** (any value) clears the trusted-header list at that point in the file (`config.c:230-233`). It is needed because the compiled-in defaults already contain `CF-Connecting-IP` and `X-Forwarded-For` (`server.c:36-38`). The shipped configs then *append* the same two names again, which is harmless but uses 4 of the 8 slots.

### 5.2 Every key (compiled-in default; range from `config.c:74-247`)

Where the shipped configs differ from the compiled-in defaults, it is noted: `E` = `holywisp.conf.example`, `D` = `deploy/holywisp.conf`, the installed `/etc/holywisp/holywisp.conf`.

**Listening and logging**

| Key | Default | Values | Notes |
| --- | --- | --- | --- |
| `host` | `""` | string < 256 | `""` = all interfaces, preferring an IPv6 dual-stack wildcard `[::]` with `IPV6_V6ONLY=0` (`net.c:46-70`). **D: `127.0.0.1`**. When `host` is set, the first `getaddrinfo` result that binds wins, so use a literal (`127.0.0.1`), not `localhost` |
| `port` | `6001` | 0–65535 | 0 = ephemeral |
| `workers` | `0` | 0–1024 | 0 = `get_nprocs()` |
| `listen-backlog` | `1024` | 1–65535 | |
| `log-level` | `info` | `debug` `info` `warn`/`warning` `error` `none` | §5.13 |

**What clients may reach**

| Key | Default | Notes |
| --- | --- | --- |
| `allow-tcp` | on | CONNECT type `0x01` |
| `allow-udp` | on | CONNECT type `0x02`. Also controls whether INFO advertises extension `0x01` |
| `allow-direct-ip` | off | IP literals in CONNECT. Off refuses **all** literals, public ones included (`stream.c:435-442`) |
| `allow-private` | off | RFC 1918, CGNAT `100.64/10`, `fc00::/7` |
| `allow-loopback` | off | `127/8`, `::1` |
| `allow-link-local` | off | `169.254/16`, `fe80::/10` |
| `allow-host` / `block-host` | none | ≤ 256 entries each, ≤ 127 chars. Lowercased, trailing dot stripped. `*.x` or `.x` matches subdomains but not the apex. If any `allow-host` exists, only those pass and `block-host` is ignored (`stream.c:392-404`). Matched on the hostname **as given by the client, before DNS**, so a literal IP or another name pointing at the same address bypasses it |
| `allow-port` / `block-port` | none | `N` or `LO-HI` (1–65535). Same precedence as the host lists |

**Protocol**

| Key | Default | Notes |
| --- | --- | --- |
| `enable-v2` | on | §5.4 |
| `motd` | `""` | < 512 chars; advertised as v2 extension `0x04` when non-empty |
| `enable-twisp` | off | PTY streams; requires `enable-v2` and at least one `password-user` (validated) |
| `password-user` | none | `USER:PASS`, ≤ 64 users, user < 64 chars, pass < 128 chars. A `$`-prefixed PASS is a crypt(3) hash (`conn.c:569-577`) |
| `password-required` | off | requires at least one `password-user` |
| `buffer-remaining` | 128 | 1–2^24. Advertised CONTINUE window in packets, capped (§5.12) |

**Who the client is**

| Key | Default | Notes |
| --- | --- | --- |
| `parse-real-ip` | on | Only takes effect when at least one `trusted-proxy` is set |
| `trusted-proxy` | none | CIDR or bare IP (full mask), IPv4/IPv6, ≤ 64. IPv4-mapped IPv6 peers match IPv4 rules (`filter.c:126-143`) |
| `trusted-header` | `CF-Connecting-IP`, `X-Forwarded-For` | ≤ 8 total, names < 64 chars, checked in list order |
| `trusted-headers-reset` | — | clears the list (undocumented) |

**Per-client limits and flood protection**

| Key | Default | Notes |
| --- | --- | --- |
| `connections-limit-per-ip` / `connection-window-s` | 200 / 10 | New WebSockets per policy IP per fixed window; both 0 disables. Excess gets HTTP 429 `rate limit` (`conn.c:495-501`) |
| `bandwidth-limit-kbps` | 0 | Per policy IP, **one shared bucket for both directions, and ineffective** (§5.7) |
| `max-streams-per-conn` | 2048 | 0 = unlimited. Excess gets CLOSE `0x49` and counts as a flood violation |
| `flood-protection` | on | Master switch for every limit below, including both semaphores and the SYN signature |
| `max-connects-per-source-per-second` | 500 | CONNECTs per policy IP (`conn.c:660-669`) → `0x49` |
| `max-connects-per-dest-per-second` / `-per-minute` | 100 / 3000 | Keyed by the first resolved `ip:port`, **server-wide across all users** (`stream.c:321-341`) → `0x49` |
| `max-in-flight-syns` | 4096 | server-wide TCP connects in progress → `0x49` |
| `max-concurrent-connections` | 50000 | server-wide WebSockets → HTTP 503 `at capacity` |
| `syn-signature`, `-window-ms`, `-min-samples`, `-failed-ratio` | on, 2000, 128 (≤ 256), 0.75 | Per connection, per destination. A match closes the whole WebSocket |
| `ws-close-after-violations` | 64 | 0 = never. Closes the WebSocket after N flood hits |
| `log-blocked-dials` | off | logs failed dials at `info` |

**Reputation** (§5.8)

| Key | Default | Notes |
| --- | --- | --- |
| `reputation` | on | |
| `reputation-store` | `""` (memory only) | **E: `./data/reputation.json`** (relative to CWD). **D: `/var/lib/holywisp/reputation.json`**. < 512 chars |
| `reputation-save-interval-s` | 30 | 0 = never save, not even at shutdown |
| `reputation-decay-per-hour` | 1 | 0–100 |
| `reputation-evict-after-days` | 7 | Entries with score < 5 and idle longer than this are dropped |
| `reputation-warn` / `-throttle` / `-strict` | 21 / 51 / 81 | 0 disables a tier |
| `reputation-weight` / `reputation-dest-weight` | see §5.8 | `EVENT:N`, N in −100…100 |

**Where streams go**

| Key | Default | Notes |
| --- | --- | --- |
| `proxy` | `""` | §5.10 |
| `proxy-udp` | `refuse` | `refuse` or `direct` |
| `dns-server` | unset → system `getaddrinfo` | ≤ 8 entries: `ip`, `ip:port`, `[v6]:port`. Setting any switches to the built-in UDP client |
| `dns-ttl-s` / `dns-negative-ttl-s` | 120 / 10 | cache caps (positive entries use min(record TTL, cap)) |
| `dns-order` | `ipv4first` | `ipv4first`, `ipv6first`, `verbatim` |
| `dns-timeout-ms` | 3000 | 100–60000, built-in client only |
| `resolver-threads` | 4 | 1–256 |

**Tuning and HTTP surface**

| Key | Default | Notes |
| --- | --- | --- |
| `max-message-size` | 1048581 (1 MiB + 5) | 1024–2^30. Largest WS message accepted (larger gets close 1009) and the largest DATA frame sent |
| `ws-write-high-water` | 8388608 | 4096–`1L<<31`. Pause remote reads when a client's send queue exceeds this; resume at 1/4. **Unsettable on 32-bit builds** (§7.4) |
| `stream-queue-max` | 16777216 | 4096–`1L<<31`. Bytes queued toward a slow remote before `0x49`. **Unsettable on 32-bit builds** |
| `socket-buffer-size` | 0 | `SO_RCVBUF`/`SO_SNDBUF`; 0 = kernel default |
| `connect-timeout-ms` | 15000 | remote TCP connect, per address tried (up to 8 addresses) |
| `handshake-timeout-ms` | 10000 | From TCP accept until the HTTP upgrade (v1) or the client INFO (v2) completes. Verified: an idle socket is closed after exactly the timeout |
| `tcp-nodelay`, `tcp-quickack` | on, on | also sets `SO_KEEPALIVE` on client and remote TCP sockets (`server.c:161-175`) |
| `non-ws-response` | `holyWisp: a Wisp server. Connect with a WebSocket client.\n` | < 256 chars; `""` makes plain HTTP return 426 |
| `serve-webclient` | on | embedded demo client on `GET /` |
| `webclient-wisp-url` | `""` | `ws://`/`wss://` only; no spaces, quotes, `\`, `<`, `>` (validated, `server.c:125-139`) |

### 5.3 HTTP surface and WebSocket path handling

The request head is parsed by `hw_http_parse_request` (`src/common/ws.c:165-223`). Request
handling is in `http_process` (`src/server/conn.c:460-548`).

- **An upgrade is recognized** when the method is `GET`, `Upgrade` contains token `websocket`, `Connection` contains token `upgrade` (comma lists OK, so Firefox's `keep-alive, Upgrade` works), `Sec-WebSocket-Version` contains `13`, and `Sec-WebSocket-Key` is non-empty (`ws.c:221`). `HTTP/1.0` and `HTTP/1.1` are both accepted.
- **Path, Host and Origin are ignored for upgrades.** The path is parsed but never compared for WebSockets, `Host` is never checked, and `Origin` is never read. Verified: `/wisp/`, `/any/deep/path?q=1`, `Host: gnome.example.com` and `Origin: https://evil.example` all return `101`. The Wisp spec leaves path handling to the server and recommends a trailing `/`; libcurl.js refuses URLs without one, and `/wisp/` satisfies that.
- `Sec-WebSocket-Extensions` (permessage-deflate) is ignored. The server never negotiates compression, and RSV bits make it close with 1002 (`ws.c:30`).
- **Limits.** Request head ≤ **8192 bytes**, else 400 (`ws.c:166-168`, `HW_HTTP_MAX_REQUEST`): verified 9000-byte Cookie → 400, 7000 → 101. At most **48 headers are stored** (`HW_HTTP_MAX_HEADERS`); later ones are parsed but dropped (`ws.c:200`). Header values are **truncated to 511 chars** (`ws.c:198-199`). Names longer than 63 chars are truncated. A repeated header returns its **first** occurrence (`ws.c:225-230`).
- Plain (non-upgrade) requests always get `Connection: close` and `Cache-Control: no-store`, and **any method** is accepted (only the path is compared). Paths must match exactly, so a query string breaks the match.

| Request | Response |
| --- | --- |
| `GET /health` | `200 application/json` `{"status":"ok"}\n` |
| `GET /stats` | `200 application/json`, counters (§5.14) |
| `GET /` with `serve-webclient = on` | `200 text/html`, embedded client (13,659 B body) |
| anything else, `non-ws-response` non-empty | `200 text/plain`, the banner (this includes `GET /wisp/` without upgrade headers) |
| anything else, `non-ws-response = ""` | `426 Upgrade Required` |
| malformed head / over 8 KiB | `400 Bad Request` |
| upgrade over the per-IP rate | `429 Too Many Requests` (a `Retry-After` value is formatted but **never sent**, `conn.c:497-499`) |
| upgrade from an IP in the STRICT reputation tier | `403 Forbidden` `blocked` |
| upgrade beyond `max-concurrent-connections` | `503 Service Unavailable` `at capacity` |
| v1 upgrade while `password-required = on` | `426` `wisp-v2 with authentication required` |

- **Successful upgrade:** `HTTP/1.1 101 Switching Protocols`, `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Accept`, plus `Sec-WebSocket-Protocol: <first offered token, verbatim>` for v2 (`conn.c:524-534`). The first Wisp frame follows immediately: v1 `CONTINUE(stream 0, window)`, i.e. bytes `82 09 03 00 00 00 00 08 00 00 00` with the default window of 8; v2 an `INFO` frame.
- WebSocket rules (`conn.c:725-807`): client frames must be masked, else 1002. Text frames get 1003. Oversize messages (> `max-message-size`) get 1009. Fragmentation is supported. Pings are answered with pongs. A client CLOSE is echoed and the socket closed. The server sends **no pings and has no idle timeout**; only `SO_KEEPALIVE` with kernel default intervals.

### 5.4 Wisp v1 vs v2, extension negotiation, browser clients

Server rules (`conn.c:403-425`, `519-547`, `584-613`, `679-690`; spec: `MercuryWorkshop/wisp-protocol` branch `v2`, `protocol.md` "Version 2.1"):

- v2 is used iff `enable-v2 = on` **and** the client sent a non-empty `Sec-WebSocket-Protocol`; the value doesn't matter (spec: "must be present, but the value … is unspecified"). Only the **first** comma-separated token is echoed, verbatim and ≤ 63 chars (`ws.c:155-163`). Verified: `wisp-v2` → `wisp-v2`, a UUID → the same UUID, `a, b` → `a`.
- v1: right after the 101 the server sends `CONTINUE(0, window)`. Nothing precedes it.
- v2: the server sends `INFO` major 2, minor 1 (`wisp.h:13-14`), then waits for the client's INFO, then sends `CONTINUE(0, window)`. A major-version mismatch gets `CLOSE(0, 0x04)`. Until that CONTINUE, only INFO and CLOSE on stream 0 are honoured; **anything else is silently dropped** (`conn.c:683-690`). The whole exchange must finish within `handshake-timeout-ms` of the TCP accept.
- Server INFO extensions: `0x01` UDP (when `allow-udp`), `0x02` password (meta = 1 byte, `required`; when any `password-user` exists), `0x04` MOTD (when set). Verified: `INFO(v2.1, ext=[0x01])` by default, `ext=[0x02:'\x01']` with a user, `password-required` and `allow-udp=off`. **`0x05` stream-confirm is honoured** (a `CONTINUE(id, remaining)` once the TCP connect succeeds, `stream.c:208-211`) but **never advertised** in the server INFO, which deviates from spec 2.1 ("if the extension is present on both"). Key auth `0x03` is not implemented. Unknown client extensions are skipped (`wisp.c:69-72`).
- Close reasons sent: `0x02` remote EOF/voluntary, `0x03` network error, `0x41` invalid CONNECT (port 0, empty host, NUL in host, > 255 bytes, bad literal), `0x42` unresolvable/unreachable, `0x43` connect timeout, `0x44` refused, `0x48` blocked (egress, filter, Twisp, UDP disabled, UDP with proxy, SOCKS auth failure), `0x49` throttled, `0xc0` bad password, `0xc2` auth required (`wisp.h:34-53`).

**Browser transports.** Versions are the ones scramjet HEAD `517206b` pins in `pnpm-workspace.yaml`, plus wisp-js latest. The packages were downloaded with `npm pack`; epoxy-tls source is from GitHub branch `multiplexed`, `client/package.json` version `2.1.20-1`.

| Client | Sec-WebSocket-Protocol sent | Wisp version with HolyWisp | Client INFO extensions | Source |
| --- | --- | --- | --- | --- |
| `@mercuryworkshop/libcurl-transport@2.0.6` (bundles libcurl.js 0.7.5 and its own Wisp client `wisp_version = "1.1.1"`) | none (`new WebSocket(this.wisp_url)`) | **v1** | — | libcurl.js `libcurl.mjs:130-148`, `:1388`; libcurl-transport `dist/index.mjs:5192-5206`. URL must start `ws://`/`wss://` and **end with `/`** (`index.mjs:6408`). Options `{wisp, transport?, proxy?, connections?}`: `connections` overrides libcurl.js's `HTTPSession` default of `set_connections(50, 40, 6)` (`index.mjs:5777`), and `proxy` is a libcurl-side `socks5h:`/`socks4a:`/`http:` proxy inside the browser, unrelated to HolyWisp's `proxy` |
| `@mercuryworkshop/epoxy-transport@3.0.2` + `@mercuryworkshop/epoxy-tls@2.1.20-1`, default options | none (`wisp_v2: false`, `websocket_protocols: []`) | **v1** | — | epoxy-tls `client/src/lib.rs:280-296` |
| epoxy-transport with `{ wisp_v2: true }` | a random UUIDv4 per connection (`ws_protocol()`, `crypto.getRandomValues`) | **v2** | `0x01` UDP only; `udp_extension_required` makes the server's UDP ext mandatory | `lib.rs:406-414`, `stream_provider.rs:122-138`, glue module embedded in `full/epoxy.js:1` |
| `@mercuryworkshop/wisp-js@0.4.1` / `@0.5.3` client (`WispConnection`) | `wisp-v2` | **v2** (falls back to v1 only after a WebSocket *error*) | `0x01` UDP + `0x04` MOTD; INFO sent as v2.0 | 0.5.3 `src/client/connection.mjs:83, 110-118, 133-140, 185` (0.4.1: `:85, 114-120`) |

Consequences for GNOME:

- Both versions must work on the same port, and they do (`enable-v2 = on`). v2 costs one extra round trip at connect.
- **Password auth is unusable from these transports.** libcurl is v1-only, and epoxy's v2 handshake registers only the UDP extension builder. wisp-js could send `PasswordAuthExtension` only through its own API, not through bare-mux transports. So do not set `password-required`.
- If a GNOME page configures epoxy with `udp_extension_required: true`, the server must keep `allow-udp = on`. This is from code reading and is **UNVERIFIED**.
- epoxy-transport 3.0.2 forwards an option named `wisp_ws_protocols` (`src/main.ts:22,33`), but epoxy-tls 2.1.20-1 names the field `websocket_protocols` (`full/epoxy.d.ts:49`), so that option is silently ignored (**UNVERIFIED** at runtime).
- **DATA packet size.** wisp-js and libcurl.js send one DATA packet per `send()` call with no chunking, so packet size depends on the caller. Keep `max-message-size` at its default: an oversized client frame closes the *whole* WebSocket with 1009.

### 5.5 Stream types: TCP, UDP, Twisp

- **TCP** (`0x01`). The server resolves the name, applies the policy to each resolved address (up to 8, in `dns-order`), then tries them in turn (`stream.c:245-317`). Data the client sends before the connect completes is queued. A remote EOF closes the stream with `0x02`; there is no half-close.
- **UDP** (`0x02`, default **on**). A connected UDP socket per stream; datagram boundaries preserved; no flow control. Verified: a DNS query to `dns.google:53` returns a 61-byte DATA reply. `allow-udp = off` refuses with `0x48` and removes ext `0x01` from INFO (verified). With an upstream proxy, UDP is refused unless `proxy-udp = direct` (`stream.c:412-417`, verified). **GNOME:** the browser proxy transports use only TCP, so `allow-udp = off`.
- **Twisp** (`0x03`). This is a remote shell: the CONNECT *hostname* is shell-split and passed to `execvp` on a fresh PTY (`twisp.c:79-124`). The command is **chosen by the client**, not the operator (AGENTS.md says "operator-chosen"). It requires `enable-twisp`, a v2 connection and an authenticated user (`conn.c:637-649`). Otherwise the CONNECT gets `0x48`, a `[warn] twisp: … terminal stream refused (enabled=0 v2=0 auth=0)` log line, and reputation event `twispNoAuth` (+40). Verified refusal. **Keep it off.**

### 5.6 Egress policy (`src/server/egress.c`, `src/common/net.c:206-259`)

Addresses are classified after DNS, one by one. Mixed answers connect only to the allowed addresses. Address classes:

| Class | IPv4 | IPv6 | Allowed by |
| --- | --- | --- | --- |
| loopback | 127/8 | ::1 | `allow-loopback` |
| private | 10/8, 172.16/12, 192.168/16, 100.64/10 | fc00::/7 | `allow-private` |
| link-local | 169.254/16 | fe80::/10 | `allow-link-local` |
| unspecified | 0/8 | :: | never |
| multicast/broadcast | 224/4, 255.255.255.255 | ff00::/8 | never |
| reserved | 240/4, 192.0.0/24, 192.0.2/24, 198.51.100/24, 203.0.113/24, 198.18/15 | fec0::/10, 2001:db8::/32, Teredo 2001::/32 | never |
| wrapped IPv4 | — | ::ffff:0:0/96 classified as its IPv4. 64:ff9b::/96 (NAT64), ::/96 (compat) and 2002::/16 (6to4) classified as their IPv4, **but a public result becomes "reserved"** | — |

- **Caveat:** on an IPv6-only host behind NAT64/DNS64, every IPv4-only site resolves into `64:ff9b::/96` and is refused (`net.c:241-246`). From code reading.
- Not classified, so treated as public: `192.88.99.0/24`, `64:ff9b:1::/48`, `100::/64`, `2001:2::/48`.
- A literal IP additionally needs `allow-direct-ip`. Refusals log at `info` (`egress: <client-ip>: blocked <host>:<port> (<class>)`), increment `blocked.egress`, and (except for the direct-IP gate) add reputation event `privateEgress` (+15).
- The upstream proxy's own address is operator config and is not policy-checked.

### 5.7 Connection, stream and bandwidth limits

- Connection-level checks run at upgrade time, in this order: per-IP connect rate (429), reputation (403), then the concurrent-connection semaphore (503) (`conn.c:492-513`). Per-CONNECT checks: stream cap, Twisp gate, per-source rate (`conn.c:615-671`). Per-destination checks: host/port filters (before DNS), then after DNS the egress policy, per-dest rate, destination reputation, the in-flight SYN cap and the SYN signature (`stream.c`).
- Windows are **fixed** (start at first event, reset after the window; `limits.c:50-73`), so up to 2× the limit can pass around a window boundary.
- Flow control vs abuse control: `buffer-remaining` is the Wisp CONTINUE window (§5.12); the `flood-*` keys are abuse control.
- **`bandwidth-limit-kbps` is broken in 0.1.0.**
  - Code: the bucket key is the client IP and is shared by both directions (`conn.c:280`, `conn.c:697`), despite README "each direction". While a connection is throttled, `conn_charge_bandwidth` returns early without charging (`conn.c:174-184`). Remote reads are not paused, and bytes already buffered from the client are still processed.
  - Measured (`t4_bandwidth.py`, cap 800 kbps = 100 kB/s, loopback source/sink): 3 MB download in 0.01 s, 3 MB upload in 4.6 s (650 kB/s). 20 MB download in **0.32 s** (≈ 62 MB/s), 20 MB upload in 22.7 s (**882 kB/s**, ≈ 8.8× the cap).
  - **GNOME: rate-limit in the gateway's splice loop.**

### 5.8 IP reputation (`src/common/reputation.c`, `include/holywisp/reputation.h`)

- Score 0–100 per **source IP** (the policy IP) and per **destination `ip:port`**. Default source weights (`reputation.c:52-72`):

  | Event | Source weight | Dest weight |
  | --- | --- | --- |
  | `privateEgress` | +15 | +20 |
  | `synSignature` | +25 | +30 |
  | `twispNoAuth` | +40 | — |
  | `burstRate` | +5 | +5 |
  | `successfulStream` | −2 | — |
  | `requestKnownBadDest` | +2 | — |
  | `authFailure` | +10 | — |
  | `protocolViolation` | +5 | — |

  Each new source seen for a destination also adds `dest_distinct_sources_escalation` (+1).
- Tiers: STRICT (≥ 81) refuses at upgrade with 403, or refuses a destination with `0x48`. THROTTLE (≥ 51) caps the connection to **16 streams** (`conn.c:395-398`), and every excess CONNECT is a `protocolViolation` (+5): a feedback loop toward STRICT. WARN (≥ 21) has no effect in code.
- Decay: −`reputation-decay-per-hour` for every entry, applied every 60 s with the remainder carried (`reputation.c:215-228`). Eviction: score < 5 and `lastSeen` older than `reputation-evict-after-days`.
- **Verified lockout** (`t2_policy.sh` part B): six CONNECTs to `localhost:80` from one IP give `score 90, events {"privateEgress": 6}`; the next upgrade gets `HTTP/1.1 403 Forbidden`, logged as `[warn] reputation: 127.0.0.1: refused, score 90 (strict)`. At 1 point/hour, getting below 81 takes about 10 hours. If the gateway does not pass real client IPs, **all GNOME users share `127.0.0.1` and get locked out together**.
- **Store** (the reputation file path):
  - Location: compiled-in `""` (memory only), `E` `./data/reputation.json` (relative to the working directory), `D` `/var/lib/holywisp/reputation.json`.
  - Writing: to `<path>.tmp`, `chmod 0600`, then `rename` (`reputation.c:325-350`). Only one missing parent directory level is created (mode 0755). It is rewritten every `reputation-save-interval-s` (30 s) **whether or not anything changed** (SD-card wear on a Pi), and once more at shutdown. It is loaded at startup; a missing file is fine and a malformed one logs a warning.
  - Format: `{"sources":{"<ip>":{"score":N,"firstSeen":ms,"lastSeen":ms,"events":{…}}},"destinations":{"<ip:port>":{…,"distinctSources":N,"seenSources":["<ip>",…]}}}`. It is in effect **a persistent log of client IPs** (every successful stream touches the source entry).
- **GNOME:** `reputation = off`. If you want it, keep `reputation-store =` empty and lower `privateEgress`/`protocolViolation` weights.

### 5.9 Trusted proxy and X-Forwarded-For

Algorithm (`conn.c:370-381`, `filter.c:177-209`):

1. The policy IP starts as the socket peer.
2. If `parse-real-ip` is on, at least one `trusted-proxy` is set, and the peer is inside one of them: for each `trusted-header` in list order, take the header's first occurrence, walk its comma list from the right, and use the first token that parses as a bare IPv4/IPv6 address and is not itself a trusted proxy.
3. If no header yields an address, keep the peer.

The policy IP is used for limits, reputation and logs. The peer `ip:port` is still logged as the connection identity.

Measured with `--trusted-proxy 127.0.0.1` and the default trusted headers, reading the debug line
`conn: <peer> (<policy-ip>): websocket wisp-v1` (`t3_upgrade.py` parts E–G):

| Request headers (peer 127.0.0.1) | Policy IP |
| --- | --- |
| none | 127.0.0.1 |
| `X-Forwarded-For: 203.0.113.7` | 203.0.113.7 |
| `X-Forwarded-For: 198.51.100.1, 203.0.113.7` | 203.0.113.7 (right-most) |
| `X-Forwarded-For: 203.0.113.7, 127.0.0.1` | 203.0.113.7 (skips trusted) |
| `X-Forwarded-For: 2001:db8::5` | 2001:db8::5 |
| `X-Forwarded-For: 203.0.113.7:1234` / `unknown` | 127.0.0.1 (port or garbage not parsed) |
| **client line `XFF: 6.6.6.6`, then gateway line `XFF: 203.0.113.7`** | **6.6.6.6 (spoofed: first occurrence wins)** |
| **client `CF-Connecting-IP: 6.6.6.6` + gateway `XFF: 203.0.113.7`** | **6.6.6.6 (spoofed: CF header is checked first)** |
| **client XFF of 70× `6.6.6.6` (> 511 chars), gateway appends `, 203.0.113.7`** | **6.6.6.6 (spoofed: value truncated to 511 chars)** |
| 49 junk headers, then XFF | 127.0.0.1 (header #49+ not stored) |
| `--trusted-headers-reset --trusted-header X-Forwarded-For` + client CF + gateway XFF | 203.0.113.10 (correct) |
| no `trusted-proxy` configured, XFF + CF present | 127.0.0.1 (headers ignored) |

Required gateway behaviour is in §6.2.

### 5.10 Upstream proxy (`src/server/proxy.c`, `stream.c:47-49`)

- URL forms `socks5://`, `socks5h://` (an alias; both send hostnames) and `http://`, as `[user[:pass]@]host[:port]`. Default ports are 1080 and 80. IPv6 hosts go in `[…]`. `https://` is rejected (no TLS), and any `/`, `?` or `#` anywhere in the URL is rejected, **including inside the password** (`proxy.c:49-52`). Credentials are taken raw with no %-decoding; the user may not contain `:`, but the password may contain `:` and `@` (split on the last `@`).
- **Scope: one proxy for the whole process**, used for every TCP stream (`server.c:329`). There is no per-connection or per-user selection. The proxy hostname is resolved **once at startup** with blocking `getaddrinfo`; if that fails the server refuses to start, and later address changes are not picked up (`proxy.c:107-130`). Each stream gets one attempt at the proxy, with no fallback to direct.
- SOCKS5 (RFC 1928): offers no-auth, plus username/password (RFC 1929) when credentials are set. Hostnames are sent as **ATYP 3**; literal IPs as ATYP 1/4. Reply codes map to close reasons (2 → `0x48`, 3/4 → `0x42`, 5 → `0x44`, 6 → `0x43`). HTTP: `CONNECT host:port HTTP/1.1` plus `Proxy-Authorization: Basic …`; any 2xx is success, 403/407 → `0x48`, else `0x42`.
- **The egress check still runs locally first**: the hostname is resolved by HolyWisp's own resolver and policy-checked before the proxy is dialed, and the proxy then re-resolves the name itself. So **every destination hostname is also looked up through the host's resolver**, which matters for a Mullvad exit design: that's a DNS leak unless the host resolver is the tunnel's.
- Verified (`t7_proxy_auth.py`, toy proxies on loopback):
  - `socks5://gnome:p@ss:w0rd@127.0.0.1:19080`: methods offered `[0, 2]`, credentials `('gnome', 'p@ss:w0rd')`, target `(ATYP 3, 'example.org', 80)`, `HTTP/1.1 200 OK`.
  - Wrong password: `0x48`.
  - `http://gnome:p@ss:w0rd@…`: `CONNECT example.org:80 HTTP/1.1` with Basic `gnome:p@ss:w0rd`, `200 OK`.
  - UDP with a proxy: `0x48`. `localhost:80` with a proxy: `0x48`, and the proxy saw nothing.
  - The upstream suite (`tests/test_security.c:540-660`) covers HTTP, SOCKS5 literal (ATYP 1), `socks5h://` hostname (ATYP 3) and data queued during the proxy handshake.
- **Per-user exit locations** (the Mullvad report proposes per-relay SOCKS5 proxies `10.124.x.y:1080`, and Mullvad documents `10.64.0.1:1080` in-tunnel): run **one HolyWisp instance per exit**, each on its own loopback port with its own `proxy =`, and have the gateway choose the port per session. Each instance is small (peak RSS ≈ 4 MiB in upstream's churn bench). Use IP literals in `proxy =` so startup doesn't depend on DNS, and keep ports unique (§5.15, `SO_REUSEPORT`).

### 5.11 DNS (`src/common/resolver.c`, `src/common/dns.c`)

- The default system resolver is `getaddrinfo(host, NULL, AF_UNSPEC, AI_ADDRCONFIG)` in the thread pool. It honours `/etc/hosts`, nsswitch and resolv.conf timeouts (not `dns-timeout-ms`). Lookups are blocking, so 4 threads can be saturated by slow names; raise `resolver-threads`.
- Built-in client (when any `dns-server` is set): A then AAAA over UDP to each server in turn, with `dns-timeout-ms` per query. It has **no EDNS0, no TCP fallback** (a TC bit means try the next server), and **predictable query IDs** (`counter ^ pid ^ ms`, `dns.c:158-162`). The connected UDP socket, with its kernel-random source port, is the main anti-spoofing measure.
- The cache is keyed by lowercase name, shared, and holds negative entries too. TTL is min(record TTL, `dns-ttl-s`); getaddrinfo results have no TTL, so they get `dns-ttl-s`.
- **GNOME:** leave `dns-server` unset and point the host at a decent local resolver (systemd-resolved or unbound). If the host's resolver strips private answers (as this LAN's router does), that is extra protection.

### 5.12 Flow control and tuning

- The advertised window is `min(buffer-remaining, stream-queue-max / 2 / (max-message-size − 5))`, which is **8 packets with the defaults** and logged at startup: `buffer-remaining 128 capped to 8: 1048576-byte packets must fit in half of stream-queue-max 16777216` (`server.c:148-157`, `336-340`).
- The window counts DATA packets per TCP stream (client→remote only). The CONTINUE is held while bytes toward the remote are still queued. Server→client has no window: backpressure pauses all of a connection's remote reads when its send queue passes `ws-write-high-water`, and resumes them at 1/4 of it.
- Uploads can move at most `window × packet size` per round trip; downloads aren't windowed. Browsing is download-heavy, so the defaults are fine. The upstream config comment notes `max-message-size = 262149` + `stream-queue-max = 67108864` gives a window of 128 (wispurr parity), at a higher worst-case per-stream memory cost (and that key can't be set on 32-bit, §7.4).

### 5.13 Logging (`src/common/log.c`)

- Destination: **stderr only**, one `write(2)` per line, lines ≤ 1024 bytes (truncated). There is no syslog, no file and no JSON. Under systemd the journal captures it. A GNOME supervisor should read the child's stderr.
- Format: `YYYY-MM-DDTHH:MM:SS.mmmZ [level] tag: message` (UTC), for example `2026-11-09T23:02:47.219Z [info] server: listening on 127.0.0.1:16000 with 12 workers, flood protection on, reputation on`. Parse with `^(\S+) \[(debug|info|warn|error)\] ([^:]+): (.*)$`.
- Levels: `debug` < `info` < `warn` < `error` < `none` (`warning` is accepted as `warn`).
  - `info`: startup, window cap, listen line, egress/filter refusals **with client IP and destination host:port**, auth failures with username, THROTTLE tier.
  - `warn`: STRICT refusals, flood closes, Twisp refusals, reputation save errors, out of fds.
  - `debug`: every connection, upgrade version, stream open/close **with host:port**, close reasons.
  - Use `warn` in production for privacy and `info` when debugging policy.

### 5.14 Stats and health endpoints

On the Wisp port, unauthenticated, any method, `Connection: close`:

```json
GET /health -> {"status":"ok"}
GET /stats  -> {"uptimeSeconds":0,"connections":{"total":13,"active":1},"streams":{"total":10,"active":0},
               "bytes":{"in":92,"out":1842},"refused":{"connectionRate":0,"connectionLimit":0,"reputation":0},
               "blocked":{"filter":0,"egress":8},"throttled":{"source":0,"dest":0,"syns":0},"synSignatures":0,
               "wsClosedViolations":0,"authFailures":0,"dnsCacheEntries":2,"reputation":{"sources":1,"destinations":0}}
```

`connections.active` includes the HTTP request currently being served. `/health` only proves that a
worker loop answered. There is no Prometheus format; the GNOME backend can poll
`http://127.0.0.1:6001/stats` and re-export it. The same counters are available in-process through
`hw_server_stats_get()` (`include/holywisp/server.h:114-137,158`).

### 5.15 Signals and lifecycle (`src/server/main.c`, `server.c:419-489`)

| Signal | Behaviour (verified) |
| --- | --- |
| SIGTERM, SIGINT | `hw_server_stop()`: all worker loops stop at once, the maintenance thread does a final reputation save, open connections are torn down (clients see a **bare TCP close, no WebSocket close frame, no Wisp CLOSE**), log `server: shutting down`, exit 0. **No draining** |
| **SIGHUP** | **No handler: the process dies (wait status 129).** systemd counts SIGHUP as a clean exit (`systemd.service(5)`, systemd 262: "a clean exit means … SIGHUP, SIGINT, SIGTERM, or SIGPIPE"), so with the shipped `ExecReload=/bin/kill -HUP $MAINPID` + `Restart=on-failure`, `systemctl reload holywisp` **stops the service and leaves it stopped**. The systemd outcome is from the documented semantics and was not run under systemd here |
| SIGPIPE | ignored |
| SIGUSR1/2 | default action (terminate); not used |
| Reload | **none**: any config change needs a restart |

Other lifecycle facts:

- **`SO_REUSEPORT` lets a second instance share the port silently.** Verified: two `holywisp --port 16004` processes both listen and the kernel splits connections between them, with no `EADDRINUSE`. A supervisor must make sure the previous instance has exited before starting a new one, or a stale process with old config keeps serving part of the traffic.
- The signal handler calls `hw_server_stop()`, which takes a pthread mutex (`server.c:459`). That is not async-signal-safe and could in theory deadlock if the signal lands on the maintenance thread while it holds the lock. Low risk.

### 5.16 Password auth (Wisp v2)

- `password-user USER:PASS`. If PASS starts with `$` it is checked with `crypt_r(candidate, stored)` and compared in constant time; otherwise it's a constant-time plaintext compare (`conn.c:553-582`). Failures log at `info` with the username, count in `authFailures`, and add `authFailure` (+10).
- Verified (`t3_upgrade.py` H): with `$6$` and `password-required`:
  - v1 client: 426
  - v2 without credentials: `CLOSE(0, 0xc2)` "authentication required"
  - wrong password: `CLOSE(0, 0xc0)`
  - correct: relay works
- Hash families (`t6_musl_crypt.sh`): the glibc + libxcrypt build accepts `$6$` (sha512crypt), `$y$` (yescrypt) and `$2b$` (bcrypt). The **musl static build rejects `$y$`** (a correct password still gets `0xc0`); `$6$` and `$2b$` work.
- Not useful for GNOME, because no browser transport sends credentials (§5.4).

---

## 6. GNOME integration: hardened setup behind the Rust gateway (task 4)

### 6.1 Topology

```
browser (Scramjet/UV SW + epoxy|libcurl transport)
   │  wss://gnome.example/wisp/      (TLS, Origin, session cookie)
   ▼
GNOME gateway (Axum/Tokio, public port)
   │  validate Origin + session → rewrite headers → TCP connect 127.0.0.1:6001
   │  write upgrade request → relay HolyWisp's response head → copy_bidirectional
   ▼
holywisp (127.0.0.1:6001, egress policy, limits) ──► Internet (optionally via SOCKS5/HTTP proxy)
```

### 6.2 Gateway contract: what HolyWisp needs (verified behaviour)

HolyWisp accepts a forwarded upgrade with any Host and any path, with no Origin, and with the
client's own key and subprotocol (§5.3). Things the gateway must do:

1. **Connect to `127.0.0.1:6001`**, not `localhost`, which may resolve to `::1` while HolyWisp listens on IPv4 only.
2. Forward **only** authenticated `GET /wisp/` upgrades. Never route public requests to HolyWisp's `/stats`, `/health` or `/`. Validating Origin is the gateway's job: HolyWisp has no CSWSH protection at all.
3. Copy unchanged: request line (method `GET`, `HTTP/1.1`), `Upgrade`, `Connection`, `Sec-WebSocket-Key`, `Sec-WebSocket-Version`, and `Sec-WebSocket-Protocol` if present. HolyWisp computes `Sec-WebSocket-Accept` from the key and echoes the first protocol token, and the browser checks both.
4. **Remove every client-supplied** `X-Forwarded-For`, `CF-Connecting-IP`, `X-Real-IP`, `True-Client-IP` and `Forwarded`, then add **exactly one** `X-Forwarded-For: <client-ip>` with a bare IP (no port, no brackets). If GNOME is itself behind a trusted CDN or reverse proxy, the gateway works out the real IP and still writes a single value. Configure HolyWisp with `trusted-proxy = 127.0.0.1/32`, `trusted-headers-reset = on`, `trusted-header = X-Forwarded-For`; §5.9 shows what goes wrong otherwise.
5. **Drop `Cookie` and `Authorization`** (and anything else not needed). This keeps the head under 8192 bytes and under 48 header lines (a cookie-heavy browser otherwise gets 400), and keeps the GNOME session cookie out of the relay process. `Sec-WebSocket-Extensions` may be dropped too, since HolyWisp never accepts it.
6. Relay HolyWisp's response head **verbatim**: `101`, or `400/403/426/429/503` with `Connection: close`. Then splice raw bytes both ways (`tokio::io::copy_bidirectional`), including any bytes read after the `\r\n\r\n`: HolyWisp sends the first Wisp frame immediately after the 101. Both a raw-TCP splice and hyper's upgrade API (`hyper::upgrade::on` on both sides, then `copy_bidirectional`) work, as long as rules 3–5 hold.
7. Serve `/wisp/` over **HTTP/1.1 only**. Do not enable RFC 8441 extended CONNECT (WebSocket over HTTP/2) for this route; HolyWisp only speaks RFC 6455 Upgrade.
8. Use **no short idle timeout** on spliced connections. Wisp connections are long-lived and HolyWisp sends no pings.
9. Enforce **per-user quotas** (bytes, concurrent WebSockets) in the gateway: HolyWisp's bandwidth limit doesn't work (§5.7) and all its limits are per IP.

Minimal forwarded request, the exact shape used in the tests:

```http
GET /wisp/ HTTP/1.1
Host: 127.0.0.1:6001
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <browser's key, unchanged>
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: <browser's value, unchanged; only if the browser sent one>
X-Forwarded-For: <client ip>

```

### 6.3 Recommended `holywisp.conf` for GNOME

Verified: this exact file loads with `holywisp --config` and behaves as annotated (`t8_gnome_conf.sh`):

- `/health` ok, `GET /` → 426, `GET /wisp/` (plain) → 426
- `example.org:80` → 200 over v1 and v2
- `smtp.gmail.com:25` → `0x48` (filter)
- `1.1.1.1:80` → 301 (direct IP allowed)
- `10.0.0.1`, `169.254.169.254`, `localhost:6001` → `0x48`
- UDP → `0x48`
- XFF honoured and CF-Connecting-IP ignored (debug log `(203.0.113.9)`, `(203.0.113.10)`, CF-only → `(127.0.0.1)`)

A copy is at `SP/scripts/holywisp/gnome-holywisp.conf`.

```ini
# holywisp.conf for GNOME: HolyWisp behind the GNOME gateway (Rust/Axum) on the same host.
# The gateway terminates TLS, accepts wss://<public>/wisp/, checks Origin + session cookie, rewrites
# the client-IP headers, forwards the HTTP Upgrade to 127.0.0.1:6001 and splices the socket.
# Verified against holywisp 0.1.0 (e0a0f15). Keys not listed keep their compiled-in defaults.
# 32-bit (armhf/i386) builds: do NOT add ws-write-high-water or stream-queue-max (see report).

# ---------------------------------------------------------------- listening
host = 127.0.0.1                 # never "" (all interfaces): HolyWisp has no Origin check and no auth
port = 6001
workers = 0                      # one per CPU; 4 on a Raspberry Pi 4
log-level = warn                 # info also logs every refused destination with the client IP

# ---------------------------------------------------------------- what clients may reach
allow-tcp = on
allow-udp = off                  # Scramjet/UV transports (epoxy, libcurl) use TCP only
allow-direct-ip = on             # literal IPs; class checks below still apply (a *.nip.io name gets the same reach)
allow-private = off
allow-loopback = off
allow-link-local = off
# Ports every browser refuses for http(s)/ws(s) (Fetch Standard "bad port" list, whatwg/fetch e9460d1).
# Blocking them costs no web compatibility and closes SMTP/SSH/IRC/etc. abuse through the relay.
block-port = 1
block-port = 7
block-port = 9
block-port = 11
block-port = 13
block-port = 15
block-port = 17
block-port = 19-23
block-port = 25
block-port = 37
block-port = 42-43
block-port = 53
block-port = 69
block-port = 77
block-port = 79
block-port = 87
block-port = 95
block-port = 101-104
block-port = 109-111
block-port = 113
block-port = 115
block-port = 117
block-port = 119
block-port = 123
block-port = 135
block-port = 137
block-port = 139
block-port = 143
block-port = 161
block-port = 179
block-port = 389
block-port = 427
block-port = 465
block-port = 512-515
block-port = 526
block-port = 530-532
block-port = 540
block-port = 548
block-port = 554
block-port = 556
block-port = 563
block-port = 587
block-port = 601
block-port = 636
block-port = 989-990
block-port = 993
block-port = 995
block-port = 1719-1720
block-port = 1723
block-port = 2049
block-port = 3659
block-port = 4045
block-port = 4190
block-port = 5060-5061
block-port = 6000
block-port = 6566
block-port = 6665-6669
block-port = 6679
block-port = 6697
block-port = 10080

# ---------------------------------------------------------------- protocol
enable-v2 = on                   # wisp-js defaults to v2; epoxy/libcurl use v1 (both fine)
enable-twisp = off               # remote shell; must stay off
motd =
password-required = off          # no browser transport can send Wisp v2 credentials; the gateway authenticates
# (no password-user lines)

# ---------------------------------------------------------------- who the client is
parse-real-ip = on
trusted-proxy = 127.0.0.1/32     # the GNOME gateway
trusted-headers-reset = on       # drop the compiled-in CF-Connecting-IP / X-Forwarded-For pair ...
trusted-header = X-Forwarded-For # ... and trust exactly one header, which the gateway overwrites

# ---------------------------------------------------------------- per-client limits
connections-limit-per-ip = 200   # new WebSockets per real client IP per window
connection-window-s = 10
bandwidth-limit-kbps = 0         # ineffective in 0.1.0 (downloads not limited); enforce in the gateway
max-streams-per-conn = 512

# ---------------------------------------------------------------- flood protection (defaults kept)
flood-protection = on
max-connects-per-source-per-second = 500
max-connects-per-dest-per-second = 100
max-connects-per-dest-per-minute = 3000
max-in-flight-syns = 4096
max-concurrent-connections = 10000
syn-signature = on
ws-close-after-violations = 64
log-blocked-dials = off

# ---------------------------------------------------------------- reputation
# IP reputation locks a client IP out (HTTP 403 at upgrade) after ~6 hostname lookups that resolve to
# private addresses, decaying 1 point/hour; the gateway already authenticates users, so it is off.
reputation = off
reputation-store =               # memory only if you turn it back on (no on-disk log of client IPs)

# ---------------------------------------------------------------- where streams go
# proxy = socks5h://user:pass@10.64.0.1:1080   # optional, global, TCP only
proxy-udp = refuse
# dns-server unset: use the system resolver (the built-in client has no EDNS0/TCP fallback)
dns-ttl-s = 120
dns-negative-ttl-s = 10
dns-order = ipv4first
dns-timeout-ms = 3000
resolver-threads = 8             # getaddrinfo is blocking; more threads = less head-of-line blocking

# ---------------------------------------------------------------- tuning (defaults kept)
connect-timeout-ms = 15000
handshake-timeout-ms = 10000
tcp-nodelay = on
tcp-quickack = on
listen-backlog = 1024
serve-webclient = off            # no demo page on GET /
non-ws-response = ""             # plain HTTP gets 426; /health and /stats still answer
```

Decisions that differ from upstream defaults, and why:

| Key | Upstream | GNOME | Reason |
| --- | --- | --- | --- |
| `host` | `""` (binary) / `127.0.0.1` (package) | `127.0.0.1` | No auth or Origin check on the port |
| `allow-udp` | on | off | The browser transports are TCP-only; this removes the UDP abuse surface |
| `allow-direct-ip` | off | **on** (operator choice) | Off breaks sites and game servers addressed by IP. It is little real protection, since wildcard DNS (`1.2.3.4.nip.io`) reaches the same addresses, and the private/loopback/link-local classes stay denied. Set it off for a stricter posture |
| `block-port` | none | Fetch "bad ports" | Browsers never use them for web traffic; blocks SMTP/SSH/IRC relaying |
| `trusted-*` | none / CF + XFF | `127.0.0.1/32`, XFF only | §5.9 |
| `reputation` | on | off | §5.8 lockouts; the gateway authenticates users |
| `max-streams-per-conn` | 2048 | 512 | Bounds per-connection memory; still far above what a browser opens (libcurl-transport pools 50 connections) |
| `max-concurrent-connections` | 50000 | 10000 | Self-hosted scale; lower it on a Pi (e.g. 2000) |
| `resolver-threads` | 4 | 8 | Blocking getaddrinfo |
| `serve-webclient`, `non-ws-response` | on, banner | off, `""` | Nothing but Wisp, `/health` and `/stats` on the port |
| `log-level` | info | warn | Privacy (info logs refused destinations with client IPs) |

Keep `ws-write-high-water`, `stream-queue-max` and `max-message-size` at their defaults. The first two
keys break 32-bit builds (§7.4), and lowering `max-message-size` risks 1009 disconnects (§5.4).

### 6.4 Supervision

**A. HolyWisp as a systemd service** (the Debian/RPM package or a manual install, §7.7). Override the broken reload and point it at the GNOME config:

```ini
# /etc/systemd/system/holywisp.service.d/gnome.conf
[Service]
ExecStart=
ExecStart=/usr/bin/holywisp --config /etc/holywisp/holywisp.conf
# SIGHUP kills holywisp; make `systemctl reload` an error instead of a silent stop
ExecReload=
Restart=always
```

This drop-in is written from systemd semantics and is **UNVERIFIED** here (systemd units could not be run in this environment).

**B. HolyWisp as a child of the GNOME binary** (single-binary or Docker deployments). Recommendations, all following from verified behaviour:

- Spawn `holywisp --config <path>`, with `SIGHUP` set to `SIG_IGN` before `exec`. Ignored dispositions survive `exec` and HolyWisp installs no SIGHUP handler. Alternatively, put the child in its own session/process group so a terminal hangup can't kill it.
- Set `PR_SET_PDEATHSIG` (SIGTERM) in the child so it doesn't outlive a crashed parent. A leftover process would keep sharing the port through `SO_REUSEPORT`.
- Before restarting, send SIGTERM and **wait for exit**, then start the new process. Poll `GET http://127.0.0.1:6001/health` for readiness; the listener is bound before workers start, typically within milliseconds.
- Capture stderr and re-log it through GNOME's logger (format in §5.13). A non-zero exit at startup means a config error: exit 2 is a parse error, exit 1 is validation or bind.
- Restart with backoff. Expect clients to reconnect after a restart: epoxy and libcurl rebuild their Wisp connection on demand.

### 6.5 Residual risks

- Any local process, or a web page in a browser running on the same host, can reach `127.0.0.1:6001` and use it as an unauthenticated relay (still subject to the egress policy). If that matters, run HolyWisp in its own network namespace or container that only the gateway can reach (§7.6).
- `/stats` is unauthenticated (counters only).
- Egress checks rely on HolyWisp's own DNS answer. A proxy (or the target) resolving differently is outside HolyWisp's control.
- Per-destination rate limits are server-wide: 100 connects/s to one `ip:port` (for example a CDN) is shared by all users. Raise it for larger deployments.

---

## 7. Portability (task 5)

### 7.1 Requirements

Linux (epoll), CMake ≥ 3.20, a C11 compiler (GCC and Clang are both CI-tested, `.github/workflows/build.yml`), bash, libxcrypt, libutil. At runtime the dynamically linked build needs `libc.so.6` + `libcrypt.so.1` (Debian `libcrypt1`). On Arch/CachyOS, `libcrypt.so.1` comes from `libxcrypt-compat`, and a binary built *on* Arch links `libcrypt.so.2`.

### 7.2 glibc floor depends on the build host (verified with `objdump -T`)

| Built on | Max symbol version needed | Runs on |
| --- | --- | --- |
| Debian 13 trixie (glibc 2.41, GCC 14.2) | `GLIBC_2.38` (`__isoc23_strtol`/`__isoc23_strtoll`, pulled in by `_GNU_SOURCE` with glibc ≥ 2.38 headers) | glibc ≥ 2.38: Debian 13, Ubuntu 24.04, Pi OS trixie. **Not** Debian 12 / Pi OS bookworm |
| Debian 12 bookworm (glibc 2.36, GCC 12.2) | `GLIBC_2.34` | glibc ≥ 2.34: Debian 12, Ubuntu 22.04, Pi OS bookworm, RHEL 9 |
| upstream CI `ubuntu-22.04` / `ubuntu-22.04-arm` | release notes say "glibc 2.35+" (`.github/workflows/release.yml:6-9,230-231`) | as stated; **UNVERIFIED** (assets not downloaded) |

Build distributable binaries on the **oldest** distro you support (bookworm), or ship the static musl build.

### 7.3 aarch64 / Raspberry Pi 4

- Upstream publishes `holywisp-linux-arm64.tar.gz` (built natively on `ubuntu-22.04-arm`) at `https://github.com/Fracital/holyWisp/releases/download/latest/` (`README.md:26-32`). No `.deb` for arm64 is built (`release.yml` builds only amd64 `.deb` and x86_64 `.rpm`).
- **Cross-compile (verified build, binary not executed):**

  ```sh
  # Debian trixie: dpkg --add-architecture arm64; apt install crossbuild-essential-arm64 cmake ninja-build libcrypt-dev:arm64
  make release CC=aarch64-linux-gnu-gcc \
    CMAKE_FLAGS="-DHW_BUILD_TESTS=OFF -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64"
  # -> ELF 64-bit ARM aarch64, NEEDED libcrypt.so.1 libc.so.6, max GLIBC_2.38 (use a bookworm cross env for Pi OS bookworm)
  ```

- Native on the Pi (**UNVERIFIED** on hardware): `sudo apt install build-essential cmake ninja-build libcrypt-dev && make release`, about 1 s of compile on x86. Add `make test` for confidence; ASan works on aarch64 Debian.
- Tuning for a Pi 4 (4 cores, 1–8 GB):
  - `workers = 4`.
  - Lower `max-concurrent-connections` (e.g. 2000) and `max-streams-per-conn`.
  - Keep reputation off, or memory-only, to avoid the 30-second SD-card rewrites.
  - The upstream unit's `MemoryMax=1G` is a reasonable cap.

### 7.4 32-bit ARM (armhf) and other ILP32 targets: config bug

- An armhf cross build (`crossbuild-essential-armhf`, `libcrypt-dev:armhf`) **compiles without warnings**. GCC's default `-Wshift-overflow=1` doesn't flag shifting into the sign bit.
- In `config.c:121-122` the upper bound `1L << 31` overflows a 32-bit `long` to a negative number, so **every value of `ws-write-high-water` and `stream-queue-max` is rejected**. Verified on an i386 (ILP32) build run natively:
  - `--ws-write-high-water 8388608` → `bad value`, exit 2
  - `deploy/holywisp.conf:95` and `holywisp.conf.example:93` both fail to load
  - Defaults with no config run fine
- armhf has the same 32-bit `long`. Its binary could not be executed here, but the C semantics are identical.
- **Workaround:** omit both keys (the defaults are the same values). **Fix to upstream:** use `INT32_MAX`/`LONG_MAX`, or parse with `long long`.

### 7.5 musl and static linking

- **Static musl is verified.** On Alpine 3.22, `make release CMAKE_FLAGS="-DCMAKE_EXE_LINKER_FLAGS=-static"` builds a statically linked binary and `ctest` passes 16/16. The server is 958 KB unstripped and 239 KB stripped. musl ships empty `libcrypt.a`/`libutil.a`, so `-lcrypt -lutil` resolve.
- It runs unchanged on any x86_64 Linux. Its DNS goes through musl's resolver (`/etc/hosts` + `/etc/resolv.conf`, no NSS), which worked in Docker.
- Caveat: `crypt()` lacks yescrypt `$y$` (§5.16).
- **Static glibc:** not tried. glibc warns that `getaddrinfo` in static binaries needs the matching shared NSS libraries at runtime, so prefer musl (**UNVERIFIED** here).

### 7.6 Docker

There is no upstream Dockerfile. This recipe was verified, image `gnome-hw-scratch:test`, 386 kB. It ran with `--read-only --cap-drop ALL --security-opt no-new-privileges` as UID 65534 on a user-defined network. From a second container, `/health` → ok and a relay to `example.org:80` → `HTTP/1.1 200 OK`.

```dockerfile
# build stage (each step verified with docker run; not run as one multi-stage build)
FROM alpine:3.22 AS build
RUN apk add --no-cache build-base cmake ninja linux-headers bash
COPY holywisp/ /src/
WORKDIR /src
RUN make release CMAKE_FLAGS="-DHW_BUILD_TESTS=OFF -DCMAKE_EXE_LINKER_FLAGS=-static" \
 && strip build/release/holywisp build/release/holywisp-client

FROM scratch
COPY --from=build /src/build/release/holywisp /holywisp
COPY gnome-holywisp.conf /etc/holywisp/holywisp.conf
USER 65534:65534
EXPOSE 6001
ENTRYPOINT ["/holywisp", "--config", "/etc/holywisp/holywisp.conf"]
```

In a separate container:

- HolyWisp must bind `0.0.0.0` *inside* the container (`--host 0.0.0.0`; flags override the file).
- Set `trusted-proxy` to the gateway container's IP or the Docker network's CIDR.
- Only the gateway should share that network.
- Docker's own ranges (172.16/12 etc.) are "private", so the relay can't reach other containers. That is good.

If GNOME runs HolyWisp as a child inside its own container, keep `127.0.0.1` and the config as is.

### 7.7 The systemd unit and packaging (`deploy/`)

`deploy/systemd/holywisp.service`:

- `Type=exec`, `User=wisp`/`Group=wisp`
- `ExecStart=/usr/bin/holywisp --config /etc/holywisp/holywisp.conf`
- `ExecReload=/bin/kill -HUP $MAINPID` (**broken**, §5.15)
- `LimitNOFILE=262144`, `MemoryMax=1G`, `TasksMax=512`, `Restart=on-failure`, `RestartSec=2s`
- Sandbox: `NoNewPrivileges`; empty `CapabilityBoundingSet`/`AmbientCapabilities`; `ProtectSystem=strict` + `ReadWritePaths=/var/lib/holywisp`; `ProtectHome`; `PrivateTmp`; `PrivateDevices`; all `ProtectKernel*`; `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`; `ProtectProc=invisible` + `ProcSubset=pid`; `RestrictNamespaces`, `LockPersonality`, `MemoryDenyWriteExecute`, `RestrictRealtime`, `RestrictSUIDSGID`, `RemoveIPC`; `KeyringMode=private`; `RestrictAddressFamilies=AF_INET AF_INET6`; `SystemCallArchitectures=native`; `SystemCallFilter=@system-service` minus `@privileged @obsolete @cpu-emulation @swap @reboot @mount @debug @raw-io`; `UMask=0077`

Assessment:

- `systemd-analyze security --offline=true` (systemd 262) gives **1.3 OK**. The remaining flagged items are inherent to a relay: AF_INET/6 allowed, no `PrivateNetwork`, no `IPAddressDeny`, `@resources` allowed.
- `RestrictAddressFamilies` forbids AF_UNIX, so NSS modules that talk over Unix sockets (nscd, `nss-resolve` varlink) will fail. getaddrinfo should then fall back to plain DNS via resolv.conf (**UNVERIFIED**).
- Optional defence in depth: `IPAddressDeny=` for private ranges. Localhost must stay allowed for the gateway, and so must the DNS server's address (**UNVERIFIED**).

Packaging:

- `deploy/systemd/holywisp.sysusers` creates `wisp` with home `/var/lib/holywisp` and shell nologin.
- `deploy/systemd/holywisp.tmpfiles` creates `/etc/holywisp` **0750 `wisp:wisp`**, which contradicts `deploy/debian/postinst:24`'s `root:wisp`. The config itself is `0640 root:wisp`. `/var/lib/holywisp` is 0750 `wisp:wisp`.
- `deploy/package.sh deb|rpm|all` builds into `build/packages/` (its header comment says `deploy/out/`). The deb `Depends: libc6, libcrypt1, adduser`, and the config is a conffile. postinst creates the user and dirs, then enables and restarts the unit when systemd is running. purge deletes `/etc/holywisp` and `/var/lib/holywisp`.
- `deploy/rpm/holywisp.spec` is the RPM spec (`%systemd_post` etc.; says `License: MIT`).
- A manual install from source follows `README.md:127-140`.

---

## 8. Benchmarks (task 6)

**What `bench/` compares** (`bench/README.md`, `bench/RESULTS.md`, `bench/run.py`): **servers** holyWisp, wispurr (Go), wispurr (C++23) and wisp-server-python. **wisp-js is only a client** (wispmark's `client/js/client.mjs`, wisp-js 0.4.1 on Node 24.16). **epoxy-server is not part of the comparison.**

Method:

- wispmark-style: a counting TCP echo (`bench/echo.c`) on loopback, one server at a time in front of it, and the metric is bytes per second crossing the echo port in one direction.
- Server CPU-seconds and peak RSS are recorded.
- The native load generator is `bench/pump.c` (modes `tp`, `rtt`, `churn`).
- Every server runs a "speed profile" with flood protection, reputation and connection limits **off** and loopback/literal IPs allowed (`run.py:39-41`).

Run: 2026-11-06 on a Ryzen 9 7950X, kernel 7.0.10 (Fedora 44). holyWisp `cb2510a`, wispurr Go `36de32e` (go1.26.4), wispurr C++23 with GCC 16.2.1, wisp-server-python `deeb390` (Python 3.13.15, websockets 13.1). Medians of 3 × 10 s.

| Scenario (MiB/s) | holyWisp | holyWisp 32 MiB sockbuf | wispurr Go | wispurr C++23 | wisp-server-python |
| --- | --- | --- | --- | --- | --- |
| wisp-js, 10 streams | 1,156 | 1,166 | 929 | 1,065 | 685 |
| wisp-js, 5 conns × 10 streams | 2,551 | 2,667 | 1,538 | 1,829 | 1,080 |
| native, 1 stream | 1,554 | 1,745 | 2,108 | **2,889** | 609 |
| native, 10 streams | 1,689 | 1,682 | 2,189 | **2,859** | 686 |
| native, 10 streams, 1 MiB packets | 1,663 | 1,855 | 1,915 | **2,636** | DNF |
| native, 8 conns × 4 streams | **5,884** | 5,872 | 3,029 | 5,154 | 3,229 |
| native, 16 conns × 4 streams | 4,958 | **5,381** | 2,414 | 3,314 | 2,031 |
| 64 B RTT p50 / p99.9 (µs) | **28 / 77** | 29 / 86 | 35 / 170 | 29 / 89 | 46 / 236 |
| churn (lifecycles/s), peak RSS | 16,295, **4.0 MiB** | 16,260, 3.95 MiB | 19,831, 404 MiB | 16,556, 11 MiB | 15,902, 976 MiB |

Reading:

- holyWisp leads the wispmark (wisp-js) scenarios and the multi-connection scenarios, and uses the least memory by far.
- The C++23 wispurr wins whenever a single connection carries everything, because it splits one connection's two directions across two cores.
- These are upstream's numbers (**UNVERIFIED** here; the competing servers weren't available).

Local sanity check (`t9_bench.sh`, this host, a Ryzen 5 5600G with 12 threads, inside Docker, 5 s each). `make bench` built `echo`/`pump` from the copied source.

| Profile | pump tp 1 stream | pump tp 10 streams | rtt 64 B p50 / p99.9 |
| --- | --- | --- | --- |
| upstream speed profile | 1,638 MiB/s | 1,691 MiB/s | 23 / 46 µs |
| GNOME config (§6.3) + `--allow-loopback` | 1,556 MiB/s | 1,753 MiB/s | 23 / 46 µs |

The hardened policy costs essentially nothing on the data path. The window was 8 in both (no stalls).

How to rerun upstream's bench:

```sh
make bench    # release build + build/bench/{echo,pump}
python3 -I bench/run.py --duration 10 --repeats 3 --out bench/results/full
python3 -I bench/charts.py bench/results/full --png
# subsets: --only holywisp,wispurr-cpp   --scenarios native-10,rtt-64   (--replace to splice into a results dir)
```

`run.py` expects the other projects as **siblings of the holyWisp checkout** (`SRC = ROOT.parent`, `run.py:29`), not literally `~/src`:

- `../wispurr/wispurr` (`go build -o wispurr main.go`)
- `../wispurr-cpp23/wispurr` (`make -C cpp -j LDFLAGS="-flto=auto -O3 -s"`, plus `#include <cstdint>` in `cpp/src/json.cpp` on GCC 16)
- `../wisp-server-python/.venv` (Python 3.13, `websockets<14`)
- `../wispmark/client/js` (with `npm install`)

Ports used: Wisp 16401, echo 16402. Outputs: `results.json`, `runs.jsonl`, `results.csv`, `results.md`, `logs/`, and charts with `--png`.

---

## 9. Issues found (consolidated)

| # | Severity for GNOME | Issue | Evidence | Mitigation / fix |
| --- | --- | --- | --- | --- |
| 1 | High (ops) | SIGHUP terminates the server, and the unit's `ExecReload` sends SIGHUP, so `systemctl reload` stops the service with no restart | `main.c:45-46`, `holywisp.service:22`; verified exit 129 | `ExecReload=` empty + restart on change. Child mode: ignore SIGHUP before exec |
| 2 | High (if headers are forwarded raw) | Real-IP spoofing behind a trusted proxy: CF-Connecting-IP checked first, first duplicate header wins, values truncated at 511 chars, headers after the 48th dropped | §5.9, `ws.c:198-204,225-230`, `filter.c:177-209`; verified | Gateway rewrites headers; `trusted-headers-reset` + XFF only |
| 3 | High (UX) | Reputation locks IPs out quickly (+15 per private-egress lookup, STRICT at 81, decay 1/h); the THROTTLE stream cap of 16 feeds back via violations | `reputation.c:52-72`, `conn.c:395-398`; verified 403 | `reputation = off` |
| 4 | Medium | `bandwidth-limit-kbps` ineffective: downloads unlimited, uploads ≈ 9× the cap, and one bucket covers both directions despite "each direction" in the docs | `conn.c:174-184,280,697`; measured | Rate-limit in the gateway |
| 5 | Medium (armhf Pi) | On 32-bit builds `ws-write-high-water` and `stream-queue-max` can't be set, and the shipped configs fail to load | `config.c:121-122`; verified on i386 | Omit the keys; upstream fix `INT32_MAX` |
| 6 | Medium (deploy) | Builds on glibc ≥ 2.38 need `GLIBC_2.38` (`__isoc23_strto*`) | `objdump -T` | Build on bookworm/22.04, or use static musl |
| 7 | Low/Medium | NAT64-wrapped public IPv4 (`64:ff9b::/96`) classified "reserved", so IPv6-only/DNS64 hosts can't reach IPv4-only sites | `net.c:241-246` (code reading) | Dual-stack hosts only, or patch |
| 8 | Low (ops) | `SO_REUSEPORT` lets a second instance co-bind the port silently | verified | Supervisor waits for exit; unique ports per instance |
| 9 | Low | Built-in DNS client: no EDNS0/TCP fallback, predictable query IDs | `dns.c:28-56,101,158-162` | Leave `dns-server` unset |
| 10 | Low | 429 response builds `Retry-After` but never sends it | `conn.c:497-499` | — |
| 11 | Low | Stream-confirm `0x05` honoured but not advertised in server INFO (spec 2.1) | `conn.c:403-416` | — |
| 12 | Low | Signal handler takes a mutex (not async-signal-safe) | `server.c:456-463`, `main.c:18-21` | — |
| 13 | Info | No Origin check and no auth on the Wisp port; `/stats` open | `conn.c:460-548`; verified | Loopback bind + gateway |
| 14 | Info | Twisp runs client-chosen commands (AGENTS.md says operator-chosen) | `twisp.c:86-104` | Keep off |
| 15 | Info | musl build rejects yescrypt `$y$` hashes | verified | Use `$6$`/`$2b$`, or the glibc build |
| 16 | Info | License metadata: `LICENSE` ISC vs README/RPM "MIT"; `/etc/holywisp` owner differs between tmpfiles (`wisp:wisp`) and postinst (`root:wisp`); `package.sh` comment says `deploy/out/` | files cited | Treat as ISC; fix packaging if shipping the .deb |
| 17 | Info | Reputation WARN tier has no effect (header comment says "logged") | `conn.c:385-401` | — |

---

## 10. Appendix

### 10.1 Verification scripts (all run inside containers)

Directory: `SP/scripts/holywisp/`

- Toolchain images (toolchain only, no project code): `debian/`, `bookworm/`, `alpine/`, `cross-arm64/`, `cross-armhf/`, `cross-i386/`
- Runtime image: `runtime/Dockerfile` (adds python3, curl, procps)
- Scratch image: `scratch-image/`
- Test scripts in `runtime/`:

  | Script | Covers |
  | --- | --- |
  | `t1_basic.sh` | task 2 |
  | `t2_policy.sh` | egress classes, reputation lockout, SIGHUP, `SO_REUSEPORT`, validation |
  | `t2b_dns.sh` | DNS-based egress |
  | `t3_upgrade.py` | path/Host/Origin, subprotocol, head limits, real IP, password, handshake timeout |
  | `t4_bandwidth.py`, `t4b_bandwidth_big.py` | bandwidth limiter |
  | `t5_wisp_raw.py` | Twisp refusal, UDP, SIGTERM behaviour |
  | `t6_musl_crypt.sh` | hash families glibc vs musl |
  | `t7_proxy_auth.py` | SOCKS5/HTTP proxy with credentials |
  | `t8_gnome_conf.sh` | recommended config |
  | `t9_bench.sh` | local bench |

  `cross-i386/build_and_probe.sh` covers the 32-bit config bug.
- Logs: `SP/results/holywisp/`

### 10.2 External references used

- Wisp protocol spec v2.1: `https://github.com/MercuryWorkshop/wisp-protocol` (default branch `v2`, `protocol.md`; latest commit `f01af89` 2026-11-06).
- npm packages inspected (via `npm pack`):
  - `@mercuryworkshop/wisp-js` 0.4.1 and 0.5.3 (latest)
  - `@mercuryworkshop/epoxy-transport` 3.0.2 (latest)
  - `@mercuryworkshop/epoxy-tls` 2.1.20-1 (latest)
  - `@mercuryworkshop/libcurl-transport` 2.0.6 (latest)
  - `libcurl.js` 0.7.5 (latest)
  - `@mercuryworkshop/proxy-transports` 1.0.2 (pinned by scramjet)
- epoxy-tls client source: `https://github.com/MercuryWorkshop/epoxy-tls` branch `multiplexed` (`client/src/lib.rs`, `stream_provider.rs`, `utils/js.rs`).
- Fetch Standard bad-port list: `https://fetch.spec.whatwg.org/#bad-port` (source `whatwg/fetch` `fetch.bs`, commit `e9460d1`, 2026-10-06; 83 entries including 0).
- systemd semantics: `systemd.service(5)` from systemd 262 (`Restart=`, `SuccessExitStatus=`).
- Mullvad SOCKS5 addresses: see `docs/research/mullvad-vpn.md` §4 (`10.64.0.1:1080` in-tunnel; per-relay `10.124.x.y:1080`).
