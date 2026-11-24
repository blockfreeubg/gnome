#!/usr/bin/env bash
# Creates the Docker stack's secrets in deployment/secrets/ (WAVE-D §5.2, D23): random values, never printed.
#
#   deployment/init-secrets.sh [--admin-token] [--secret-key] [--access-code] [--tls-cert FILE --tls-key FILE]
#                              [--allow-shared-group]
#
# Directory 0750, files 0640, group GNOME_SECRETS_GID (written into deployment/.env): Compose bind-mounts file secrets
# with their host owner and mode, and the containers (user 65532) read them through `group_add` of that group. The
# group is your primary group (0 under rootless Docker); a group with other members is refused unless
# --allow-shared-group, because its members could read the secrets. Existing files are kept (never overwritten).
set -euo pipefail
umask 077
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dir=$here/secrets
env_file=$here/.env

die() { echo "init-secrets: $*" >&2; exit 1; }

want_admin=0 want_key=0 want_code=0 shared=0 cert="" key=""
while (($#)); do
  case $1 in
  --admin-token) want_admin=1 ;;
  --secret-key) want_key=1 ;;
  --access-code) want_code=1 ;;
  --tls-cert) cert=${2:?--tls-cert needs a file}; shift ;;
  --tls-key) key=${2:?--tls-key needs a file}; shift ;;
  --allow-shared-group) shared=1 ;;
  -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
  *) die "unknown option $1" ;;
  esac
  shift
done
[[ -n $cert && -z $key || -z $cert && -n $key ]] && die "--tls-cert and --tls-key go together"
((want_admin + want_key + want_code)) || [[ -n $cert ]] || die "nothing to do (see --help)"

# The group the containers get through group_add.
if docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
  gid=0
else
  gid=$(id -g)
  members=$(getent group "$gid" | cut -d: -f4)
  if [[ -n $members && $members != "$(id -un)" ]] && ((!shared)); then
    die "group $gid has other members ($members); use --allow-shared-group to accept that they can read the secrets"
  fi
fi

mkdir -p "$dir" "$dir/tls"
chmod 0750 "$dir" "$dir/tls"
chgrp "$gid" "$dir" "$dir/tls" 2>/dev/null || true

random() { head -c "$1" /dev/urandom | base64 | tr -d '\n=+/' | head -c "$2"; }

put() { # name value
  local f=$dir/$1
  if [[ -e $f ]]; then echo "kept existing $f"; return; fi
  printf '%s\n' "$2" > "$f"
  chmod 0640 "$f"
  chgrp "$gid" "$f" 2>/dev/null || true
  echo "wrote $f"
}

((want_admin)) && put admin_token "$(random 48 48)"
((want_code)) && put access_code "$(random 24 16)"
((want_key)) && put secret_key "$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
if [[ -n $cert ]]; then
  for pair in "cert.pem:$cert" "key.pem:$key"; do
    name=${pair%%:*} src=${pair#*:}
    [[ -f $src ]] || die "$src is not a file"
    install -m 0640 "$src" "$dir/tls/$name"
    chgrp "$gid" "$dir/tls/$name" 2>/dev/null || true
    echo "wrote $dir/tls/$name"
  done
fi

# GNOME_SECRETS_GID and the *_FILE variables in .env (created from .env.example when missing).
[[ -f $env_file ]] || { cp "$here/.env.example" "$env_file"; chmod 0600 "$env_file"; }
setvar() { # name value
  if grep -q "^$1=" "$env_file"; then sed -i "s|^$1=.*|$1=$2|" "$env_file"; else printf '%s=%s\n' "$1" "$2" >> "$env_file"; fi
}
setvar GNOME_SECRETS_GID "$gid"
[[ -f $dir/admin_token ]] && setvar GNOME_ADMIN_TOKEN_FILE /run/secrets/admin_token
[[ -f $dir/access_code ]] && setvar GNOME_ACCESS_CODE_FILE /run/secrets/access_code
[[ -f $dir/secret_key ]] && setvar GNOME_SECRET_KEY_FILE /run/secrets/secret_key
echo "updated $env_file (GNOME_SECRETS_GID=$gid)"
