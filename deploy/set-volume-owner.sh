#!/usr/bin/env bash
# Hand the ChessX data volume to the unprivileged user the container runs as.
#
# The image used to run as root, so a volume created by it belongs to root. Once the image runs as `node` (uid 1000)
# that volume would be read-only to the server and the database could not be opened, so it is handed over once, before
# the container is recreated. Running this again is harmless: it only changes ownership, never the files themselves.
#
#   deploy/set-volume-owner.sh
#
# The volume name is what docker compose derives from the project: deploy_chessx_data. override with VOLUME=... if the
# compose project has been renamed.
set -euo pipefail

VOLUME="${VOLUME:-deploy_chessx_data}"
OWNER="${OWNER:-1000:1000}" # the `node` user in node:24-alpine
IMAGE="${IMAGE:-node:24-alpine}"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "No volume named $VOLUME: nothing to hand over (a new one will be created already owned by $OWNER)."
  exit 0
fi

echo "Handing $VOLUME to $OWNER…"
docker run --rm -v "$VOLUME:/data" "$IMAGE" chown -R "$OWNER" /data
docker run --rm -v "$VOLUME:/data" "$IMAGE" ls -ln /data
echo "Done."
