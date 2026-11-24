# VPN gateway profiles (operator guide)

GNOME is a website, so its VPN feature is a **server-side egress gateway** (docs/ARCHITECTURE.md §7): pages a user
opens inside GNOME can leave the server through a VPN tunnel that **you, the operator,** set up on the server. Each
offered exit location is one HolyWisp instance whose outbound traffic goes through that tunnel. gnome-server lists the
locations, routes `wss://<proxy origin>/wisp/p/<id>/` to the right instance and shows each one's health.

Only traffic loaded inside GNOME uses an exit. The user's device, its other apps and tabs, and GNOME's own interface
are unchanged. Nothing here installs anything on a user's device or asks users for VPN credentials.

| File | What |
| --- | --- |
| `profiles.example.toml` | `GNOME_VPN_PROFILES` format, commented (validated by gnome-server's unit tests) |
| `compose.example.yml` | recipe A: gluetun + HolyWisp instances in its network namespace + the gateway |
| `../holywisp/vpn-egress.conf.example`, `../holywisp/holywisp@.service`, `../holywisp/check-egress.sh` | the HolyWisp side: per-location overlay, systemd template, overlay checker |

Background and sources: `docs/research/mullvad-vpn.md` §4-5 (tunnel options, SOCKS5 exits, DNS, status signals) and
`services/holywisp/README.md` "VPN egress instances".

## Before you start: terms, devices, branding

- **Only egress you may share with everyone who can use your instance.** Run the locations over connections you are
  authorized to share with the people who use the server. Consumer VPN subscriptions, Mullvad's among them, do not
  allow offering the VPN to others: Mullvad's terms forbid using the service "to provide a service similar to that
  provided by Mullvad or other services where VPN constitutes a significant part of the service". GNOME's access modes
  (open, access code, accounts) do not change what a provider's terms allow. No document of GNOME presents any provider
  as usable for a multi-user service.
- **GNOME warns you.** `gnome-server config check` and the startup log warn when VPN locations are configured and
  everyone who can open the server or register on it can use them (`GNOME_ACCESS_MODE=open`, or
  `GNOME_ACCESS_MODE=accounts` with `GNOME_REGISTRATION=open`), and remind code-mode operators to keep the access code
  within the people their egress's terms allow. Set `GNOME_VPN_EGRESS_SHARED_OK=true` only when your egress's terms
  allow every person who can use the instance; it silences both warnings.
- **Devices.** A Mullvad account allows 5 devices. Generate a **dedicated WireGuard key for this server** (it uses one
  device slot); never reuse the key of the official app or of another machine. One tunnel serves every location in
  both recipes below.
- **Secrets stay on the server.** Store only the WireGuard private key and its address (gluetun secret, or the
  wg-quick file, mode 0600). Never put the account number in GNOME's configuration; GNOME never asks users for it.
- **No branding.** GNOME mentions Mullvad in plain text only, to say what it works with. Do not add Mullvad logos,
  icons, colours or fonts to your instance. GNOME is an independent project and is not affiliated with, sponsored or
  endorsed by Mullvad VPN AB. "Mullvad VPN" is a trademark of Mullvad VPN AB.

## How it fits

```
 browser ──wss://<proxy origin>/wisp/p/se-got/?t=…──▶ gnome-server gateway (Origin, ticket, caps)
                                                         │  X-Forwarded-For: <client ip>, nothing else from the client
                                                         ▼
                                    HolyWisp "se-got" (policy: no private/loopback/link-local, bad ports, no UDP)
                                         │ proxy = socks5://10.124.a.b:1080, dns-server = 10.64.0.1
                                         ▼  (only reachable through the tunnel)
                                    WireGuard tunnel ──▶ VPN relay ──▶ exit in Gothenburg ──▶ website
```

Two ways to get an exit per location from one tunnel:

- **SOCKS5 exits (recommended with Mullvad).** Every Mullvad WireGuard server runs a SOCKS5 proxy on `10.124.x.y:1080`
  that is reachable only from inside a Mullvad tunnel, and each has one fixed exit IP. HolyWisp's `proxy` setting
  points one instance at one of them, so one tunnel offers many cities. Mullvad's SOCKS5 proxies take no
  credentials.
- **The tunnel's own exit.** An instance without a `proxy` (or with `socks5://10.64.0.1:1080`) exits at the relay the
  tunnel connects to.

HolyWisp's `proxy` is one setting per process, so every location is its own instance on its own port.

### Picking SOCKS5 exits

Mullvad publishes the list at `https://api.mullvad.net/network/v1-beta1/socks-proxies` (fields include
`ipv4_address`, `location` and `online`; undocumented, so re-check it when you update). Use the **IP literal**
(`ipv4_address`), never the `*-wg-socks5-*.relays.mullvad.net` name: those names resolve to private addresses, many
resolvers drop such answers (DNS-rebinding protection), and HolyWisp resolves a proxy hostname only once at startup
through the host's resolver. Pick an `online` entry in the city you want and keep it while it works (one proxy = one
stable exit IP).

## Recipe A: gluetun (Docker)

gluetun runs the WireGuard tunnel with a kill switch (firewall default-deny, output only through the tunnel), its own
health check and DNS. The HolyWisp instances share gluetun's network namespace (`network_mode: "service:gluetun"`), so
they have no route around the tunnel. The gateway reaches them as `gluetun:<port>` on a private Docker network; nothing
is published.

1. **Key.** In your Mullvad account, generate a WireGuard configuration for a new device (this server). From the file
   keep `PrivateKey` (→ `secrets/wireguard_private_key`, mode 0600) and the IPv4 part of `Address`
   (→ `WIREGUARD_ADDRESSES` in `.env`).
2. **Compose file.** Copy `compose.example.yml` next to your gnome-server compose file and merge its `gnome` keys into
   your gnome-server service. Set `GLUETUN_SERVER_CITIES` (gluetun's city names, e.g. `Gothenburg`), `GLUETUN_API_KEY`
   (`docker run --rm qmcgaw/gluetun:v3.41.3 genkey`) and `GNOME_SERVER_IMAGE` in `.env`. Pin gluetun by digest.
   The example uses the local `gnome-holywisp:0.1.0-e0a0f15` image (`services/holywisp/fetch-build.sh --image`).
3. **One overlay per location**, e.g. `egress/se-got.conf` (0644). The image already loads the hardened `gnome.conf`;
   the overlay only adds what differs:

   ```ini
   # HolyWisp overlay for exit location se-got (inside gluetun's network namespace)
   host = 0.0.0.0                     # gluetun's firewall keeps the VPN side closed; nothing is published
   port = 6002                        # unique per location; never 6001 (the direct instance)
   workers = 2
   max-concurrent-connections = 2000
   proxy = socks5://10.124.1.17:1080  # this city's SOCKS5 exit: an IP literal from the socks-proxies list
   proxy-udp = refuse
   dns-server = 10.64.0.1             # Mullvad's resolver, reached through the tunnel (no DNS leak)
   dns-timeout-ms = 3000
   trusted-proxy = 172.30.64.10/32    # the gateway's fixed address on gnome-egress (compose.example.yml)
   ```

   Check every overlay before starting: `sh services/holywisp/check-egress.sh egress/*.conf` (it refuses
   placeholders, a missing or hostname `proxy`, a missing or malformed `dns-server`, port 6001 and any loosened
   egress policy).
4. **Profiles.** Copy `profiles.example.toml` to `profiles.toml`, one `[[profile]]` per overlay with
   `wisp_upstream = "gluetun:<port>"`.
5. `docker compose config` (static check), then `docker compose up -d`, then verify (below).

Keep every Docker network and your LAN **outside `10.64.0.0/10`**: Mullvad's tunnel addresses, its DNS (10.64.0.1)
and the SOCKS5 proxies live there. Never publish gluetun's control port (8000) or the HolyWisp ports, never set
`FIREWALL_VPN_INPUT_PORTS` for them, and attach nothing but gluetun and the gateway to `gnome-egress`. If gluetun's
tunnel goes down its firewall blocks all output, so the locations fail closed (the health probe still reaches
HolyWisp; the VPN page's exit check is what notices).

## Recipe B: host WireGuard + SOCKS5 exits (systemd, no Docker)

A WireGuard interface on the host that routes **only** Mullvad's internal range, and one `holywisp@<id>.service`
instance per location on a loopback port. The host's own traffic does not use the tunnel.

1. **Tunnel.** `/etc/wireguard/wg-mullvad.conf` from the generated configuration, with two changes: remove the `DNS =`
   line (wg-quick would take over the host's resolver) and set `AllowedIPs = 10.64.0.0/10` in `[Peer]` (only
   Mullvad's resolver and SOCKS5 proxies go through the tunnel). `chmod 600` it, then
   `systemctl enable --now wg-quick@wg-mullvad`.
2. **Instances.** For each location, install the overlay (`services/holywisp/vpn-egress.conf.example`, filled in:
   `host = 127.0.0.1`, `port = 6004`, `proxy = socks5://<socks ip>:1080`, `dns-server = 10.64.0.1`,
   `trusted-proxy = 127.0.0.1/32`) as `/etc/holywisp/egress/<id>.conf`, and follow `services/holywisp/README.md`
   "VPN egress instances": `check-egress`, then a drop-in (`systemctl edit holywisp@<id>.service`) that lets the
   otherwise fail-closed unit reach the tunnel side and ties it to the tunnel:

   ```ini
   [Unit]
   BindsTo=wg-quick@wg-mullvad.service
   After=wg-quick@wg-mullvad.service
   [Service]
   IPAddressAllow=10.124.0.0/16 10.64.0.1
   ```

   then `systemctl enable --now holywisp@<id>.service`. Without the drop-in the unit cannot send anything past
   loopback, so a mistake never leaks traffic out of the default route.
3. **Profiles** with `wisp_upstream = "127.0.0.1:<port>"`.

A kernel WireGuard interface in a network namespace (docs/research/mullvad-vpn.md §5.8) or wireproxy (a userspace
WireGuard client that exposes SOCKS5; for hosts without `NET_ADMIN`) work too; the research report has their
configurations and their DNS caveats.

## Configure GNOME

```sh
GNOME_VPN_PROFILES=/etc/gnome/vpn-profiles.toml gnome-server config check   # lists the profiles, or every problem
```

then restart gnome-server. Each profile appears in `GET /api/config` (`wisp.profiles`) and
`GET /api/vpn/locations`; the gateway accepts `/wisp/p/<id>/` for it on the proxy origin. Upstream addresses must be
internal (loopback, private, CGNAT, link-local, never a cloud-metadata address; DNS names are filtered to such answers
at connect time); `localhost` is refused because it may resolve to `::1` while HolyWisp listens on `127.0.0.1`.

## Verify

- **Health** (every 60 s: TCP connect, WebSocket handshake, first Wisp frame): `GET /admin/diagnostics` →
  `upstreams[]` (`status`, `latency_ms`, `checked_at`, `error`), `/admin/metrics` → `gnome_wisp_upstream_up{id=…}`,
  `GET /api/health` on the app origin → `wisp.<id>` (the proxy origin's minimal answer names only `direct`). A result older than 3 minutes counts as down. This proves the instance answers,
  not that its exit works.
- **Exit (server-side check).** With `GNOME_VPN_CHECK_URL` set, gnome-server checks each location's exit itself
  through that location's own HolyWisp instance (`/wisp/p/<id>/`): a Wisp stream to the check service, TLS for
  `https:`, one `GET` with the neutral `User-Agent: exit-check/1` (it names no product and no instance; nothing about
  users is sent — the service sees the location's exit address). It runs every `GNOME_VPN_CHECK_INTERVAL_MIN` minutes
  (default 15, ± 20 %, the first checks spread randomly over the whole first interval; `0` = only on request) and on
  demand (`POST /api/vpn/locations/<id>/check`, at most once a minute per location). The result is `exit` in
  `GET /api/vpn/locations` (shown only to clients the access policy lets use the proxy), `/admin/diagnostics` → `vpn`
  and `/admin/metrics` → `gnome_vpn_exit_checks_total{id,result}`, `gnome_vpn_exit_ok{id}`,
  `gnome_vpn_exit_checked_seconds{id}`. Errors: `upstream_unreachable` (the instance does not answer, or the health
  job has it down), `connect_failed` (the instance answers but its streams do not connect: a tunnel that fails
  closed), `tls_failed`, `http_status`, `bad_answer`, `timeout` (15 s).
  - **What it proves:** the location's streams reach the internet and the check service names an exit address
    (country and city when it reports them, and whether it matches the profile's country).
  - **What it does not prove:** that a given user's pages use that location. That is the app's route choice and the
    route-bound Wisp tickets. Exit checks never change routing or the connection state; a failed check is a warning
    on the VPN page.
  - **Nothing is checked until you set a check service.** `GNOME_VPN_CHECK_URL` is empty by default: no server-side
    checks, no browser-side checks (`verify_url: null`). `config check` warns when locations are configured without
    one.
- **Exit (the browser's check).** The same URL is `verify_url` in `GET /api/vpn/locations`; the VPN page's
  "Check exit" loads it inside GNOME through the selected location. A page that reaches the engine host can forge
  that answer, so the page shows it as what the check service reported, never as proof.
- **IPv6.** Each location's network namespace must tunnel or block IPv6. To see an IPv6 leak beside an IPv4-only
  tunnel (or the reverse), set `GNOME_VPN_CHECK_URL_V6` to the same service under an IPv6-only name (a separate name
  with only AAAA records, e.g. `ipv6.check.example.net`); every check then runs twice and fills `exit.v6`.

### A check endpoint you run yourself

Any HTTPS endpoint **outside the tunnels** that answers `{"ip": "<the client's address>"}` works (`country` and
`city` are optional; `country_code` or `country_iso` as two letters makes the country comparison exact). Caddy:

```caddyfile
check.example.net, ipv6.check.example.net {
	header Content-Type application/json
	header Cache-Control no-store
	respond `{"ip":"{remote_host}"}` 200
}
```

nginx (with your certificate):

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name check.example.net ipv6.check.example.net;
    ssl_certificate     /etc/ssl/check.example.net/fullchain.pem;
    ssl_certificate_key /etc/ssl/check.example.net/privkey.pem;
    location = /json {
        default_type application/json;
        add_header Cache-Control no-store always;
        return 200 '{"ip":"$remote_addr"}';
    }
}
```

Give `check.example.net` A (and AAAA) records and `ipv6.check.example.net` only an AAAA record, then set
`GNOME_VPN_CHECK_URL=https://check.example.net/json` (Caddy answers on every path) and
`GNOME_VPN_CHECK_URL_V6=https://ipv6.check.example.net/json`. Neither example was run in this repository (no Caddy or
nginx on the build machine; see "Tested here").

A third party's check service (for example a VPN provider's connection check, such as `https://am.i.mullvad.net/json`,
which also reports `mullvad_exit_ip`) may be used only where its operator allows automated checks. It sees each
location's exit address at every interval.

- **Fail closed.** Stop the tunnel (`docker compose stop gluetun`, or `systemctl stop wg-quick@wg-mullvad`, which
  also stops the bound instances); the location's pages must stop loading instead of loading directly. The gateway
  never sends a `/wisp/p/<id>/` connection anywhere but that profile's upstream.

## DNS and what others can see

- HolyWisp resolves each destination itself (for its egress policy) with `dns-server`, through the tunnel, and then
  hands the SOCKS5 proxy the hostname, which the exit relay resolves again. Neither lookup uses the server's ISP.
- UDP is refused on these instances (`proxy-udp = refuse`; the browser transports only use TCP).
- TLS between the user's browser and websites is end to end, but the operator, the tunnel's relay and the exit relay
  see destination hostnames (SNI) and any plain-HTTP content. Tell your household.

## Tested here

`compose.example.yml` passes `docker compose config`; the overlays above pass `check-egress.sh` and load in HolyWisp
together with `gnome.conf` (and, without a tunnel, its streams do not connect: fail closed). gnome-server's profile
parsing, routing to profile upstreams, health probes and `/api/vpn/locations` are covered by `backend/tests/gateway.rs`.
`services/holywisp/tests/smoke.sh` runs the egress overlay through a local SOCKS5 stand-in. The full chain with a real
Mullvad tunnel and gluetun was **not** run in this repository (it needs an operator account); follow "Verify" after
setting it up.

The server-side exit check (Wisp client, TLS, every error class, the access gate, on-demand reuse, the IPv6 name) is
covered by `backend/tests/vpn_exit.rs` against an in-process Wisp server and local HTTP/TLS check endpoints (a
test-only CA). The Caddy and nginx examples above were **not** run here (neither is installed on the build machine
and nothing is installed system-wide by the build); the integration step runs them before pointing the ignored online
test (`VPN_CHECK_ONLINE_URL`, `HOLYWISP_BIN`) at one of them.
