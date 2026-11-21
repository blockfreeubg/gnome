# GNOME VPN feature: research notes on Mullvad compatibility

Date: 2026-11-09 · Status: research input for implementers · Scope: how GNOME can offer a VPN
feature that works with a user's own Mullvad account or app, legitimately: no Mullvad code, no
Mullvad branding, no implied affiliation.

Legend: **VERIFIED** = read in source or observed by running something (method given).
**UNVERIFIED** = inferred or not testable here; treat as a hypothesis.

> **Implementation status (2026-11-11, integration review).** This report is the research input as written on
> 2026-11-09. **Mode B** (§2, §6: the device-side companion and the `mullvad` CLI) was **dropped**: GNOME is a website
> only (PROGRESS decisions log, 2026-11-09). **Mode A** is implemented by `services/vpn/` (recipe A: gluetun; recipe B:
> host WireGuard + Mullvad SOCKS5 exits; `profiles.example.toml`, `compose.example.yml`), `services/holywisp/`
> (`vpn-egress.conf.example`, `holywisp@.service`, `check-egress.sh`) and the gateway's `GNOME_VPN_PROFILES`
> (`/wisp/p/<id>/`; ARCHITECTURE §7, API.md). Where the implementation differs from this report:
> - Locations are static operator profiles in `GNOME_VPN_PROFILES`, one HolyWisp instance each. There is no
>   egress-agent, no `socks-proxies` catalog fetch and no gluetun control-API use; the names `GNOME_EGRESS_HOST`,
>   `GNOME_GLUETUN_API` and `GNOME_GLUETUN_API_KEY` in §5.4 are proposals, not settings.
> - The location is chosen in the user's browser (setting `vpn.preferredLocation`); the gateway routes `/wisp/p/<id>/`
>   to that profile's instance, with no per-user location table (§5.5).
> - Status: the server's `wisp.health` probe (TCP connect + WebSocket handshake + first Wisp frame, every 60 s) proves
>   only that a location's instance answers. The exit is verified by loading `verify_url`
>   (`https://am.i.mullvad.net/json`) through that location's path from the user's browser (§5.7 "User self-check").
>   There is no server-side exit probe and no automatic refusal of a location whose exit check failed (§5.3 "Fail
>   closed"); a dead tunnel still fails closed because its streams cannot connect.
> - `compose.example.yml` sets `PUBLICIP_ENABLED: "false"` (§5.4 shows `"true"`): GNOME verifies exits itself.

---

## 0. Decisions in brief

1. **Device-side integration (mode B) goes through the official `mullvad` CLI.** Do not use the
   gRPC socket. The CLI is user-facing and documented (Mullvad help page "How to use the Mullvad
   CLI"). `mullvad status --json` / `-j` exists (since 2024.5-beta1). A Mullvad contributor has
   said that scripts should use `--json` and that the default text output "is only intended to be
   human readable" (GitHub issue #7629). The gRPC interface is the private channel between Mullvad's
   own frontends and the daemon. Nothing documents it as stable. Its protobuf fields are removed
   without `reserved` markers, and the proto files and client crates are GPL-3.0-or-later.
2. **Even the JSON is not a stable schema.** The released 2026.5 CLI emits
   `details.location.hostname` (a string). Mullvad master (commit 549c371c53, 2026-10-21) replaces
   it with `details.location.location = {"hostname":[cc,city,host]}`. The companion must parse
   defensively and be tested against each Mullvad release.
3. **Server-side "browser-compatible VPN" (mode A) design for a Raspberry Pi 4 with Docker:**
   - `qmcgaw/gluetun:v3.41.3` runs the Mullvad WireGuard tunnel (one dedicated key, so one Mullvad
     device).
   - HolyWisp runs inside gluetun's network namespace (`network_mode: "service:gluetun"`).
   - Per-user exit location comes from Mullvad's per-relay SOCKS5 proxies
     (`10.124.x.y:1080`, reachable only through the tunnel), set as HolyWisp's upstream `proxy`.
     That gives ~536 exit relays in 91 cities from one tunnel.
   - HolyWisp's `proxy` is a single server-wide setting, so run **one HolyWisp instance per
     offered location**. The GNOME gateway routes each user's `/wisp/` upgrade to the matching
     instance.
4. **Honest status** comes from probing the real path. Fetch `https://ipv4.am.i.mullvad.net/json`
   through the same SOCKS endpoint or HolyWisp instance the user's traffic uses, then show
   `mullvad_exit_ip`, IP, city, country and the probe's age. The tunnel-level signal is gluetun's
   control API (`GET /v1/vpn/status`, `GET /v1/publicip/ip`, API-key protected). Do not claim
   anonymity, "protection", or anything about the user's device in mode A.
5. **Terms of service limit mode A to personal or household use with the operator's own account.**
   Mullvad's ToS: "You are prohibited from utilizing this service to provide a service similar to
   that provided by Mullvad or other services where VPN constitutes a significant part of the
   service", and "An account can be used on up to 5 devices". A public multi-tenant GNOME instance
   that sells or gives away VPN egress on one account must not be offered.
6. **Branding:**
   - No Mullvad logos, mole, colors or fonts.
   - The word "Mullvad" appears only in plain text to describe compatibility ("works with your
     Mullvad VPN account"), plus the disclaimer "GNOME is not affiliated with or endorsed by Mullvad
     VPN AB. Mullvad VPN is a trademark of Mullvad VPN AB."
   - Do not bundle or redistribute Mullvad binaries.
   - Treat the WireGuard mark carefully too (§8.2).

---

## 1. Sources, versions, method

| Item | Version / commit | Where |
|---|---|---|
| Mullvad VPN app source | master `b8e8e546761906599e153a0feffe4d410aea5ab3` (2026-11-09); tag `2026.5` read via raw.githubusercontent.com | `…/scratchpad/repos/mullvad` (partial clone), https://github.com/mullvad/mullvadvpn-app |
| Mullvad VPN app binaries | **2026.5** (`MullvadVPN-2026.5_amd64.deb`, GitHub release 2026-09-14; CHANGELOG date 2026-09-11). GPG signature verified: "Good signature from Mullvad (code signing)", primary key `A119 8702 FC3E 0A09 A9AE 5B75 D5A1 D4F2 66DE 8DDF` | https://github.com/mullvad/mullvadvpn-app/releases/tag/2026.5 |
| Mullvad Browser Extension (official) | 0.9.11, commit `d61963feafbc2e883e985047e4973a46193a28ea` (2026-11-06), GPL-3.0+ | https://github.com/mullvad/browser-extension |
| gluetun | **v3.41.3** (2026-07-30), MIT. The repo moved to `passteque/gluetun` (the old `qdm12/gluetun` URL redirects); image names unchanged: `qmcgaw/gluetun`, `ghcr.io/qdm12/gluetun` | https://github.com/passteque/gluetun, wiki https://github.com/qdm12/gluetun-wiki (commit `d117548`, 2026-11-07) |
| wireproxy | **v1.1.3** (2026-07-16), ISC. The repo is now `windtf/wireproxy` (old `octeep/`, `pufferffish/`, `whyvl/` URLs redirect) | https://github.com/windtf/wireproxy |
| HolyWisp | commit `e0a0f159eb6a168cbf67a7628687f9b244cbab48` (2026-11-07) | `…/scratchpad/repos/holywisp` (a separate report covers it; only the upstream-proxy and DNS keys are used here) |
| Mullvad web pages | fetched 2026-11-09 (each page's "Last updated" date is cited where used) | mullvad.net |

**Method.**
- Read the source at the commits above.
- Ran the official signed 2026.5 Linux binaries (`mullvad`, `mullvad-daemon`) inside a disposable
  `debian:trixie-slim` Docker container. The container had only `--cap-add NET_ADMIN`, no host
  networking and no `/dev/net/tun`. The .deb was unpacked with `dpkg-deb -x`, so no maintainer
  scripts ran. No Mullvad account was used, so Connected-state output could not be captured live
  (see §2.5).
- Called the public endpoints live on 2026-11-09 around 22:50 UTC.
- Checked serde layouts with a scratch Rust program that replicates the serde attributes. It is
  not shipped.

---

## 2. Integration surfaces on the user's device (mode B)

### 2.1 What exists

| Surface | Officially user-facing? | Use from GNOME? |
|---|---|---|
| `mullvad` CLI | **Yes.** Help page https://mullvad.net/en/help/how-use-mullvad-cli (last updated 2026-01-20); also `cli-command-wg` | **Yes**, as a subprocess, using `status -j` where possible |
| gRPC management interface (`ManagementService` over a UDS or named pipe) | No. Described as frontend↔daemon plumbing (`docs/architecture.md:40-46`); no stability promise found | **No** (§2.8) |
| Daemon cache `relays.json` (`/var/cache/mullvad-vpn/relays.json` on Linux) | No (internal `CachedRelayList` format, `mullvad-daemon-relay-selector/src/relay_list/update.rs:268-273`). A maintainer once suggested scripts read it (#2268, 2022) | Only as a fallback |
| `mullvad-exclude` (Linux split tunneling) | Yes, documented | Not needed |

### 2.2 Install layout and detection (VERIFIED unless marked)

| OS | CLI path | Daemon / service | RPC endpoint | Evidence |
|---|---|---|---|---|
| Linux (.deb/.rpm, package `mullvad-vpn`) | `/usr/bin/mullvad` | systemd `mullvad-daemon.service` (`ExecStart=/usr/bin/mullvad-daemon -vv --disable-stdout-timestamps`, `Environment="MULLVAD_RESOURCE_DIR=/opt/Mullvad VPN/resources/"`) and `mullvad-early-boot-blocking.service`; GUI in `/opt/Mullvad VPN/` | UDS `/var/run/mullvad-vpn` | .deb 2026.5 contents and control file; `mullvad-paths/src/rpc_socket.rs:10-13` |
| macOS | `/usr/local/bin/mullvad` → symlink to `<INSTALL_DIR>/Mullvad VPN.app/Contents/Resources/mullvad` | LaunchDaemon label `net.mullvad.daemon`, `/Library/LaunchDaemons/net.mullvad.daemon.plist`; app at `/Applications/Mullvad VPN.app` | UDS `/var/run/mullvad-vpn` | `dist-assets/pkg-scripts/postinstall:43-60,104-110`; `mullvad-daemon/src/macos.rs:15` |
| Windows | `C:\Program Files\Mullvad VPN\resources\mullvad.exe`. `<INSTDIR>\resources` is added to the system PATH, but Mullvad's own test runner uses the absolute path because "The `mullvad` binary is seemingly not in PATH on Windows after upgrading the app" | Service `mullvadvpn` (`sc.exe start mullvadvpn`) | Named pipe `//./pipe/Mullvad VPN` (`\\.\pipe\Mullvad VPN`) | `dist-assets/windows/installer.nsh:265,290,471-502`; `test/test-runner/src/app.rs:8-14`; install dir locked to `C:\Program Files\Mullvad VPN` (CHANGELOG.md:3261) |

Detection procedure for the companion:
1. Locate the binary: absolute path per OS first, then `which mullvad`.
2. Run `mullvad --version`. It works **without** the daemon and prints `mullvad-cli 2026.5`
   (VERIFIED). Parse `split_whitespace().nth(1)`, which is what Mullvad's own test runner does
   (`test/test-runner/src/app.rs:21-27`).
3. Run `mullvad version`. This needs the daemon. On success:
   ```
   Current version       : 2026.5
   Is supported          : true
   Suggested upgrade     : none
   ```
   A `mullvad-daemon version : …` line appears only when the daemon version differs from the CLI's
   (`mullvad-cli/src/cmds/version.rs:16-18`).
4. Treat versions below **2024.5** as unsupported, because they have no `--json`
   (CHANGELOG.md:834, "Add `--json` flag to `mullvad status` CLI" under 2024.5-beta1).
5. Pass through `MULLVAD_RPC_SOCKET_PATH` if it is set. The CLI honors it
   (`mullvad-paths/src/rpc_socket.rs:3-8`).

Access control on the socket (VERIFIED):
- The socket is created with mode **0766** and is owned by root. In the container it showed as
  `srwxrw-rw- root root`. Code: `mullvad-management-interface/src/lib.rs:223-228`.
- As user `nobody`, `mullvad status`, `mullvad lockdown-mode set off` and
  `mullvad relay set location se` all succeeded. So any local user can read and change VPN state.
- If the daemon runs with `MULLVAD_MANAGEMENT_SOCKET_GROUP=<group>`, the socket is chowned to that
  group with mode 0760 (lib.rs:186-194; README.md:196-198).
- Consequence: a companion running as the desktop user needs no elevation. It must also not widen
  this trust to arbitrary web pages (§6.4).

### 2.3 CLI command reference (2026.5, relevant subset)

Top level (`mullvad --help`): `account, auto-connect, beta-program, lockdown-mode, dns, lan,
connect, disconnect, reconnect, relay, api-access, anti-censorship, split-tunnel, status, tunnel,
version, factory-reset, reset-settings, custom-list, import-settings, export-settings, log`.
The hidden `debug` and `shell-completions` commands are excluded. Definitions are in
`mullvad-cli/src/main.rs:61-216`.

| Command | What it does (daemon RPCs) | stdout on success | Companion |
|---|---|---|---|
| `mullvad status [-v\|-d\|-j] [listen]` | GetTunnelState + GetDevice; `listen` adds EventsListen | text, or one JSON object per line (§2.5) | **yes** (`-j`) |
| `mullvad connect [-w]` | GetDevice, ConnectTunnel; `-w` waits until Connected and fails with "Failed to connect" on Error (`cmds/tunnel_state.rs:7-31`) | nothing, or a warning block when logged out | yes, without `-w` |
| `mullvad disconnect [-w]` | DisconnectTunnel("mullvad disconnect") | with `-w`: `Disconnected` | yes |
| `mullvad reconnect [-w]` | ReconnectTunnel; fails with "Not reconnecting due to being in disconnected state" | | yes |
| `mullvad relay list` | GetRelayLocations, **active relays only** (`cmds/relay.rs:741-768`) | text tree (§2.4); no JSON option | yes (parse) |
| `mullvad relay get` | GetSettings | text (§2.4) | yes |
| `mullvad relay set location <COUNTRY> [CITY] [HOSTNAME] \| <HOSTNAME>` | validates against the relay list, then SetRelaySettings | `Relay constraints updated` | **yes** |
| `mullvad relay set location any` | clears the location constraint | `Relay constraints updated` | yes |
| `mullvad relay set custom-list <NAME>`, `provider <P>...`, `ownership any\|owned\|rented`, `ip-version any\|v4\|v6`, `multihop on\|off` (2026.5; master changes this to an enum), `entry location …` / `entry custom-list …`, `custom …` | SetRelaySettings | `Relay constraints updated` | `ownership` only, optional |
| `mullvad relay update` | UpdateRelayLocations (background) | `Updating relay list in the background...` | optional |
| `mullvad account get [-v]` | UpdateDevice, GetDevice, GetAccountData | **prints the account number in clear text** (`cmds/account.rs:110`) | only to derive logged-in yes/no; never forward the output |
| `mullvad account login [N]`, `logout`, `create`, `list-devices`, `revoke-device`, `redeem` | account ops | | **never expose** |
| `mullvad lockdown-mode get\|set on\|off` | | `Block traffic when the VPN is disconnected: off` | read-only |
| `mullvad auto-connect get\|set` | | `Autoconnect: off` | no |
| `mullvad lan get\|set allow\|block` | | `Local network sharing setting: block` | no |
| `mullvad version` | GetCurrentVersion, GetVersionInfo | §2.2 | yes |
| `mullvad export-settings -` | ExportJsonSettings; printed `{}` on a default install | | no |
| `mullvad tunnel get` | | fails with `No account number is set` when logged out | no |

`relay set location` semantics (VERIFIED by running it):
- `se`, `se got`, `se got se-got-wg-001`, `se-got-wg-001` and `any` succeed.
- **Arguments are case-sensitive.** `SE` and `SE-GOT-WG-001` give `Error: Invalid location argument`
  with exit code 1. Unknown `xx` and `se zzz` give the same error. The hostname comparison is
  `relay.hostname.to_lowercase() == args.country` without lowercasing the argument
  (`cmds/relay.rs:705-709`).
- A hostname must belong to an `active` relay. Otherwise the error is "The relay `…` is not valid
  for this operation" (`cmds/relay.rs:710-719`).
- Validate input with regexes before spawning anything. Checked against all 557 live WireGuard
  relays with zero misses:
  - country `^[a-z]{2}$`
  - city `^[a-z]{3}$`
  - hostname `^[a-z]{2}-[a-z]{3}-wg-[0-9]{3}$`

### 2.4 Exact text formats (VERIFIED from code and captured output)

The `print_option!` macro prints 4 spaces, a 24-character left-aligned `Label:`, then the value
(`mullvad-cli/src/format.rs:13-18`).

```
$ mullvad status
Disconnected
    Visible location:       United States, Arlington. IPv4: 203.0.113.7
```
- The location string is `Country[, City][. IPv4: a.b.c.d][, IPv6: …]` (`format.rs:198-210`).
- Connected prints `Connected` followed by `Relay:`, `Features:` (comma-separated display names
  such as `Quantum Resistance`) and `Visible location:`. Keys are sorted by (length, name), and
  `Tunnel interface:` appears only with `-v` (`format.rs:142-196`).
- With multihop the relay line reads `<exit> via <entry>`.
- `-v` adds `hostname (ip:port/UDP)`.
- Error states print `Blocked: <cause>`. When the firewall could not block traffic, these two lines
  go to stderr: `Mullvad daemon failed to setup firewall rules!` and
  `Daemon cannot block traffic from flowing, non-local traffic will leak` (`format.rs:286-321`).

```
$ mullvad relay list            # 727 lines on 2026-11-09; TAB-indented
Albania (al)
<TAB>Tirana (tia) @ 41.32795°N, 19.81902°W
<TAB><TAB>al-tia-wg-001 (45.142.26.2, 2a04:27c0:0:e::f001) - hosted by iRegister (rented)
...
<blank line between countries>
```
- Grammar (`cmds/relay.rs:260-296`):
  - country line: `^(?P<name>.+) \((?P<cc>[a-z]{2})\)$`
  - city line: `^\t(?P<name>.+) \((?P<code>[a-z]{3})\) @ (?P<lat>-?[0-9.]+)°N, (?P<lon>-?[0-9.]+)°W$`
  - relay line: `^\t\t(?P<host>\S+) \((?P<v4>[^,)]+)(, (?P<v6>[^)]+))?\) - hosted by (?P<prov>.+) \((?P<own>rented|Mullvad-owned)\)$`
- **Quirk:** the °N/°W labels never change, and the numbers are signed decimal degrees. Buenos
  Aires prints `-34.47456°N, -58.66452°W`. Parse the numbers and ignore the labels.
- City names may contain commas, for example `Ashburn, VA`. Anchor the regex on the trailing code.

```
$ mullvad relay get
Generic constraints
    Location:               city got, se, hostname se-got-wg-001     # or "country us", "any"
    Provider(s):            any
    Ownership:              any
WireGuard constraints
    IP protocol:            any
    Multihop state:         disabled
    Multihop entry:         country us
```

```
$ mullvad account get           # logged out
Not logged in on any account
# logged in (cmds/account.rs:109-127): "Mullvad account:    <16 digits>", "Expires at:         <chrono local DateTime>",
# "Device name:        <pretty name>"  ← the account number is a bearer credential: discard it
```

### 2.5 JSON output: `mullvad status -j` (2026.5)

Behavior:
- **Flags go before the subcommand.** `mullvad status -j listen` works; `mullvad status listen -j`
  fails with `error: unexpected argument '-j' found` (VERIFIED; the args sit on `status`, see
  `main.rs:146-153`).
- `-j` conflicts with `-v` and `-d` (`cmds/status.rs:17-30`). Output is `serde_json::to_string`
  plus a newline (`status.rs:119-134`).
- **A non-JSON line can come first on stdout.** For Connecting, Connected and Error states, when
  logged out or revoked, the CLI prints `Warning: You are not logged in to an account.` (or
  `Warning: This device has been revoked.`) before the JSON (`status.rs:88,100-113`). This was
  VERIFIED live. Parse only lines that start with `{`.

Shape: an adjacently tagged enum `{"state": <snake_case>, "details": …}`
(`mullvad-types/src/states.rs:67-90`).

Captured live (2026.5, IP replaced):
```json
{"state":"disconnected","details":{"location":{"latitude":38.9064,"longitude":-77.1278,"ipv4":"203.0.113.7","ipv6":null,"mullvad_exit_ip":false,"hostname":null,"city":"Arlington","country":"United States","entry_hostname":null,"entry_city":null,"entry_country":null},"locked_down":false}}
{"state":"disconnected","details":{"location":null,"locked_down":true}}
{"state":"error","details":{"cause":{"reason":"tunnel_parameter_error","details":"no_matching_relay"},"block_failure":{"reason":"generic"}}}
```
The `block_failure` in the error line comes from the container lacking a full firewall setup. On a
healthy host it is `null`.

Connected example. This was not captured, since that needs an account. It was built from the
2026.5 serde attributes and confirmed with a scratch serde program:
```json
{"state":"connected","details":{"endpoint":{"address":"185.213.154.66:51820","protocol":"udp","quantum_resistant":true,"obfuscation":null,"entry_endpoint":null,"tunnel_interface":"wg0-mullvad","daita":false},"location":{"latitude":57.70887,"longitude":11.97456,"ipv4":"203.0.113.10","ipv6":null,"mullvad_exit_ip":true,"hostname":"se-got-wg-001","city":"Gothenburg","country":"Sweden","entry_hostname":null,"entry_city":null,"entry_country":null},"feature_indicators":["QuantumResistance"]}}
{"state":"disconnecting","details":"reconnect"}
{"state":"error","details":{"cause":{"reason":"is_offline"},"block_failure":null}}
{"state":"error","details":{"cause":{"reason":"auth_failed","details":"[EXPIRED_ACCOUNT]"},"block_failure":null}}
```

Field reference (2026.5):
- `state`: `disconnected | connecting | connected | disconnecting | error`.
- `details.endpoint`: `TunnelEndpoint`, with `Endpoint {address:"ip:port", protocol:"udp"|"tcp"}`
  flattened in, plus `quantum_resistant`, `obfuscation`, `entry_endpoint`, `tunnel_interface`
  (e.g. `wg0-mullvad`) and `daita` (`talpid-types/src/net/mod.rs:26-37,185-192,401-409`).
  - `obfuscation` is externally tagged: `{"Single":{"endpoint":{…},"obfuscation_type":"udp2tcp"|"Shadowsocks"|"Quic"|"Lwo"}}`
    or `{"Multiplexer":{"direct":…,"obfuscators":[…]}}`. Lowercase the type before comparing, as
    Mullvad's own e2e test does (`desktop/packages/mullvad-vpn/test/e2e/installed/lib/tunnel-helpers.ts:30-41`).
- `details.location` (GeoIpLocation, 2026.5): `latitude, longitude, ipv4, ipv6, mullvad_exit_ip,
  hostname, city, country, entry_hostname, entry_city, entry_country`. The daemon fills it in from
  am.i.mullvad.net after each state change, so expect a second event for the same state
  (`format.rs:23-29`).
- `details.feature_indicators`: a JSON array of strings with no order. The 2026.5 set is
  `QuantumResistance, Multihop, SplitTunneling, LockdownMode, WireguardPort, Udp2Tcp, Shadowsocks,
  Quic, Lwo, LanSharing, DnsContentBlockers, CustomDns, ServerIpOverride, CustomMtu, Daita,
  DaitaMultihop`. Master drops `DaitaMultihop` and adds `MultihopAuto` and `CustomVpn`. **Treat the
  set as open.**
- `details` for disconnecting: `"nothing" | "block" | "reconnect"`.
- `details` for error: `{cause:{reason, details?}, block_failure: null | {reason, details?}}`.
  - `reason` values (2026.5, desktop): `auth_failed` (details look like `"[INVALID_ACCOUNT]"`,
    `"[EXPIRED_ACCOUNT]"`, `"[TOO_MANY_CONNECTIONS]"`, see `mullvad-types/src/auth_failed.rs`),
    `ipv6_unavailable`, `set_firewall_policy_error`, `set_dns_error`, `create_tunnel_device`
    (Windows), `start_tunnel_error`, `tunnel_parameter_error`, `is_offline`, `split_tunnel_error`,
    `need_full_disk_permissions` (macOS).
  - `tunnel_parameter_error` details: `no_matching_relay_entry`, `no_matching_relay_exit`,
    `no_matching_relay`, `no_matching_bridge_relay`, `custom_tunnel_host_resolution_error`,
    `{"ip_version_unavailable":…}`.
  - If `block_failure` is non-null, the daemon is **not** blocking traffic. Show that as a severe
    warning.

**Schema drift (VERIFIED).** Mullvad master, at commit 549c371c53 "Show connected server in relay
list" (2026-10-21), replaced GeoIpLocation's `hostname` and `entry_hostname` strings with
`location` and `entry_location` objects shaped like `{"hostname":["se","got","se-got-wg-001"]}` or
`{"city":["se","got"]}`. Mullvad's own e2e test reads `location.location.hostname[2]`. The gRPC
proto dropped fields `hostname = 8` and `entry_hostname = 10` without `reserved`. Expect this in the
next desktop release (UNVERIFIED timing). The companion should:
- accept either `details.location.hostname` (string) or `details.location.location.hostname[2]`;
- ignore unknown fields (no `deny_unknown_fields`);
- keep fixture tests per Mullvad version.

`mullvad status -j listen` (VERIFIED) emits newline-delimited JSON **without a type tag**, mixing:
- TunnelState objects (top-level `state`);
- Settings objects (top-level `relay_settings`; ~1.6 KB);
- RelayList, AppVersionInfo, Device, RemoveDevice and NewAccessMethod objects;
- leak events `{"interface":…,"reachable":[…]}` (`status.rs:33-80`).

Filter on a top-level `state` whose value is one of the five states. Never forward Settings lines:
they contain `api_access_methods.custom`, which can hold custom proxy credentials, plus custom lists
and DNS options (VERIFIED key list).

### 2.6 Errors and exit codes (VERIFIED on Linux)

- **Daemon not running or socket missing:** exit code 1, and stderr reads:
  ```
  Error: Management RPC server or client error

  Caused by:
      0: transport error
      1: No such file or directory (os error 2)
  ```
  `mullvad version` prints `Current version : 2026.5` first, then
  `Error: Failed to connect to mullvad-daemon`. The macOS and Windows wording and the "connection
  refused" variant are UNVERIFIED. Map any of these to `daemon: "not_running"`.
- **`mullvad connect` while logged out:** exit code **0**. It prints `Warning: You are not logged in
  to an account.` and a "Mullvad is blocking all network traffic…" block (`tunnel_state.rs:105-119`),
  and the state becomes `error`. Do not treat exit 0 as "connected". Read the state afterwards.
- Logged-in state without exposing the number: run `mullvad account get`, check for the literal
  lines `Not logged in on any account` or `The current device has been revoked`, otherwise treat as
  logged in. Drop the line holding the number immediately and never log it.

### 2.7 Gotchas checklist

- Pass arguments as an argv array, never through a shell.
- Use a timeout of 10 s or less per call, and avoid `-w`.
- Serialize mutating calls.
- Keep the environment minimal, passing `MULLVAD_RPC_SOCKET_PATH` through when set.
- Windows: use the absolute path and `CREATE_NO_WINDOW`.
- Any local user can control the daemon (§2.2), so the companion adds no privilege. The danger lies
  in exposing it to web origins.

### 2.8 The gRPC management interface: why not

Endpoint and transport:
- tonic gRPC over a Unix socket at `/var/run/mullvad-vpn` (Linux, macOS) or the named pipe
  `//./pipe/Mullvad VPN` (Windows). `MULLVAD_RPC_SOCKET_PATH` overrides it
  (`mullvad-paths/src/rpc_socket.rs:3-18`).
- The client uses a dummy URI (`lttp://[::]:50051`, "will be ignored", `lib.rs:146-158`).
- Proto package `mullvad_daemon.management_interface`, service `ManagementService`
  (`mullvad-management-interface/proto/management_interface.proto:10`).
- Relevant RPCs:
  - `ConnectTunnel(Empty) → BoolValue`
  - `DisconnectTunnel(StringValue) → BoolValue`
  - `ReconnectTunnel(Empty) → BoolValue`
  - `GetTunnelState(Empty) → TunnelState`
  - `EventsListen(Empty) → stream DaemonEvent`
  - `GetRelayLocations(Empty) → RelayList`
  - `SetRelaySettings(RelaySettings) → Empty`
  - `GetDevice(Empty) → DeviceState`
  - `GetWwwAuthToken(Empty) → StringValue`. By its name and use, this is a token for an
    authenticated mullvad.net session. It must never be reachable from a browser.
- There is also a `RelaySelectorService` (`relay_selector.proto`).

Reasons not to use it:
- **Not documented for third parties.** Nothing in README, docs or the proto promises stability.
  `docs/architecture.md:40-46` presents it as the path from Mullvad's frontends to the daemon.
- **It churns.** `management_interface.proto` has 98 `rpc` lines on master against 95 at 2026.5.
  Fields are removed without `reserved`, and there are migration RPCs such as "The great multihop
  migration of 2026" (proto:163-173).
- **Licensing.** The proto files and the `mullvad-management-interface` and `mullvad-types` crates
  are GPL-3.0-or-later (`Cargo.toml` `license = "GPL-3.0-or-later"`). Linking them, or generating a
  client from the protos, would pull GPL code into GNOME. Calling the CLI as a separate program keeps
  an arm's-length boundary. This is not legal advice.

### 2.9 Official statements about third-party clients and integrations

- **ToS** (https://mullvad.net/en/help/terms-service, last updated 2026-01-20): "To use the service,
  you need to use a Mullvad account number together with the Mullvad VPN app, or with another
  WireGuard® client and our downloadable configuration files." Third-party WireGuard clients such as
  gluetun, wireproxy or kernel `wg` are therefore explicitly fine with the downloaded configs. The
  same page holds the "5 devices" limit and the no-similar-service clause (§0.5).
- **Config generator:** https://mullvad.net/en/account/wireguard-config, referenced from the help
  page "WireGuard on Linux terminal (easy)" (last updated 2024-08-23), which says "If you are running
  WireGuard on multiple devices, generate a separate key for each device." The official Linux script
  `mullvad-wg.sh` (https://github.com/mullvad/mullvad-wg.sh) asks for the account number. GNOME
  should let the user generate the config themselves and import only `PrivateKey` and `Address`.
- **Routers:** "You can run Mullvad on more than five devices (all devices connected to the router)"
  (help "running-wireguard-router", last updated 2026-10-20). One WireGuard device serving a
  household is sanctioned. That is the model for mode A.
- **Partnerships** (https://mullvad.net/en/help/partnerships-and-resellers, 2026-10-20): Mozilla VPN,
  Tailscale and Obscura use Mullvad servers as formal partners. Building a VPN product on Mullvad's
  network takes a partnership; GNOME is not one.
- **CLI output:** contributor Serock3 on #7629 (2025-02-10): "you should prefer using the `--json`
  flag when parsing the output in a script. The default formatting is only intended to be human
  readable."
- No statement was found that makes the gRPC API, `api.mullvad.net` or `am.i.mullvad.net` available
  to third parties (§3.7).

---

## 3. Public HTTP APIs (VERIFIED live 2026-11-09)

### 3.1 Inventory

| Endpoint | Documented? | Size / count | Notes |
|---|---|---|---|
| `GET https://api.mullvad.net/app/v1/relays` | Yes: "Mullvad App API" OpenAPI at https://api.mullvad.net/app/documentation/ (spec `/static/openapi/app-api.5ec57b51118f.yaml`) | 621,565 B (88,407 B gzip); 557 WireGuard relays, 91 locations | Used by the app. **No SOCKS fields.** `openvpn.relays` is empty (OpenVPN removed 2026-01-15) |
| `GET https://api.mullvad.net/public/relays/wireguard/v2/` | Yes: "Mullvad Public API" at https://api.mullvad.net/public/documentation/ (spec `/static/openapi/public-api.facbd5fce2c2.yaml`) | 557 relays | App-like subset; no SOCKS fields |
| `GET https://api.mullvad.net/public/relays/wireguard/v1/` | Yes (Public API) | 536 relays, active only | Nested countries → cities → relays, with `multihop_port` |
| `GET https://api.mullvad.net/www/relays/all/` | No (backs the website server list, UNVERIFIED) | 296,074 B; 570 items (557 wireguard + 13 bridge) | Flat; **has `socks_name` and `socks_port`** |
| `GET https://api.mullvad.net/www/relays/wireguard/` | No | 557 | Same as above, WireGuard only (`/www/relays/bridge/` and `/openvpn/` return 404) |
| `GET https://api.mullvad.net/network/v1-beta1/socks-proxies` | No ("beta" in the path) | 557 (536 online) | Used by the official Mullvad Browser Extension (`src/composables/useSocksProxies.ts:10`). **Has the internal SOCKS IPs.** |
| `GET https://ipv4.am.i.mullvad.net/json`, `ipv6.am.i.mullvad.net/json`, `am.i.mullvad.net/json` | No | | Connection check. The daemon uses `https://ipv4.am.i.mullvad.net/json` and `ipv6.…` (`mullvad-daemon/src/geoip.rs:28-46,148`; `test/am-i-mullvad-client/src/lib.rs:56-71`) |
| `GET https://<uuid>.dnsleak.am.i.mullvad.net/` | No | | DNS-leak check used by the official extension |

### 3.2 `/app/v1/relays` fields

```
{ locations: { "<cc>-<city>": {country, city, latitude, longitude} },        // e.g. "se-got", "us-qas"
  openvpn:   { ports:[{port, protocol}], relays:[] },
  wireguard: { port_ranges:[[53,53],[123,123],[4000,33433],[33565,51820],[52001,60000]],
               ipv4_gateway:"10.64.0.1", ipv6_gateway:"fc00:bbbb:bbbb:bb01::1",
               shadowsocks_port_ranges:[[51900,51949]],
               relays:[{hostname, location:"al-tia", active, owned, provider, ipv4_addr_in, ipv6_addr_in,
                        weight, include_in_country, stboot, public_key, daita?,
                        features?:{daita?, lwo?, lwo_v2?, quic?:{addr_in[], domain, token}},
                        shadowsocks_extra_addr_in?[]}] },
  bridge:    { relays:[…], shadowsocks:[{cipher, password, port, protocol}] } }
```
The port ranges above are the live values. The OpenAPI example shows a slightly different first
range.

### 3.3 `/www/relays/all/` fields (one flat object per server)

Common fields:
- `hostname`: e.g. `al-tia-wg-001`.
- `country_code`: ISO-3166 alpha-2, lowercase. 50 countries; UK is `gb`.
- `country_name`.
- `city_code`: 3 lowercase letters, a Mullvad code that is not always IATA (`qas` = Ashburn). 91
  cities, none reused across countries.
- `city_name`.
- `fqdn`: `<hostname>.relays.mullvad.net`.
- `active`: bool. 536 true and 21 false among WireGuard relays.
- `owned`: bool, Mullvad-owned versus rented. 120 owned.
- `provider`: e.g. `M247`, `31173`, `DataPacket`, `Tzulo`.
- `ipv4_addr_in` and `ipv6_addr_in`: entry addresses; IPv6 is null for some bridges.
- `network_port_speed`: one of 1, 10, 20, 29, 40, 50, 100, 200. Unit probably Gbps (UNVERIFIED).
- `stboot`: bool. Meaning UNVERIFIED (probably System Transparency boot).
- `type`: `wireguard | bridge`.
- `status_messages`: `[{message, timestamp}]`, e.g. a notice about moving LAX servers.

WireGuard-only fields:
- `pubkey`.
- `multihop_port`, for WireGuard-level multihop.
- `socks_name`, always `<hostname with "-wg-" → "-wg-socks5-">.relays.mullvad.net` (557 of 557).
- `socks_port`, always `1080`.
- `daita`.

Bridge-only fields: `ipv4_v2ray`, `ssh_fingerprint_sha256`, `ssh_fingerprint_md5`.

### 3.4 `/network/v1-beta1/socks-proxies` fields (what GNOME should use for exits)

```json
{"online":true,"hostname":"al-tia-wg-socks5-001.relays.mullvad.net","ipv4_address":"10.124.1.240",
 "ipv6_address":"fd00:aaaa::494","location":{"city":"Tirana","code":"al-tia","country":"Albania",
 "longitude":19.819025,"latitude":41.327953},"port":1080,"weight":100}
```
- `ipv4_address` values span 10.124.0.2–10.124.2.114 (all inside 10.124.0.0/16 ⊂ 10.64.0.0/10).
  `ipv6_address` values are all in `fd00:aaaa::/64`.
- `online` equals the www `active` flag for every relay (0 mismatches).
- `weight` is 100 for 460 entries and **0 for 16**. Weight is meant for weighted random choice
  (Public API spec: "When selecting servers randomly, the weight should be used to decide how likely
  a server is to be picked").
- The official extension filters `online && ipv4_address && hostname`, uses
  **`host: ipv4_address`** with `proxyDNS: true` (remote DNS), and falls back to `10.64.0.1`
  (`src/helpers/socksProxy/getRandomSessionProxy.ts:33-35`, `constants.ts:3-8`).

### 3.5 Connection check `am.i.mullvad.net`

`GET /json` returns, live and not on Mullvad:
```json
{"ip":"…","country":"United States","city":"Arlington","longitude":-77.1278,"latitude":38.9064,
 "mullvad_exit_ip":false,"blacklisted":{"blacklisted":false,"results":[]},"organization":"…"}
```
- When the IP is a Mullvad exit, the response also carries `mullvad_exit_ip_hostname` (e.g.
  `se-got-wg-001`, documented in `test/am-i-mullvad-client/src/lib.rs:17-25`) and
  `mullvad_server_type`. Both are typed in the extension's `src/helpers/connCheck.types.ts:7-24`.
  The exact `mullvad_server_type` strings are UNVERIFIED. The SOCKS help page says the check shows
  "SOCKS5 through WireGuard" for proxied traffic.
- `blacklisted.results[]` entries have `{blacklisted, link, name}` per the extension's types. They
  were empty in the live response.
- The daemon models only `{ip, country, city?, latitude, longitude, mullvad_exit_ip}`
  (`mullvad-types/src/location.rs:141-150`).

Plain-text endpoints:
- `GET /ip` returns the IP.
- `GET /connected` returns `You are not connected to Mullvad. Your IP address is …`.
- `GET /country` and `GET /city` return the names.

The DNS-leak endpoint `GET https://<uuid4>.dnsleak.am.i.mullvad.net/` returns an array of the
resolvers that looked up the name, each `{hostname, ip, quad9_dns, mullvad_dns, city, country,
organization}` (VERIFIED live). The extension also types `server_type` and `mullvad_dns_hostname`.

### 3.6 CORS, caching, polling (VERIFIED)

- **No `Access-Control-Allow-Origin`** on `api.mullvad.net/*` or `am.i.mullvad.net/json`, even with
  an `Origin` header. `OPTIONS` on am.i returns 405. A web page cannot read them with `window.fetch`;
  the official extension can only because extensions hold host permissions.
- Every relay endpoint sends an `ETag` and `Last-Modified`, and `If-None-Match` returns **304**. No
  `Cache-Control` is sent.
- All four relay files had the same Last-Modified (2026-11-09 12:33 GMT), which suggests a batch
  publish (UNVERIFIED cadence).
- GNOME's backend should therefore:
  - fetch server-side at most every 1–6 h with `If-None-Match`, and refresh on demand when a
    selected proxy fails;
  - send a descriptive `User-Agent`;
  - serve its cached copy to the UI;
  - never make each browser hit Mullvad directly.

### 3.7 Is third-party use allowed?

There is **no explicit permission and no explicit prohibition** in the ToS, the API docs or the help
pages for third-party use of `api.mullvad.net` or `am.i.mullvad.net`.
- The Public API and App API have published OpenAPI documents, which reads as tolerance.
- The `www/` and `network/v1-beta1/` endpoints are undocumented and internal-looking, though used by
  Mullvad's own website and extension.
- Rate limits are UNVERIFIED.
- Recommendation: low-volume, cached, server-side use only. Degrade gracefully on schema changes.
  Optionally ask Mullvad support (support@mullvadvpn.net) for confirmation before a public GNOME
  release.

---

## 4. Mullvad SOCKS5 proxies (confirmed)

From https://mullvad.net/en/help/socks5-proxy (last updated 2026-07-30), quoted:
- "The SOCKS5 proxy is listening on 10.64.0.1 port 1080. The proxy is only accessible when you are
  connected to Mullvad VPN."
- "All our WireGuard servers have two SOCKS5 proxies listening on them: The SOCKS5 proxy on
  10.64.0.1 with port 1080 which is not reachable from other WireGuard servers. The SOCKS5 proxy on
  10.124.0.x to 10.124.1.x with port 1080 which is reachable from other WireGuard servers. These IPs
  are unique for each WireGuard server."
  - The live list already reaches **10.124.2.114**. Take addresses from the API, not from this
    range.
- "if you are connected to se-mma-wg-001 and then want to exit via nl-ams-wg-001, you would
  configure your browser to use nl-ams-wg-socks5-001.relays.mullvad.net on port 1080". The
  terminal example uses `curl --socks5-hostname` (remote DNS).
- "Each proxy has only one exit IP", and each proxy also has one IPv6 exit IP. The page lists static
  IPs and fewer CAPTCHAs as benefits.
- Older names like `nl1-wg.socks5.relays.mullvad.net` in the examples are legacy. The current
  pattern is `<cc>-<city>-wg-socks5-<NNN>.relays.mullvad.net`.

From https://mullvad.net/en/help/different-entryexit-node-using-wireguard-and-socks5-proxy
(2023-08-23):
- Traffic between servers is encrypted, but "if someone has root access to the first server and the
  user data transported is not encrypted, the person with root access can see the data".
- SOCKS5 is cleartext inside the tunnel, so **the entry relay sees SOCKS destination hostnames and
  any non-TLS payload.**

DNS gotcha (VERIFIED):
- The socks hostnames resolve **publicly** to private addresses. `al-tia-wg-socks5-001` gives
  `10.124.1.240` via 1.1.1.1 and 9.9.9.9 (TTL 3600).
- This host's network resolver (systemd-resolved, then the upstream router) returned **NOERROR with
  no answer**. That is consistent with DNS-rebinding protection upstream, though the cause is
  inferred.
- gluetun also blocks private answers by default unless the name is listed in
  `DNS_REBINDING_PROTECTION_EXEMPT_HOSTNAMES` (`setup/options/firewall.md:15`, `dns.md:15`).
- Rule: configure upstreams by IP literal from `socks-proxies.ipv4_address`, as the official
  extension does, and never by name.

UDP through Mullvad's SOCKS5 (ASSOCIATE) is UNVERIFIED, and HolyWisp never sends UDP through its
proxy anyway (§5.6).

---

## 5. Mode A: server-side egress ("browser-compatible VPN")

### 5.1 Requirements and constraints

- Pages fetched by GNOME's in-browser proxy follow the path Scramjet/UV → Wisp → GNOME gateway →
  HolyWisp → internet. Mode A makes HolyWisp's outbound leg exit through Mullvad, with an exit
  location chosen per user.
- This changes **only** traffic that goes through GNOME's proxy. The user's device, GNOME's own UI
  assets, and any WebRTC or other requests the user's browser makes directly are not affected.
- **ToS:** the operator's own account, for the operator and household only (§0.5). Show this notice
  in the admin UI before enabling.
- **Devices:** use one dedicated WireGuard key per deployment, which counts as one of the 5 device
  slots. Never reuse the key that the official app or another machine uses ("generate a separate key
  for each device").
- **Secrets:** GNOME stores only the WireGuard `PrivateKey` and `Address` from the config generator,
  never the account number.

### 5.2 Options compared

| | (a) gluetun + HolyWisp in its netns | (b) wireproxy (userspace WG → SOCKS5) | (c) kernel WireGuard in a netns | (d) Mullvad SOCKS5 relays |
|---|---|---|---|---|
| What it is | Container that runs WG (kernel or userspace), an iptables kill switch, DNS (DoT/DoH), health checks and a control API. Other containers share its netns | Single Go binary with a netstack WG client; exposes `[Socks5]`, `[http]`, TCP/UDP static tunnels | `ip link add … type wireguard`, moved into a netns where HolyWisp runs (https://www.wireguard.com/netns/) | Not a tunnel itself. One tunnel (a, b or c) plus `10.124.x.y:1080` exits chosen per user |
| Privileges | `NET_ADMIN` + `/dev/net/tun` | none (can run as an unprivileged user) | root at setup; HolyWisp unprivileged afterwards | n/a |
| Leak behavior when tunnel is down | Blocked: firewall default-deny, output allowed only via the VPN interface (`internal/firewall/iptables.go:134-139`), plus Mullvad endpoint and declared subnets | TCP fails, since the proxy is the only path. **But** HolyWisp, running outside the tunnel, resolves destinations for its egress policy using `dns-server` on the host network: **DNS leak** unless routed through a wireproxy `[UDPProxyTunnel]` | Blocked: wg0 is the only route in the netns | Inherits from the tunnel |
| DNS | Built-in forwarder on `127.0.0.1:53` in the netns (`internal/configuration/settings/dns.go:39-44,130-131`); DoT to Cloudflare by default; or use Mullvad's in-tunnel resolver `10.64.0.1` | Interface `DNS =` resolves SOCKS hostnames inside the tunnel; HolyWisp's own lookups as above | `/etc/netns/<ns>/resolv.conf` with `nameserver 10.64.0.1` | The exit relay resolves (SOCKS5 ATYP 3) |
| Health / status | Docker `HEALTHCHECK` (Dockerfile:232); auto-heal (`HEALTH_RESTART_VPN=on`); control API `/v1/vpn/status`, `/v1/publicip/ip` (API key) | `-i host:port` exposes `/metrics` (like `wg show`) and `/readyz` (503 if no pong from `CheckAlive` IPs) | DIY (`wg show <if> latest-handshakes`, probes) | Per-proxy probes (§5.7) |
| arm64 (Pi 4) | Image arches: 386, amd64, arm/v6, arm/v7, **arm64**, ppc64le (Docker Hub, tag v3.41.3) | Releases `wireproxy_linux_arm64.tar.gz`, `_arm`; image `ghcr.io/windtf/wireproxy:latest` (amd64, arm/v7, arm64, ppc64le, s390x; tags are commit SHAs only) | Raspberry Pi kernels: `CONFIG_WIREGUARD=m`, `CONFIG_TUN=m` in `bcm2711_defconfig` on rpi-6.6.y, 6.12.y and 6.18.y (default branch) | n/a |
| Per-user location | Only by pairing with (d), or one gluetun per location (uses up to 5 device slots, heavy) | Only with (d) via one `[TCPClientTunnel]` per SOCKS target (static config, restart to change), since HolyWisp cannot chain two SOCKS hops | With (d) | **Yes:** ~536 relays, 91 cities, one device slot |
| UDP | HolyWisp can relay UDP directly; it then exits at the tunnel relay, not the selected location | README: "currently only CONNECT is supported"; `[UDPProxyTunnel]` for fixed targets. go-socks5 v0.0.5 defaults to PermitAll with an ASSOCIATE handler, so actual behavior is UNVERIFIED | direct through the tunnel | no (HolyWisp refuses or bypasses UDP when a proxy is set) |
| Maturity | ~16k stars, active; v3.41.x is the stable line. Built-in SOCKS5 server (`SOCKS5_ENABLED`, supports CONNECT and UDP ASSOCIATE) is **only on master/`:latest`**, not in v3.41.3 | Active (v1.1.3); smaller project | Kernel-grade; custom glue | Documented Mullvad feature used by Mullvad's own extension; the `/network/v1-beta1` list is undocumented |
| Fit for GNOME on a Pi | **Best.** Turnkey Docker, kill switch, health, arm64 | Fallback when NET_ADMIN or TUN is impossible (rootless or LXC); must also fix DNS | Strong for bare-metal systemd installs without Docker; more glue | Use with (a) or (c) |

(e) Running the official `mullvad-daemon` inside a container is possible: it started and served the
CLI in the test container. It is **not recommended**. It is not a supported environment (split
tunneling failed: `Unable to create cgroup "/sys/fs/cgroup/net_cls" … Read-only file system`), it
wants dbus and systemd, and it needs the account number in the container.

### 5.3 Recommended architecture (Pi 4, 64-bit Raspberry Pi OS, Docker)

```
 browser ──wss──▶ gnome (Rust/Axum gateway, Docker net "gnome")      ┌── netns of container "gluetun" ───────────────┐
  Scramjet/UV        │  auth user, look up user's exit location        │  wg0 ⇄ Mullvad relay (1 device)                │
  + Wisp transport   │  proxy WS upgrade to gluetun:<port-for-loc>  ──▶│  holywisp@default :6001  proxy = (none)        │
                     │                                                  │  holywisp@se-sto  :6002  proxy=socks5://10.124.a.b:1080 ─▶ (via wg0) se-sto relay ─▶ Internet
                     │  GET gluetun:8000/v1/vpn/status (X-API-Key)       │  holywisp@us-nyc  :6003  proxy=socks5://10.124.c.d:1080 ─▶ (via wg0) us-nyc relay ─▶ Internet
                     │  reads probe results ◀───────────────────────────│  egress-agent: supervises instances, runs probes│
                     └─ SQLite: locations cache, user prefs, probe log   └────────────────────────────────────────────────┘
```

- **Tunnel:** gluetun with Mullvad WireGuard pinned to a nearby city (`SERVER_CITIES`, optionally
  `OWNED_ONLY=yes`). This hop carries all egress.
- **Locations:** the operator enables a short list of exit cities, for example 3–10, since every
  instance costs a process. Each enabled city maps to one HolyWisp instance whose `proxy` is an IP
  literal from `socks-proxies`. "Default" uses no proxy, so it exits at the tunnel relay's IP pool.
  Alternatively, `socks5://10.64.0.1:1080` gives that relay's single static exit IP.
- **Instances are per location, not per user.** HolyWisp's `proxy` is server-wide
  (`src/server/proxy.c:192-204` reads `s->conn->w->server->proxy`) and resolved once at startup
  (`proxy.c:107-130`). Many users share an instance. Note that HolyWisp's per-IP limits and
  reputation are per process.
- **egress-agent** (small, written by GNOME) runs in the same netns. It:
  - writes per-instance configs from GNOME's cached proxy list;
  - restarts an instance when its proxy goes `online:false` or fails probes, failing over to
    another online proxy in the same city (weighted random, weight > 0);
  - runs probes (§5.7).
  A plain supervisor (s6, supervisord) plus a script is fine for v1.
- **Routing:** the gateway authenticates the session on the `/wisp/` WebSocket upgrade (cookies are
  sent for same-origin upgrades), looks up `user → location → port`, and proxies to
  `ws://gluetun:<port>/`. Per gluetun's docs, a container on the same Docker network reaches a
  gluetun-attached service as `gluetun:<port>` with no published ports
  (`setup/inter-containers-networking.md:12-20`).
- **Fail closed:** if a location's last probe says `mullvad_exit_ip:false`, or the tunnel is down,
  refuse that location's upgrades and show the reason. Do not fall back to direct egress.

### 5.4 Reference configuration (adapt; values marked `<…>`)

`compose.yaml` (written for this report; checked against gluetun v3.41.3 docs and HolyWisp keys):
```yaml
services:
  gluetun:
    image: qmcgaw/gluetun:v3.41.3            # pin by digest in production
    cap_add: [NET_ADMIN]
    devices: ["/dev/net/tun:/dev/net/tun"]
    environment:
      VPN_SERVICE_PROVIDER: mullvad
      VPN_TYPE: wireguard
      WIREGUARD_ADDRESSES: "<10.x.y.z/32 from the generated .conf Address, IPv4 part>"
      SERVER_CITIES: "<e.g. Stockholm>"      # gluetun city names, e.g. "Ashburn VA" (not "Ashburn, VA")
      # OWNED_ONLY: "yes"
      # WIREGUARD_IMPLEMENTATION: auto       # kernelspace if the host has the module, else userspace
      HTTP_CONTROL_SERVER_ADDRESS: ":8000"   # reachable only on the Docker network; do NOT publish
      HTTP_CONTROL_SERVER_AUTH_DEFAULT_ROLE: '{"auth":"apikey","apikey":"${GLUETUN_API_KEY}"}'
      PUBLICIP_ENABLED: "true"               # uses ipinfo/ifconfig.co/ip2location/cloudflare; set false to avoid them
      UPDATER_PERIOD: "168h"                 # refresh bundled server data (v3.41.3 data timestamp is 2025-10-03)
    secrets: [wireguard_private_key]         # read from /run/secrets/wireguard_private_key
    restart: unless-stopped

  egress:                                    # HolyWisp instances + egress-agent, sharing gluetun's netns
    image: <gnome/egress:tag>
    network_mode: "service:gluetun"
    depends_on: { gluetun: { condition: service_healthy } }
    volumes: ["egress-config:/etc/gnome-egress"]   # written by the gnome backend

  gnome:
    image: <gnome/server:tag>
    ports: ["443:8443"]
    environment:
      GNOME_EGRESS_HOST: gluetun             # ws://gluetun:<port>
      GNOME_GLUETUN_API: http://gluetun:8000
      GNOME_GLUETUN_API_KEY: ${GLUETUN_API_KEY}
    volumes: ["egress-config:/var/lib/gnome/egress"]

secrets:
  wireguard_private_key: { file: ./secrets/wireguard_private_key }
volumes: { egress-config: {} }
```
- `docker run --rm qmcgaw/gluetun genkey` produces a 22-character base58 API key
  (`setup/advanced/control-server.md:81`).
- **Control-server auth in v3.41.3 must be set explicitly.** VERIFIED in
  `internal/server/middlewares/auth/settings.go:24-95`:
  - With no auth file and no default role, v3.41.3 installs a legacy role `"public"` with
    `auth: none` for `GET/PUT /v1/vpn/status`, `GET/PUT /v1/dns/status`,
    `GET/PUT /v1/updater/status`, `GET /v1/publicip/ip`, `GET /v1/portforward`, `GET /v1/version`
    and several legacy routes. Any container on the Docker network could then stop the VPN. The
    firewall stays up, so that is a DoS, not a leak; UNVERIFIED in a live test.
  - Setting `HTTP_CONTROL_SERVER_AUTH_DEFAULT_ROLE` (added in v3.41.0) applies to every route without
    a user-defined role, and the legacy public role is then **not** added: `SetDefaultRole` runs
    before `SetDefaults`, and `DefaultSlice` only fills an empty role list.
  - The wiki's "All routes are now private by default" describes master/`:latest`, which has no
    `SetDefaults` public role.
  - Auth method strings are `none`, `basic`, `apikey`. JSON keys: `auth`, `apikey`, `username`,
    `password`. Clients send the key in the `X-API-Key` header.
- Secret names come from `setup/advanced/docker-secrets.md`: `wireguard_private_key`,
  `wireguard_addresses`, `wireguard_conf`. A bind-mounted `/gluetun/wireguard/wg0.conf` is the
  alternative.
- Keep the Docker networks and LAN **outside `10.64.0.0/10`**. Mullvad tunnel addresses, the
  10.64.0.1 gateway and the 10.124.x.y SOCKS proxies all live there. Do not put that range in
  `FIREWALL_OUTBOUND_SUBNETS` (`firewall.md:14`).
- Never set `FIREWALL_VPN_INPUT_PORTS` for HolyWisp's ports.

HolyWisp instance config (keys from `README.md:103-122` and `holywisp.conf.example`; see the
HolyWisp report for semantics):
```ini
host = 0.0.0.0              # inside gluetun's netns; gluetun blocks VPN-side input by default
port = 6002
proxy = socks5://10.124.a.b:1080   # IP literal from socks-proxies; socks5h:// is an accepted alias. HolyWisp
                                   # always hands the proxy the hostname (ATYP 3), so the exit relay resolves it
proxy-udp = refuse          # or "direct": UDP then exits at the TUNNEL relay, not the selected city (disclose it)
dns-server = 10.64.0.1      # Mullvad's in-tunnel resolver (keeps lookups inside Mullvad); alt: 127.0.0.1 (gluetun DoT)
# keep the egress policy defaults: allow-private/allow-loopback/allow-direct-ip OFF. Otherwise users could reach
# gluetun's control API on 127.0.0.1:8000, the Docker network, or Mullvad-internal 10.x addresses
serve-webclient = off
parse-real-ip = on
trusted-proxy = <gateway container IP or Docker subnet>   # NOT 10.0.0.0/8 (overlaps Mullvad space)
trusted-header = X-Forwarded-For
```
HolyWisp resolves and policy-checks each destination **before** dialing the proxy (`AGENTS.md:145-149`).
Its `dns-server` therefore also sees the hostnames. With `10.64.0.1` that is still only Mullvad.

### 5.5 Location catalog and per-user selection

1. **Catalog.**
   - Every 1–6 h, conditionally GET `socks-proxies` and `www/relays/wireguard/`, the latter for
     `owned`, `provider` and `status_messages`.
   - Store rows `{socks_hostname, ipv4, ipv6, location_code "se-sto", country, city, lat, lon,
     online, weight, owned, provider, fetched_at, etag}`.
   - Join on `socks_hostname == socks_name`.
2. **Offered locations** = operator allowlist ∩ cities that have at least one `online` proxy with
   `weight > 0`.
3. **Choosing the proxy for a city.** Pick weighted-random over `online && weight>0`, then **pin**
   it and keep it while it stays healthy: each proxy has one static exit IP, so pinning avoids
   session or IP churn. On failure, re-pick from the same city.
4. **User preference:** `user_vpn_prefs(user_id, location_code | "default", updated_at)`. Changing
   it only affects new Wisp connections; existing streams keep their instance.

### 5.6 DNS, UDP, IPv6, leaks: what is actually true

- **DNS.** For proxied browsing, two parties see destination hostnames:
  1. HolyWisp's policy lookup, sent to `dns-server` (recommended `10.64.0.1`, through the tunnel);
  2. the SOCKS exit relay, which resolves remotely.
  Neither is the user's ISP or the Pi's ISP. Mullvad also hijacks port 53 on its servers ("We also
  hijack DNS requests (port 53) in order to prevent DNS leaks", ToS).
- **UDP.** It is refused while a location proxy is active. With `proxy-udp = direct` it exits at the
  tunnel relay, not the chosen city. Say so in the UI.
- **IPv6.** HolyWisp reaches the proxies over IPv4. The exit relay picks the destination address
  family (UNVERIFIED). The default (no-proxy) instance is IPv4-only unless gluetun gets an IPv6
  `WIREGUARD_ADDRESSES` and Docker IPv6 is on.
- **Visibility.** The TLS from the browser's Wisp transport is end-to-end, but the GNOME operator,
  the entry relay and the exit relay see destination hostnames, SNI and any plain-HTTP content.

### 5.7 Status signals GNOME can honestly show

| Signal | Source | Show as | Caveat |
|---|---|---|---|
| Tunnel up | gluetun `GET /v1/vpn/status` returns `{"status":"running"}` (header `X-API-Key`), plus the Docker health state of `gluetun` | "Server VPN tunnel: up / down" | "running" is not traffic proof. Health checks: TCP+TLS to `HEALTH_TARGET_ADDRESSES` (default `cloudflare.com:443,github.com:443`) at startup and every 5 min, ICMP to `1.1.1.1,8.8.8.8` every minute, restart on failure |
| Tunnel exit IP | gluetun `GET /v1/publicip/ip` returns `{"public_ip", "region"?, "country"?, "city"?, "hostname"?, "location"?, "organization"?, "postal_code"?, "timezone"?}` (`internal/models/publicip.go:8-16`) | admin-only detail | Comes from third-party echo services |
| **Exit verified per location** | egress-agent, inside the netns, through the **same** endpoint: `curl -sS --max-time 10 --socks5-hostname 10.124.a.b:1080 -H 'Accept: application/json' https://ipv4.am.i.mullvad.net/json` (default instance: no `--socks5-hostname`) | "Exit: Stockholm, Sweden. Verified via am.i.mullvad.net 3 min ago (Mullvad exit: yes, IP 203.0.113.x)" | Point-in-time. Re-probe on instance start, location change, every 15 min ± jitter, and on demand at most once per 60 s per location |
| End-to-end (optional) | GNOME backend acts as a Wisp client through the actual HolyWisp instance to `am.i.mullvad.net:443`, with TLS (e.g. crate `wisp-mux` 5.1.0, **LGPL-3.0-only**, last release 2024-08-09) | admin diagnostics | Checks the full chain including HolyWisp |
| User self-check | A "Check my exit" button opens `https://am.i.mullvad.net/json` **inside the user's Scramjet/UV session**, so it goes through Wisp, HolyWisp and the VPN | shown only to that user | `window.fetch` outside the proxy goes direct from the user's network (and CORS blocks it anyway) |
| DNS path (optional) | Fetch `https://<uuid>.dnsleak.am.i.mullvad.net/` through the path | "Resolvers seen: Mullvad (…)" | Lists every resolver that touched the name |
| Kill-switch test | In CI or setup: `PUT /v1/vpn/status {"status":"stopped"}`, then the probe **must fail**, then restart | admin checklist | Shows fail-closed behavior in that deployment |

UI wording rules for mode A:
- Say "server VPN egress" and "exit location".
- State the scope: "Only pages you open inside GNOME use this exit. Your device's own internet
  connection is unchanged."
- Never say "you are protected", "anonymous" or "no-logs", and never imply Mullvad endorses GNOME.
- When a probe is older than 30 min or failed, show "Unverified" and fail closed.

### 5.8 Option details for the alternatives

**wireproxy (b)**, config syntax per README v1.1.3:
```ini
WGConfig = /etc/wireproxy/mullvad.conf     # or inline [Interface]/[Peer]
[Interface]
CheckAlive = 10.64.0.1                     # /readyz returns 503 when pongs stop (CheckAliveInterval default 5 s)
[Socks5]
BindAddress = 127.0.0.1:25344              # optional Username/Password
[TCPClientTunnel]                          # one per Mullvad SOCKS exit, so HolyWisp needs a single SOCKS hop
BindAddress = 127.0.0.1:11001
Target = 10.124.a.b:1080
[UDPProxyTunnel]                           # gives HolyWisp an in-tunnel DNS: dns-server = 127.0.0.1:5353 (format UNVERIFIED)
BindAddress = 127.0.0.1:5353
Target = 10.64.0.1:53
```
Run with `wireproxy -c <file> -i 127.0.0.1:9080` for health. Then set HolyWisp's
`proxy = socks5://127.0.0.1:11001` for the se-sto instance.

**Kernel netns (c)**, following wireguard.com/netns:
```sh
ip netns add gnome-vpn
ip link add wg-mullvad type wireguard              # created in init netns: its UDP socket stays there
ip link set wg-mullvad netns gnome-vpn
ip netns exec gnome-vpn wg setconf wg-mullvad <(wg-quick strip /etc/wireguard/mullvad.conf)
ip -n gnome-vpn addr add <10.x.y.z/32> dev wg-mullvad
ip -n gnome-vpn link set lo up && ip -n gnome-vpn link set wg-mullvad up
ip -n gnome-vpn route add default dev wg-mullvad
mkdir -p /etc/netns/gnome-vpn && echo 'nameserver 10.64.0.1' > /etc/netns/gnome-vpn/resolv.conf
# gateway <-> HolyWisp: a veth pair on a /30 outside 10.64.0.0/10 (e.g. 169.254.64.0/30); bind HolyWisp to it
```
Run HolyWisp with `ip netns exec gnome-vpn …` or systemd `NetworkNamespacePath=/run/netns/gnome-vpn`.
Monitor `wg show wg-mullvad latest-handshakes` and run the probes. There is no automatic
reconnection logic beyond WireGuard's own handshakes.

---

## 6. Mode B: native companion (`gnome-vpn-companion`, Rust)

### 6.1 Role and what it can honestly claim

- **What it does:** it is a small per-user daemon on the user's own computer. It shows the state of
  the **user's installed Mullvad VPN app** in GNOME's UI and offers connect, disconnect, reconnect
  and location changes by calling the official `mullvad` CLI. It never handles the account number,
  login, vouchers, settings import/export, split tunneling or the website token.
- **Claims it can make:**
  - "Status reported by the Mullvad VPN app on this device."
  - "Requests sent to the Mullvad VPN app."
  - "Mullvad's connection check reports this device's traffic exits at <city> (Mullvad exit: yes)".
    The daemon's own `location.mullvad_exit_ip` comes from am.i.mullvad.net. Optionally the
    companion runs its own `GET https://ipv4.am.i.mullvad.net/json`, which goes through the system
    tunnel.
- **Claims it must not make:**
  - that GNOME provides or secures the VPN;
  - that pages browsed inside GNOME exit through the device VPN. When GNOME's server is remote,
    pages go **GNOME server → internet** and exit from the server's network unless mode A is on.
    Show both facts separately.
  - anything about leak-freedom beyond what the daemon reports. `status -j listen` emits leak
    events; show them if they occur.

### 6.2 Process model

- Runs as the desktop user: a systemd `--user` unit, a LaunchAgent, or a Windows per-user startup
  task. It does not need root (§2.2).
- If `MULLVAD_MANAGEMENT_SOCKET_GROUP` is in use, the user must be in that group. Surface the
  "permission denied" error.
- **Event source:**
  - Spawn `mullvad status -j listen`, read stdout line by line, keep lines starting with
    `{"state":` (TunnelState serializes `state` first), parse leniently and normalize.
  - Restart with backoff when it exits, for example when the daemon restarts.
  - Fall back to polling `mullvad status -j` every 5 s.
- **Commands** (argv exactly, no shell):
  - `["mullvad","connect"]`, `["mullvad","disconnect"]`, `["mullvad","reconnect"]`
  - `["mullvad","relay","set","location",cc[,city[,host]]]`, after regex validation and a check
    against the parsed `mullvad relay list`
  - `["mullvad","relay","list"]`, cached for 10 min
  - `["mullvad","--version"]`, `["mullvad","version"]`
  - `["mullvad","account","get"]`, logged-in flag only
- **Limits:** 10 s timeout, one mutating command at a time, 1 MiB stdout cap (more for the relay
  list), and stderr captured for error mapping.

### 6.3 Local HTTP API (proposal; JSON; all non-`hello` routes need auth)

Bind to `127.0.0.1:47821` (port arbitrary, configurable). Never bind `0.0.0.0` or `::`.

| Method + path | Body / response |
|---|---|
| `GET /v1/hello` | → `{"api":1,"app":"gnome-vpn-companion","version":"x.y.z","paired":bool}`. Returned only to the configured pairing origin; other origins get 403 with no CORS headers |
| `POST /v1/pair` | `{"code":"XXXX-XXXX"}` → `{"token":"<base64url 32 bytes>"}`. Only during an active pairing window |
| `DELETE /v1/pair` | revoke this token → 204 |
| `GET /v1/status` | → `Status` (below) |
| `GET /v1/events` | `text/event-stream` of `Status` objects. SSE cannot set headers, so authenticate either with a short-lived ticket from `POST /v1/events/ticket` in the query string, or by streaming over `fetch()` with an `Authorization` header |
| `POST /v1/connect`, `/v1/disconnect`, `/v1/reconnect` | `{}` → `{"accepted":true}`. Follow state through events |
| `GET /v1/locations` | → `[{"country_code","country","cities":[{"code","name","relays":[{"hostname","owned","provider"}]}]}]` from the parsed `relay list` |
| `PUT /v1/location` | `{"country":"se","city":"got"?,"hostname":"se-got-wg-001"?}` or `{"any":true}` → `{"ok":true}` or `{"error":"invalid_location"}` |

`Status` schema (owned by GNOME, stable):
```ts
type Status = {
  installed: boolean; cli_path?: string; cli_version?: string;      // from `mullvad --version`
  daemon: "running" | "not_running" | "permission_denied" | "unknown";
  logged_in?: boolean;                                              // never the account number
  state?: "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
  relay_hostname?: string; country?: string; city?: string;         // exit, when known
  entry_hostname?: string; mullvad_exit_ip?: boolean; locked_down?: boolean;
  error?: { reason: string; detail?: string; not_blocking?: boolean };  // not_blocking = block_failure != null
  features?: string[];                                              // raw indicator names, open set
  exit_ip?: string;                                                 // only if the user opted in to showing IPs
  observed_at: string;                                              // RFC 3339
};
```
Do not include the Disconnected-state `location` (the user's **real** geolocation and IP) unless the
user opts in.

### 6.4 Pairing and authorization (defend against arbitrary websites and DNS rebinding)

**Configured origin.** `gnome-vpn-companion pair --origin https://gnome.example` records one exact
origin (scheme, host and port). Only `https://…` or `http://localhost[:port]` are accepted, because
browsers allow Local Network Access only from secure contexts.

**Pairing window:**
- The command prints a code of 8 Crockford-base32 characters (about 40 bits), valid 120 s,
  single-use, at most 5 attempts, and logs the attempts.
- The user types the code into GNOME's UI, which sends `POST /v1/pair`.
- The companion accepts only if the window is open, `Origin` equals the configured origin exactly,
  and the code matches under constant-time compare (`subtle`).
- It then returns a random 32-byte token (`getrandom`) and stores only `sha256(token)`, the origin
  and the creation time. The config file is mode 0600:
  `~/.config/gnome-vpn-companion/config.toml` on Linux, `~/Library/Application Support/…` on macOS,
  `%APPDATA%\…` on Windows (via `directories::ProjectDirs`).

**Checks on every request**, in this order:
1. **Host header** must be exactly `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`. This
   defeats DNS rebinding.
2. **Origin** must equal a paired or configured origin. Reject when it is absent: a cross-origin
   `fetch` always sends it, and requests without it are not from GNOME's page.
3. **`Authorization: Bearer <token>`**: hash it and compare in constant time.
4. Method and path allowlist, JSON body limit of 4 KiB, `Content-Type: application/json`.
5. Per-origin rate limit.
6. Responses carry `Cache-Control: no-store`, `Vary: Origin` and `X-Content-Type-Options: nosniff`.
   No cookies, and never `Access-Control-Allow-Credentials`.

**CORS preflight** (`OPTIONS`), for paired or configured origins only. Respond 204 with:
- `Access-Control-Allow-Origin: <origin>`
- `Access-Control-Allow-Methods: GET, POST, PUT, DELETE`
- `Access-Control-Allow-Headers: Authorization, Content-Type`
- `Access-Control-Max-Age: 600`
- `Access-Control-Allow-Private-Network: true`, but only if the request carried
  `Access-Control-Request-Private-Network: true` (legacy PNA, now on hold; harmless).

Unknown origins get 403 and no CORS headers. Never send `*`.

**Browser requirements** for Chrome Local Network Access (https://developer.chrome.com/blog/local-network-access;
chromestatus feature 5152728072060928, updated 2026-07-15):
- Chrome 142 shows a permission prompt for requests from public sites to local or loopback
  addresses. Requests from a local, intranet site to loopback are gated too.
- Chrome 145 splits the permission into `local-network` and **`loopback-network`** (localhost,
  127.0.0.1).
- Chrome 147 extends the restriction to WebSocket and WebTransport.
- Firefox status per chromestatus is "Shipped/Shipping" (enabled on Nightly as of 2025-10-29 per
  mozilla/standards-positions#1260; exact release UNVERIFIED). Safari has given no signal. Brave has
  its own "localhost access" permission.
- Consequences for GNOME:
  1. GNOME must be served over **HTTPS**. An http:// LAN origin cannot get the permission.
  2. Probe the companion only after the user clicks "Connect to the VPN app on this device", so the
     prompt is expected.
  3. Call it from the **top-level document**. LNA features are policy-controlled with default
     allowlist `'self'`. Chrome's LNA announcement (Chrome 138 notes) says requests from service or
     shared workers need the worker's origin to already hold the permission. Scope the Scramjet/UV
     service workers to their prefixes so they don't control the GNOME shell page.
  4. Add `http://127.0.0.1:47821` to the UI's CSP `connect-src`.
  5. `http://127.0.0.1` counts as potentially trustworthy, so it is not blocked as mixed content in
     Chrome or Firefox. Safari behavior is UNVERIFIED.
  6. The LNA spec's `fetch(url, {targetAddressSpace: …})` hint (`enum IPAddressSpace { "public",
     "local", "loopback" }`) is optional here.

**Threats covered:**
- A malicious site: needs the LNA permission, the Origin allowlist and the token.
- DNS rebinding: stopped by the Host check.
- CSRF through forms or simple requests: stopped by the Origin check, and a form cannot set the
  `Authorization` header.
- Other local users: they need the token, though they could use the Mullvad socket directly anyway.
- XSS on GNOME's origin can steal the token. Blast radius: connect, disconnect and location only,
  with no account access. Keep the API surface minimal for that reason.

### 6.5 Suggested crates (crates.io, 2026-11-09)

`axum 0.8.9`, `tokio 1.54.1` (features `process`, `macros`, `rt-multi-thread`, `time`),
`tower-http 0.7.1` (limits and tracing only; write the Origin and CORS logic by hand rather than using a
permissive `CorsLayer`), `serde 1.0.229`, `serde_json 1.0.154`, `which 8.0.6`, `directories 6.0.0`,
`getrandom 0.4.3`, `subtle 2.6.1`, `base64 0.23.1`, `tokio-util 0.7.20`, `thiserror 2.0.21`,
`tracing 0.1.44`. Use `reqwest 0.13.5` only if the companion runs its own am.i.mullvad.net check.

Do **not** depend on `mullvad-management-interface`, `mullvad-types` or `talpid-types` (all
GPL-3.0-or-later). Write GNOME's own lenient serde structs from the documented JSON (§2.5).

---

## 7. Licensing boundary (GPL)

- Everything in mullvadvpn-app is GPL-3.0-or-later (`Cargo.toml` `[workspace.package] license`),
  and so is the browser extension. Do not copy code, tests, strings, CSS, icons or proto files.
- Facts about data formats (field names, JSON shapes, CLI output grammar) are what this report
  records. GNOME should implement against these facts in its own code.
- Running the official CLI as a separate process and parsing its output is arm's-length use. Do not
  link Mullvad crates or generate code from the protos.
- Do **not redistribute** Mullvad binaries. Link users to https://mullvad.net/download/ (or the
  GitHub releases) and verify the install instead.
- GPL-3.0 §7(e) lets licensors decline trademark rights (`LICENSE.md:376-377`). The code license
  grants no right to the "Mullvad" marks.

## 8. Trademark and branding constraints

### 8.1 Mullvad

- "Policy on brand rights" (https://mullvad.net/en/help/policy-brand-rights, last updated
  2020-02-03): "Mullvad VPN AB holds the rights to the 'Mullvad VPN' brand and logos. Our logos may
  not be used for commercial purposes without our permission no matter how cute that little mole
  is." Mullvad-branded merchandise: "No."
- Press page (https://mullvad.net/en/press): the logo files "are made available for editorial
  purposes in which our work is described". The page also publishes the brand palette (#294D73,
  #192E45, #44AD4D, #E34039, #FFD524, #D2943B, #FFCD86) and fonts (Open Sans, Source Sans Pro).
- In-repo: the translation READMEs list "Mullvad VPN" among "trademarks" not to translate
  (`desktop/packages/mullvad-vpn/locales/README.md:107-114`, `ios/translation/README.md:67-76`). The
  mole icon is described as "The main and official mole logo" (`graphics/README.md:12-16`).
- Contact for questions: press@mullvad.net or support@mullvadvpn.net.

**GNOME rules (recommendations, not legal advice):**
1. No Mullvad logo, mole, icon, wordmark, screenshots of the Mullvad app, brand colors used as
   theme, or Mullvad fonts as a "look-alike". Use GNOME's own icons, for example a generic
   shield or globe from GNOME's icon set.
2. Name the feature generically: "VPN egress", "Exit location", "Device VPN (Mullvad app)". Avoid
   "Mullvad mode" or "Mullvad for GNOME". Never put "Mullvad" in product, package, binary, domain or
   repository names (so `gnome-vpn-companion`, not `mullvad-companion`).
3. Plain-text nominative use only, to state compatibility: "Uses your existing Mullvad VPN
   account/app". Add the disclaimer near the feature and in the docs: "GNOME is an independent
   project and is not affiliated with, sponsored or endorsed by Mullvad VPN AB. 'Mullvad VPN' is a
   trademark of Mullvad VPN AB."
4. Do not copy Mullvad UI copy or flows. Write GNOME's own wording, and avoid mimicking the app's
   green "secure connection" screen.
5. Do not suggest that Mullvad verified, audited or supports GNOME. When showing results from
   am.i.mullvad.net, word them as "reported by Mullvad's public connection check (am.i.mullvad.net)".

### 8.2 WireGuard (also unavoidable in this feature)

- https://www.wireguard.com/trademark-policy/ is strict. Among other things you may not "Use The
  WireGuard Marks to indicate any kind of similarity, compatibility, or relatedness to the WireGuard
  project or protocols", and any use "should be accompanied by the acknowledgment '"WireGuard" and
  the "WireGuard" logo are registered trademarks of Jason A. Donenfeld.'"
- Permission "is easily available" via wireguard-trademark-usage [at] zx2c4.com.
- Recommendation: in the UI, say "VPN tunnel configuration (.conf)". Use the word WireGuard only in
  technical docs, with the acknowledgment. Never use the logo. Consider emailing for permission
  before release.
- Mullvad's own pages carry the line "'WireGuard' is a registered trademark of Jason A. Donenfeld."

### 8.3 Project name

Out of scope, but material: "GNOME" is a trademark of the GNOME Foundation (desktop environment).
Get a name or trademark check before any public release, since the same "no implied affiliation"
logic applies.

---

## 9. UNVERIFIED items and open questions

1. Live Connected-state `status -j` output (needs an account). The shape comes from source plus a
   serde replica (§2.5).
2. When master's GeoIpLocation reshape (549c371c53) reaches a desktop release.
3. `mullvad_server_type` strings, and `mullvad_exit_ip_hostname` semantics when traffic exits through
   a cross-relay SOCKS proxy.
4. Whether the connected relay's own `10.124.x.y` proxy is reachable from itself. Use `10.64.0.1` for
   the same relay.
5. Mullvad SOCKS5 UDP ASSOCIATE support, and wireproxy's real ASSOCIATE behavior.
6. Rate limits and acceptable-use expectations for `api.mullvad.net` (especially `www/` and
   `network/v1-beta1/`) and `am.i.mullvad.net`. Consider asking Mullvad.
7. Daemon-down error text on macOS and Windows, and the "connection refused" variant on Linux.
8. Firefox release that shipped Local Network Access, and Safari's behavior for an https page calling
   `http://127.0.0.1`.
9. Raspberry Pi 4 throughput with kernel versus userspace WG under gluetun, and whether the module
   autoloads from inside the container.
10. `network_port_speed` unit; meanings of `stboot` and `include_in_country`.
11. HolyWisp `dns-server` accepting `127.0.0.1:5353` (host:port) for the wireproxy variant.

## Appendix A: reproduction (safe)

Scripts and data lived under `/tmp/claude-1000/-home-duderucool-gnome/f2049012-6316-4b31-bd8a-a00530b243a1/scratchpad/{scripts/mullvad,raw}`.

```sh
# Verify and unpack the official binaries without running maintainer scripts
gpg --import mullvad-code-signing.asc   # https://mullvad.net/static/gpg/mullvad-code-signing.asc
gpg --verify MullvadVPN-2026.5_amd64.deb.asc MullvadVPN-2026.5_amd64.deb
docker run -d --name mullvad-probe --cap-add NET_ADMIN -v "$PWD":/rel:ro debian:trixie-slim sleep 1800
docker exec mullvad-probe sh -c 'apt-get update -qq && apt-get install -y -qq libdbus-1-3 ca-certificates &&
  dpkg-deb -x /rel/MullvadVPN-2026.5_amd64.deb / &&
  (MULLVAD_RESOURCE_DIR="/opt/Mullvad VPN/resources/" mullvad-daemon -v --disable-stdout-timestamps >/tmp/d.log 2>&1 &) ;
  sleep 3; mullvad status -j; mullvad relay list | head; mullvad status -j listen'
docker rm -f mullvad-probe

# API probes
curl -sS --compressed https://api.mullvad.net/network/v1-beta1/socks-proxies | jq '.[0]'
curl -sS -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: "<etag>"' https://api.mullvad.net/www/relays/all/   # 304
curl -sS https://ipv4.am.i.mullvad.net/json
dig +short @1.1.1.1 al-tia-wg-socks5-001.relays.mullvad.net        # 10.124.1.240 (private; local resolvers may drop it)
```
