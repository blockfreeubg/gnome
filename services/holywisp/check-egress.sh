#!/bin/sh
# check-egress.sh: refuse HolyWisp VPN egress overlays (vpn-egress.conf.example) that would start but
# defeat the purpose of an egress instance.
#
#   check-egress.sh /etc/holywisp/egress/<id>.conf [more overlays...]
#
# HolyWisp 0.1.0 only logs and skips a malformed dns-server entry (a leftover placeholder, a bare IPv6
# address), and with no valid entry left it resolves every destination through the HOST's resolver,
# outside the tunnel: a silent DNS leak. This script refuses that, and also overlays that leave a
# placeholder, give the proxy as a hostname (resolved once at startup through the host resolver),
# have no proxy, reuse the direct instance's port 6001, switch part of the inherited egress policy
# off, or trust a client-IP header other than X-Forwarded-For.
# holywisp@.service runs it as ExecStartPre; run it by hand for container deployments.
# Exit status: 0 every file is fine, 1 problems (printed on stderr), 2 usage.
set -u
if [ $# -lt 1 ]; then
  echo "usage: check-egress.sh OVERLAY..." >&2
  exit 2
fi
status=0
for f in "$@"; do
  if [ ! -r "$f" ]; then
    echo "$f: cannot read" >&2
    status=1
    continue
  fi
  awk -v file="$f" '
    function err(msg) { printf "%s: %s\n", file, msg > "/dev/stderr"; bad = 1 }
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function ipv4(ip,   n, a, i) {
      n = split(ip, a, ".")
      if (n != 4) return 0
      for (i = 1; i <= 4; i++) if (a[i] !~ /^[0-9]+$/ || a[i] + 0 > 255) return 0
      return 1
    }
    function ipv6(ip) { return ip ~ /^[0-9A-Fa-f:.]+$/ && ip ~ /:.*:/ }
    function tcp_port(p) { return p ~ /^[0-9]+$/ && p + 0 >= 1 && p + 0 <= 65535 }
    function on(v) { v = tolower(v); return v == "1" || v == "true" || v == "yes" || v == "on" }
    # host[:port] or [v6][:port]; need_port demands an explicit port.
    function hostport(s, need_port,   rb, h, rest, c) {
      if (s ~ /^\[/) {
        rb = index(s, "]")
        if (!rb) return 0
        h = substr(s, 2, rb - 2); rest = substr(s, rb + 1)
        if (rest == "") return !need_port && ipv6(h)
        return ipv6(h) && rest ~ /^:/ && tcp_port(substr(rest, 2))
      }
      if (s ~ /:.*:/) return 0   # a bare IPv6 address: HolyWisp splits it at the last colon
      c = index(s, ":")
      if (!c) return !need_port && ipv4(s)
      return ipv4(substr(s, 1, c - 1)) && tcp_port(substr(s, c + 1))
    }
    /^[ \t]*#/ { next }
    {
      line = $0
      sub(/[ \t]+#.*$/, "", line)   # HolyWisp: "#" after whitespace starts a comment
      if (trim(line) == "") next
      eq = index(line, "=")
      if (!eq) { err("line " NR ": not a key = value line"); next }
      key = trim(substr(line, 1, eq - 1)); val = trim(substr(line, eq + 1))
      if (val ~ /<[^>]*>/) { err("line " NR ": placeholder left: " key " = " val); held[key] = 1; next }
      if (key == "port") port = val
      else if (key == "proxy") proxy = val
      else if (key == "dns-server") { ndns++; dns[ndns] = val; dnsln[ndns] = NR }
      else if (key == "trusted-proxy") { ntp++; tp[ntp] = val; tpln[ntp] = NR }
      else if (key == "trusted-header" && tolower(val) != "x-forwarded-for")
        err("line " NR ": trusted-header " val ": only X-Forwarded-For (written by the gateway) may be trusted")
      else if (key ~ /^(allow-private|allow-loopback|allow-link-local|allow-udp|enable-twisp|reputation)$/ && on(val))
        err("line " NR ": " key " = " val " switches off part of the inherited egress policy")
      else if (key == "proxy-udp" && tolower(val) == "direct")
        err("line " NR ": proxy-udp = direct sends UDP around the location proxy")
    }
    END {
      if (!held["port"]) {
        if (port == "") err("no port: the instance would bind gnome.conf'"'"'s 6001")
        else if (!tcp_port(port)) err("port " port " is not a TCP port number")
        else if (port + 0 == 6001) err("port 6001 belongs to the direct instance (holywisp.service)")
      }
      if (!held["proxy"]) {
        if (proxy == "") err("no proxy: this instance would send traffic out directly, not through the VPN")
        else if (proxy !~ /^(socks5|socks5h|http):\/\//) err("proxy " proxy ": the scheme must be socks5://, socks5h:// or http://")
        else {
          p = proxy; sub(/^[a-z0-9]+:\/\//, "", p)
          at = 0
          for (i = length(p); i > 0; i--) if (substr(p, i, 1) == "@") { at = i; break }   # user:pass@ splits on the last @
          if (!hostport(at ? substr(p, at + 1) : p, 1))
            err("proxy " proxy ": use an IP literal and a port, e.g. socks5://10.124.0.1:1080")
        }
      }
      if (!held["dns-server"]) {
        if (ndns == 0) err("no dns-server: destinations would be resolved through the host'"'"'s resolver, outside the tunnel")
        for (i = 1; i <= ndns; i++)
          if (!hostport(dns[i], 0))
            err("line " dnsln[i] ": dns-server " dns[i] " would be ignored by HolyWisp (use 10.64.0.1, 10.64.0.1:53 or [fd00::1]:53)")
      }
      for (i = 1; i <= ntp; i++) {
        n = split(tp[i], a, "/"); ip = a[1]; len = (n == 2) ? a[2] : ""
        max = ipv4(ip) ? 32 : (ipv6(ip) ? 128 : -1)
        if (n > 2 || max < 0 || (len != "" && (len !~ /^[0-9]+$/ || len + 0 > max)))
          err("line " tpln[i] ": trusted-proxy " tp[i] " is not an address or CIDR")
      }
      exit bad
    }
  ' "$f" || status=1
done
exit "$status"
