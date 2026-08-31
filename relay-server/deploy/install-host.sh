#!/bin/sh
set -eu

SERVICE_NAME=pr-cockpit-relay.service
ACCOUNT=cockpit
APP_DIR=/opt/pr-cockpit-relay
STATE_DIR=/var/lib/pr-cockpit-relay
RELAY_DATA_DIR=$STATE_DIR/relay
CADDY_STATE_DIR=$STATE_DIR/caddy
CADDY_DATA_DIR=$CADDY_STATE_DIR/data
CADDY_CONFIG_DIR=$CADDY_STATE_DIR/config
CONFIG_DIR=/etc/pr-cockpit-relay
SECRET_FILE=$CONFIG_DIR/relay.env
COMPOSE_ENV_FILE=$CONFIG_DIR/compose.env
RUNTIME_FILE=$CONFIG_DIR/runtime.env
UNIT_FILE=/etc/systemd/system/$SERVICE_NAME
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR=$(dirname "$SCRIPT_DIR")

fail() {
  printf 'install-host: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -x /usr/bin/docker ] || fail "Docker Engine must be installed at /usr/bin/docker"
[ -x /usr/bin/systemctl ] || fail "systemd is required"

set --
if ! /usr/bin/docker compose version >/dev/null 2>&1; then
  set -- "$@" docker-compose-v2
fi
if [ ! -x /usr/bin/rsync ]; then
  set -- "$@" rsync
fi
if [ "$#" -gt 0 ]; then
  command -v apt-get >/dev/null 2>&1 || fail "required packages are missing and apt-get is unavailable"
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
fi
/usr/bin/docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable after package installation"
[ -x /usr/bin/rsync ] || fail "rsync is unavailable after package installation"

NOLOGIN=/usr/sbin/nologin
[ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
[ -x "$NOLOGIN" ] || fail "nologin shell is unavailable"

if ! getent group "$ACCOUNT" >/dev/null; then
  groupadd --system "$ACCOUNT"
fi
if ! id "$ACCOUNT" >/dev/null 2>&1; then
  useradd --system --gid "$ACCOUNT" --home-dir "$STATE_DIR" --no-create-home --shell "$NOLOGIN" "$ACCOUNT"
else
  usermod --home "$STATE_DIR" --shell "$NOLOGIN" "$ACCOUNT"
fi
for group in $(id -nG "$ACCOUNT"); do
  [ "$group" != docker ] || fail "$ACCOUNT must not belong to the root-equivalent docker group"
done

COCKPIT_UID=$(id -u "$ACCOUNT")
COCKPIT_GID=$(id -g "$ACCOUNT")
install -d -o root -g root -m 0755 "$APP_DIR"
install -d -o root -g root -m 0755 "$STATE_DIR"
install -d -o root -g root -m 0755 "$CADDY_STATE_DIR"
install -d -o "$COCKPIT_UID" -g "$COCKPIT_GID" -m 0700 "$RELAY_DATA_DIR"
install -d -o "$COCKPIT_UID" -g "$COCKPIT_GID" -m 0700 "$CADDY_DATA_DIR"
install -d -o "$COCKPIT_UID" -g "$COCKPIT_GID" -m 0700 "$CADDY_CONFIG_DIR"
install -d -o root -g root -m 0700 "$CONFIG_DIR"
[ -f "$COMPOSE_ENV_FILE" ] || fail "provision $COMPOSE_ENV_FILE as root-owned mode 0600 with RELAY_DOMAIN before rerunning"
[ ! -L "$COMPOSE_ENV_FILE" ] || fail "$COMPOSE_ENV_FILE must not be a symbolic link"
[ "$(stat -c '%u' "$COMPOSE_ENV_FILE")" = 0 ] || fail "$COMPOSE_ENV_FILE must be owned by root"
COMPOSE_ENV_MODE=$(stat -c '%a' "$COMPOSE_ENV_FILE")
case "$COMPOSE_ENV_MODE" in
  400|600) ;;
  *) fail "$COMPOSE_ENV_FILE must have mode 0400 or 0600" ;;
esac
grep -q '^RELAY_DOMAIN=.' "$COMPOSE_ENV_FILE" || fail "$COMPOSE_ENV_FILE must define a non-empty RELAY_DOMAIN"

[ -f "$SECRET_FILE" ] || fail "provision $SECRET_FILE as root-owned mode 0600 with WEBHOOK_SECRET before rerunning"
[ ! -L "$SECRET_FILE" ] || fail "$SECRET_FILE must not be a symbolic link"
[ "$(stat -c '%u' "$SECRET_FILE")" = 0 ] || fail "$SECRET_FILE must be owned by root"
SECRET_MODE=$(stat -c '%a' "$SECRET_FILE")
case "$SECRET_MODE" in
  400|600) ;;
  *) fail "$SECRET_FILE must have mode 0400 or 0600" ;;
esac
grep -q '^WEBHOOK_SECRET=.' "$SECRET_FILE" || fail "$SECRET_FILE must define a non-empty WEBHOOK_SECRET"

SOURCE_REAL=$(readlink -f "$SOURCE_DIR")
APP_REAL=$(readlink -f "$APP_DIR")
[ "$APP_REAL" = "$APP_DIR" ] || fail "$APP_DIR must not be a symbolic link"
if [ "$SOURCE_REAL" != "$APP_REAL" ]; then
  /usr/bin/rsync --archive --delete "$SOURCE_DIR/" "$APP_DIR/"
fi
chown -R root:root "$APP_DIR"
chmod 0755 "$APP_DIR"

RUNTIME_TMP=$(mktemp "$CONFIG_DIR/runtime.env.XXXXXX")
trap 'rm -f "$RUNTIME_TMP"' EXIT HUP INT TERM
printf 'COCKPIT_UID=%s\nCOCKPIT_GID=%s\n' "$COCKPIT_UID" "$COCKPIT_GID" >"$RUNTIME_TMP"
install -o root -g root -m 0600 "$RUNTIME_TMP" "$RUNTIME_FILE"
rm -f "$RUNTIME_TMP"
trap - EXIT HUP INT TERM

install -o root -g root -m 0644 "$SCRIPT_DIR/$SERVICE_NAME" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

FORWARDING_STATUS=disabled
if grep -q '^RELAY_FORWARD_WEBHOOK_URL=.' "$COMPOSE_ENV_FILE"; then
  FORWARDING_STATUS=enabled
fi
FORWARD_REPO_DISCOVERY_UNTIL=
while IFS= read -r line; do
  case "$line" in
    RELAY_FORWARD_REPO_DISCOVERY_UNTIL=*)
      FORWARD_REPO_DISCOVERY_UNTIL=${line#*=}
      ;;
  esac
done <"$COMPOSE_ENV_FILE"

printf '%s\n' \
  "Installed $SERVICE_NAME with container UID:GID $COCKPIT_UID:$COCKPIT_GID." \
  "Caddy publishes TLS traffic on TCP 443 and ACME HTTP challenges on TCP 80." \
  "Relay port 4821 is also available on host loopback only; it is never published publicly." \
  "Usage is available on host loopback only at http://127.0.0.1:4822/usage."
printf 'Webhook forwarding is %s; leave RELAY_FORWARD_WEBHOOK_URL unset or empty in %s to disable it.\n' \
  "$FORWARDING_STATUS" "$COMPOSE_ENV_FILE"
if [ "$FORWARDING_STATUS" = enabled ]; then
  if [ -n "$FORWARD_REPO_DISCOVERY_UNTIL" ]; then
    printf 'Repository forwarding cutoff is %s; repositories first seen at or after it stay new-relay-only.\n' \
      "$FORWARD_REPO_DISCOVERY_UNTIL"
  else
    printf '%s\n' "Repository forwarding cutoff is empty; all repositories are forwarded."
  fi
fi
