#!/usr/bin/env bash
# Pull the latest code and (re)build + restart ChessX on the droplet.
#
#   First time:  git clone https://github.com/CrudeTree/ChessX.git /opt/chessx
#                cp /opt/chessx/deploy/.env.example /opt/chessx/deploy/.env && nano /opt/chessx/deploy/.env
#   Every time:  /opt/chessx/deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f deploy/.env ]; then
  echo "deploy/.env is missing. Copy deploy/.env.example and set PUBLIC_URL." >&2
  exit 1
fi

git pull --ff-only
docker compose -f deploy/docker-compose.yml up -d --build
docker image prune -f >/dev/null

echo
docker compose -f deploy/docker-compose.yml ps
echo
echo "ChessX is up on 127.0.0.1:8080 — your reverse proxy should point here."
