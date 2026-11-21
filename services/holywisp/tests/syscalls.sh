#!/usr/bin/env bash
# syscalls.sh: check that the sandbox in holywisp.service / holywisp@.service fits what GNOME's
# HolyWisp build actually does, without booting systemd. A short workload (startup, /health, /stats,
# plain HTTP, Wisp v1 and v2 relays and a bulk transfer over loopback, refused destinations, a UDP
# refusal, lookups through the system resolver and through the built-in DNS client, SIGTERM) runs
# under strace in an unprivileged container with no network. The trace is then compared with the
# units' settings:
#   SystemCallFilter=@system-service minus the denied groups (expanded with this host's
#   `systemd-analyze syscall-filter`), RestrictAddressFamilies=AF_INET AF_INET6,
#   MemoryDenyWriteExecute=yes, LockPersonality=yes, and the files opened (ProtectSystem=strict,
#   PrivateDevices, ProtectHome, ProcSubset=pid).
# The trace run adds --allow-loopback on so the relay path can be exercised against a local echo
# service; that changes a policy decision, not which system calls the relay makes.
#
#   tests/syscalls.sh            (run services/holywisp/fetch-build.sh first; exit 0 = compatible)
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
PROG=syscalls.sh
die() {
  printf '%s: error: %s\n' "$PROG" "$*" >&2
  exit 1
}
BIN=$HERE/build/$(uname -m)
[[ -x $BIN/holywisp && -x $BIN/holywisp-client ]] || die "no binaries in $BIN; run fetch-build.sh first"
command -v docker >/dev/null || die "docker is required"
command -v python3 >/dev/null || die "python3 is required (to analyse the trace)"
command -v systemd-analyze >/dev/null || die "systemd-analyze is required (to expand SystemCallFilter groups)"
ALPINE_IMAGE=$(sed -n 's/^ARG ALPINE_IMAGE=//p' "$HERE/Dockerfile" | head -n 1)
[[ -n $ALPINE_IMAGE ]] || die "ARG ALPINE_IMAGE not found in Dockerfile"
TRACE_IMAGE=gnome-holywisp-trace:${ALPINE_IMAGE##*sha256:}
TRACE_IMAGE=${TRACE_IMAGE:0:40}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/gnome-hw-syscalls.XXXXXX")
NAME=gnome-hw-syscalls-$$
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [[ -n ${TMP-} && -d $TMP ]] && rm -rf -- "$TMP"
}
trap cleanup EXIT
mkdir "$TMP/out"
chmod 0777 "$TMP/out"

if ! docker image inspect "$TRACE_IMAGE" >/dev/null 2>&1; then
  printf 'building %s (strace, socat) ...\n' "$TRACE_IMAGE"
  printf 'FROM %s\nRUN apk add --no-cache strace socat\n' "$ALPINE_IMAGE" |
    docker build -q -t "$TRACE_IMAGE" - >/dev/null || die "cannot build the trace image"
fi

# The workload, run by busybox sh inside the container as UID 65534.
read -r -d '' DRIVER <<'EOS' || true
set -u
HW=/opt/holywisp
socat TCP-LISTEN:7000,bind=127.0.0.1,fork,reuseaddr EXEC:cat &
strace -f -qq -s 80 -o /out/trace-main.txt $HW/holywisp --config /etc/holywisp/holywisp.conf \
  --port 6001 --allow-loopback on 2>/out/main.log &
SP=$!
for _ in $(seq 1 100); do wget -q -T 2 -O - http://127.0.0.1:6001/health 2>/dev/null | grep -q ok && break; sleep 0.1; done
wget -q -T 2 -O /dev/null http://127.0.0.1:6001/stats || echo "stats failed"
wget -q -T 2 -O /dev/null http://127.0.0.1:6001/ 2>/dev/null; echo "plain GET / (expect 426): $?"
printf 'echo-v1\n' | $HW/holywisp-client --idle-ms 700 -s ws://127.0.0.1:6001/wisp/ 127.0.0.1 7000
printf 'echo-v2\n' | $HW/holywisp-client --idle-ms 700 --v2 --confirm -s ws://127.0.0.1:6001/wisp/ localhost 7000
$HW/holywisp-client --bench 4194304 -s ws://127.0.0.1:6001/ 127.0.0.1 7000
$HW/holywisp-client --idle-ms 300 -s ws://127.0.0.1:6001/ 127.0.0.1 25 </dev/null; echo "port 25: $?"
$HW/holywisp-client --idle-ms 300 -s ws://127.0.0.1:6001/ 169.254.169.254 80 </dev/null; echo "metadata: $?"
$HW/holywisp-client --idle-ms 300 -s ws://127.0.0.1:6001/ no-such-host.invalid 80 </dev/null; echo "unresolvable: $?"
$HW/holywisp-client --idle-ms 300 -u -s ws://127.0.0.1:6001/ 127.0.0.1 53 </dev/null; echo "udp: $?"
# strace -o FILE blocks fatal signals (-I 3), so signal the traced server, its child.
kill -TERM "$(pgrep -P $SP)"; wait $SP; echo "main server exit: $?"
strace -f -qq -s 80 -o /out/trace-dns.txt $HW/holywisp --config /etc/holywisp/holywisp.conf \
  --port 6002 --dns-server 127.0.0.1:5353 --workers 2 2>/out/dns.log &
SP=$!
for _ in $(seq 1 100); do wget -q -T 2 -O - http://127.0.0.1:6002/health 2>/dev/null | grep -q ok && break; sleep 0.1; done
$HW/holywisp-client --idle-ms 300 -s ws://127.0.0.1:6002/ example.invalid 80 </dev/null; echo "built-in dns: $?"
kill -TERM "$(pgrep -P $SP)"; wait $SP; echo "dns server exit: $?"
EOS

printf 'tracing holywisp (%s) in an unprivileged container without network ...\n' "$(sed -n 's/^version: *//p' "$BIN/BUILDINFO")"
timeout 300 docker run --rm --name "$NAME" --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --user 65534:65534 -v "$BIN:/opt/holywisp:ro" -v "$HERE/gnome.conf:/etc/holywisp/holywisp.conf:ro" \
  -v "$TMP/out:/out" "$TRACE_IMAGE" sh -c "$DRIVER" >"$TMP/driver.log" 2>&1 || true
sed 's/^/  workload: /' "$TMP/driver.log"
[[ -s $TMP/out/trace-main.txt && -s $TMP/out/trace-dns.txt ]] || die "no trace produced (see the workload output above)"

systemd-analyze syscall-filter --no-pager >"$TMP/groups.txt" 2>/dev/null
python3 -I - "$TMP/groups.txt" "$HERE/holywisp.service" "$HERE/holywisp@.service" \
  "$TMP/out/trace-main.txt" "$TMP/out/trace-dns.txt" <<'PY'
import re
import sys

groups_file, main_unit, tmpl_unit, *traces = sys.argv[1:]

# systemd-analyze syscall-filter: "@group" at column 0, members indented, "#" comments.
groups, cur = {}, None
for line in open(groups_file):
    if line.startswith("@"):
        cur = groups.setdefault(line.strip(), set())
    elif line.startswith((" ", "\t")) and cur is not None:
        item = line.strip()
        if item and not item.startswith("#"):
            cur.add(item)
    elif line.strip().startswith("#"):
        cur = None

def expand(name, seen=None):
    seen = seen or set()
    if not name.startswith("@"):
        return {name}
    if name in seen:
        return set()
    seen.add(name)
    out = set()
    for m in groups.get(name, ()):
        out |= expand(m, seen)
    return out

def unit_settings(path):
    allow, deny, families = set(), set(), None
    for line in open(path):
        line = line.strip()
        if line.startswith("SystemCallFilter="):
            spec = line.split("=", 1)[1]
            if spec.startswith("~"):
                for g in spec[1:].split():
                    deny |= expand(g)
            else:
                for g in spec.split():
                    allow |= expand(g)
        elif line.startswith("RestrictAddressFamilies="):
            families = set(line.split("=", 1)[1].split())
    return allow - deny, families

seen_calls, families, opens, wx, personality = {}, set(), set(), [], []
call_re = re.compile(r"^\d+\s+(?:<\.\.\. )?([a-z0-9_]+)(?:\(| resumed>)")
for t in traces:
    for line in open(t, errors="replace"):
        m = call_re.match(line)
        if not m:
            continue
        name = m.group(1)
        seen_calls[name] = seen_calls.get(name, 0) + 1
        if name == "socket":
            f = re.search(r"socket\((AF_[A-Z0-9_]+)", line)
            if f:
                families.add(f.group(1))
        elif name in ("open", "openat", "openat2"):
            p = re.search(r'"([^"]*)"', line)
            flags = re.search(r'"[^"]*", ([A-Z_|]+)', line)
            if p:
                opens.add((p.group(1), flags.group(1) if flags else ""))
        elif name in ("mmap", "mprotect", "pkey_mprotect"):
            if "PROT_EXEC" in line and (name != "mmap" or "PROT_WRITE" in line):
                wx.append(line.strip())
        elif name == "personality":
            personality.append(line.strip())

ok = True
print(f"\n  {len(seen_calls)} distinct system calls in {sum(seen_calls.values())} traced calls:")
print("   ", " ".join(sorted(seen_calls)))
for unit in (main_unit, tmpl_unit):
    allowed, fams = unit_settings(unit)
    bad = sorted(c for c in seen_calls if c not in allowed)
    label = unit.rsplit("/", 1)[-1]
    if bad:
        ok = False
        print(f"  FAIL  {label}: SystemCallFilter would refuse (EPERM): {' '.join(bad)}")
    else:
        print(f"  PASS  {label}: every traced system call is inside SystemCallFilter ({len(allowed)} allowed)")
    extra = sorted(families - (fams or set()))
    if extra:
        ok = False
        print(f"  FAIL  {label}: socket families outside RestrictAddressFamilies: {' '.join(extra)}")
    else:
        print(f"  PASS  {label}: socket families {' '.join(sorted(families))} within RestrictAddressFamilies")
if wx:
    ok = False
    print("  FAIL  MemoryDenyWriteExecute: writable+executable or exec-adding mappings:", *wx[:5], sep="\n    ")
else:
    print("  PASS  MemoryDenyWriteExecute: no W+X mmap and no mprotect adding PROT_EXEC")
if personality:
    ok = False
    print("  FAIL  LockPersonality: personality() called:", personality[:3])
else:
    print("  PASS  LockPersonality: personality() never called")
writes = sorted(p for p, f in opens if any(x in f for x in ("O_WRONLY", "O_RDWR", "O_CREAT")))
dev = sorted(p for p, _ in opens if p.startswith("/dev/") and p not in ("/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"))
proc = sorted(p for p, _ in opens if p.startswith("/proc/") and not re.match(r"^/proc/(self|thread-self|\d+)(/|$)", p))
home = sorted(p for p, _ in opens if p.startswith(("/home/", "/root/", "/run/user/")))
for label, items in (("files opened for writing (ProtectSystem=strict)", writes),
                     ("device nodes beyond null/zero/random (PrivateDevices)", dev),
                     ("non-process /proc entries (ProcSubset=pid)", proc),
                     ("home directories (ProtectHome)", home)):
    if items:
        ok = False
        print(f"  FAIL  {label}: {' '.join(items)}")
    else:
        print(f"  PASS  no {label}")
print("  INFO  files opened:", " ".join(sorted(p for p, _ in opens)) or "(none)")
sys.exit(0 if ok else 1)
PY
