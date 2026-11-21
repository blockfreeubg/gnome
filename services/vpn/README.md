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

- **Your own account, your own household.** Mullvad's terms forbid using the service "to provide a service similar to
  that provided by Mullvad or other services where VPN constitutes a significant part of the service". Run VPN
  locations only on a GNOME instance used by you and your household. Do not offer them on a public or shared
  instance. The same applies to any other VPN provider whose terms say so.
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
- **Exit.** Open `https://am.i.mullvad.net/json` (Mullvad's public connection check; `verify_url` in
  `GET /api/vpn/locations`) inside GNOME with the location selected, so it goes through that location's path. It
  reports the exit IP, city and whether it is a Mullvad exit. Do it once per location after setup and after changing
  an overlay.
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
