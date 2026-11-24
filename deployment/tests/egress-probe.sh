#!/usr/bin/env bash
# Run by the operator (docs/DEPLOYMENT.md security checklist): from HolyWisp's network namespace, try this host's
# public address on 80, 443 and 8080 and report what answers. Anything that answers is reachable by proxied pages.
#
#   deployment/tests/egress-probe.sh <public IPv4 or IPv6 of this host> [compose project, default gnome]
set -euo pipefail
ip=${1:?usage: egress-probe.sh <public IP of this host> [project]}
project=${2:-gnome}
cid=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=holywisp" | head -1)
[[ -n $cid ]] || { echo "egress-probe: no running holywisp container in project $project" >&2; exit 2; }
for port in 80 443 8080; do
  if docker run --rm --network "container:$cid" --cap-drop ALL --security-opt no-new-privileges \
    alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f \
    nc -z -w 3 "$ip" "$port" > /dev/null 2>&1; then
    echo "OPEN    $ip:$port answers from HolyWisp's network: bind that service to loopback or add a DOCKER-USER rule"
  else
    echo "closed  $ip:$port"
  fi
done
