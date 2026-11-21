#!/usr/bin/env python3
"""Minimal SOCKS5 (RFC 1928) CONNECT proxy for services/holywisp/tests/smoke.sh.

Stands in for a VPN location's SOCKS5 relay so the egress-overlay test can prove that HolyWisp sends
streams through its upstream proxy, and which destinations it hands over. Every request is logged as
one JSON line: {"atyp": 3, "host": "example.org", "port": 80, "allowed": true}.

It listens on a loopback address only (127.0.0.1 unless --bind names another), offers no-authentication only, supports CONNECT only and connects
only to the hosts given with --allow-host (anything else gets reply 0x02, "not allowed by ruleset"),
so it is never an open proxy. Stdlib only; run with `python3 -I`.
"""

import argparse
import ipaddress
import json
import socket
import struct
import threading
import time


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("client closed during the SOCKS handshake")
        buf += chunk
    return buf


def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class Stub:
    def __init__(self, bind, port, log_path, allow_hosts):
        self.bind = bind
        self.port = port
        self.log_path = log_path
        self.allow_hosts = {h.lower() for h in allow_hosts}
        self.lock = threading.Lock()

    def log(self, entry):
        with self.lock, open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")

    def reply(self, conn, code):
        # VER, REP, RSV, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0
        conn.sendall(struct.pack("!BBBB4sH", 5, code, 0, 1, b"\0\0\0\0", 0))

    def handle(self, conn):
        upstream = None
        try:
            conn.settimeout(10)
            ver, nmethods = recv_exact(conn, 2)
            methods = recv_exact(conn, nmethods)
            if ver != 5 or 0 not in methods:
                conn.sendall(b"\x05\xff")
                return
            conn.sendall(b"\x05\x00")
            ver, cmd, _rsv, atyp = recv_exact(conn, 4)
            if atyp == 1:
                host = str(ipaddress.IPv4Address(recv_exact(conn, 4)))
            elif atyp == 3:
                host = recv_exact(conn, recv_exact(conn, 1)[0]).decode("idna")
            elif atyp == 4:
                host = str(ipaddress.IPv6Address(recv_exact(conn, 16)))
            else:
                self.reply(conn, 8)  # address type not supported
                return
            (port,) = struct.unpack("!H", recv_exact(conn, 2))
            allowed = ver == 5 and cmd == 1 and host.lower() in self.allow_hosts
            self.log({"atyp": atyp, "cmd": cmd, "host": host, "port": port, "allowed": allowed})
            if cmd != 1:
                self.reply(conn, 7)  # command not supported
                return
            if not allowed:
                self.reply(conn, 2)  # connection not allowed by ruleset
                return
            try:
                upstream = socket.create_connection((host, port), timeout=10)
            except OSError:
                self.reply(conn, 5)  # connection refused / unreachable
                return
            self.reply(conn, 0)
            conn.settimeout(None)
            upstream.settimeout(None)
            t = threading.Thread(target=pump, args=(upstream, conn), daemon=True)
            t.start()
            pump(conn, upstream)
            t.join(timeout=30)
        except (OSError, ValueError, ConnectionError):
            pass
        finally:
            for s in (conn, upstream):
                if s is not None:
                    try:
                        s.close()
                    except OSError:
                        pass

    def serve(self, max_seconds):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((self.bind, self.port))
        srv.listen(64)
        srv.settimeout(0.5)
        deadline = time.monotonic() + max_seconds
        while time.monotonic() < deadline:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()
        srv.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--bind", default="127.0.0.1", help="loopback address to listen on")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--log", required=True, help="append one JSON line per request here")
    ap.add_argument("--allow-host", action="append", default=[], help="destination host to relay (repeatable)")
    ap.add_argument("--max-seconds", type=float, default=300, help="exit after this long")
    args = ap.parse_args()
    if not ipaddress.IPv4Address(args.bind).is_loopback:
        ap.error("--bind must be an IPv4 loopback address")
    Stub(args.bind, args.port, args.log, args.allow_host).serve(args.max_seconds)


if __name__ == "__main__":
    main()
