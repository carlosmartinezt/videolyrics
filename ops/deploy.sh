#!/usr/bin/env bash
#
# Deploy videolyrics.
#
# Caddy serves dist/ straight from this repo, so building *is* deploying the
# front end. The API is a systemd user unit, restarted here. Neither step
# needs sudo.
#
#   ./ops/deploy.sh            build, restart the API, verify
#   ./ops/deploy.sh --no-test  skip the test suites
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

RUN_TESTS=1
[[ "${1:-}" == "--no-test" ]] && RUN_TESTS=0

step "Checking prerequisites"
for binary in node npm; do
  command -v "$binary" >/dev/null || { red "missing $binary"; exit 1; }
done
[[ -x "$ROOT/aligner/.venv/bin/python" ]] || {
  red "aligner venv missing — run: uv venv --python 3.12 aligner/.venv && \\
    uv pip install --python aligner/.venv/bin/python --index-strategy unsafe-best-match \\
    --extra-index-url https://download.pytorch.org/whl/cpu -r aligner/requirements.txt"
  exit 1
}
FFMPEG="${FFMPEG_BIN:-$HOME/bin/ffmpeg}"
[[ -x "$FFMPEG" ]] || { red "no ffmpeg at $FFMPEG — see README"; exit 1; }
green "node $(node --version), python $("$ROOT/aligner/.venv/bin/python" --version | cut -d' ' -f2), ffmpeg present"

step "Installing dependencies"
npm ci --silent 2>/dev/null || npm install --silent

if [[ ! -f public/fonts/fonts.css ]]; then
  step "Fetching fonts (first run only)"
  npm run fonts
fi

if [[ $RUN_TESTS -eq 1 ]]; then
  step "Running tests"
  npx tsc -b --noEmit
  node --test shared/plan.test.mjs server/director/director.test.mjs
  "$ROOT/aligner/.venv/bin/python" -m unittest discover -s aligner -p "test_*.py"
  green "tests passed"
fi

step "Building the front end"
npx vite build
green "dist/ rebuilt — Caddy serves it directly, so the site is already live"

step "Warming the acoustic models"
# Downloads on first use would otherwise land inside somebody's first job and
# look like a two-minute stall.
FFMPEG_BIN="$FFMPEG" TORCH_HOME="$ROOT/aligner/.torch" \
  "$ROOT/aligner/.venv/bin/python" scripts/warm-models.py

step "Restarting the API"
UNIT_SRC="$ROOT/deploy/videolyrics-api.service"
UNIT_DST="$HOME/.config/systemd/user/videolyrics-api.service"
mkdir -p "$(dirname "$UNIT_DST")"
if ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  cp "$UNIT_SRC" "$UNIT_DST"
  systemctl --user daemon-reload
  green "unit file updated"
fi
systemctl --user enable --now videolyrics-api >/dev/null
systemctl --user restart videolyrics-api

step "Verifying"
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:3058/api/health >/dev/null 2>&1; then
    green "API healthy: $(curl -fsS http://127.0.0.1:3058/api/health)"
    break
  fi
  [[ $attempt -eq 20 ]] && { red "API did not come up"; journalctl --user -u videolyrics-api -n 30 --no-pager; exit 1; }
  sleep 0.5
done

if curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' https://videolyrics.carlosmartinezt.com/api/health 2>/dev/null | grep -q 200; then
  green "https://videolyrics.carlosmartinezt.com is live"
else
  printf '\n\033[33mNot reachable from outside yet.\033[0m Two things still need a human:\n'
  printf '  1. Cloudflare: add an A record  videolyrics -> 5.161.231.48  (proxied)\n'
  printf '  2. Caddy:      sudo sh -c "cat %s/deploy/Caddyfile.snippet >> /etc/caddy/Caddyfile" \\\n' "$ROOT"
  printf '                 && sudo systemctl reload caddy\n'
fi
