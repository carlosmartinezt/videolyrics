#!/usr/bin/env bash
#
# Build the videolyrics image, and hand the front end to Caddy.
#
#   ops/docker-build.sh
#
# Two things happen here, and the second is the one worth explaining.
#
# Caddy serves dist/ straight off the disk, with the caching and CSP headers
# that live in deploy/Caddyfile.snippet. Proxying static files through the
# container instead would throw all of that away for no gain, so the build
# copies dist/ out of the finished image onto the host. The container owns
# producing the front end; Caddy carries on serving it. Nothing about the
# Caddy configuration has to change.
#
# The swap at the end is atomic-ish on purpose: dist/ is live traffic, and an
# `rm -rf dist` followed by a slow copy is a window where the site is 404.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

IMAGE="${IMAGE:-videolyrics:latest}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

command -v docker >/dev/null || {
  red "Docker is not installed."
  echo "  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2"
  echo "  sudo usermod -aG docker $USER   # then log out and back in"
  exit 1
}
docker info >/dev/null 2>&1 || {
  red "Cannot talk to the Docker daemon."
  echo "  Either it is not running (sudo systemctl start docker), or your user"
  echo "  is not in the docker group (sudo usermod -aG docker $USER, then re-login)."
  exit 1
}

step "Building $IMAGE"
docker build -t "$IMAGE" "$ROOT"

step "Image size"
docker image inspect "$IMAGE" --format '  {{.RepoTags}}  {{printf "%.2f" (divf .Size 1073741824)}} GB'

step "Extracting dist/ for Caddy"
CID=$(docker create "$IMAGE")
trap 'docker rm -v "$CID" >/dev/null 2>&1 || true' EXIT

rm -rf "$ROOT/dist.new"
docker cp "$CID:/app/dist" "$ROOT/dist.new"

# Refuse to swap in something obviously broken — an empty or index-less build
# would take the site down just as effectively as a bad Caddyfile.
[[ -f "$ROOT/dist.new/index.html" ]] || { red "the built dist/ has no index.html; leaving the live one alone"; exit 1; }
FILES=$(find "$ROOT/dist.new" -type f | wc -l)
[[ "$FILES" -gt 5 ]] || { red "the built dist/ has only $FILES files; leaving the live one alone"; exit 1; }

rm -rf "$ROOT/dist.old"
[[ -d "$ROOT/dist" ]] && mv "$ROOT/dist" "$ROOT/dist.old"
mv "$ROOT/dist.new" "$ROOT/dist"
rm -rf "$ROOT/dist.old"
green "dist/ replaced — $FILES files"

step "Next"
cat <<'EOF'
  Run it alongside the existing service first, on a spare port:

      VIDEOLYRICS_PORT=3059 docker compose up -d
      curl -s localhost:3059/api/health

  When you are happy, switch over:

      docker compose down
      systemctl --user stop videolyrics-api
      docker compose up -d

  To go back at any point:

      docker compose down && systemctl --user start videolyrics-api
EOF
