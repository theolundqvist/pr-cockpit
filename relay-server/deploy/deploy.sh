#!/bin/sh
# Builds the relay image on this machine so the production host never compiles, then installs it on HOST over root SSH.
set -eu

[ "$#" -eq 1 ] || { printf 'usage: deploy/deploy.sh HOST\n' >&2; exit 2; }
HOST=$1
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

docker build --platform linux/amd64 -t pr-cockpit-relay:local "$SOURCE_DIR"
docker save pr-cockpit-relay:local | gzip -1 | ssh "$HOST" 'gunzip | docker load'
STAGE=$(ssh "$HOST" mktemp -d)
rsync --archive --delete "$SOURCE_DIR/" "$HOST:$STAGE/"
ssh "$HOST" "sh $STAGE/deploy/install-host.sh; status=\$?; rm -rf $STAGE; exit \$status"
