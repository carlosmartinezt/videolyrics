#!/usr/bin/env bash
#
# Deploy videolyrics.
#
# Two things get published, both into $PUBLIC_ROOT, both as a staged swap:
#
#   videolyrics-api/   what this box actually serves. server/, shared/ and the
#                      aligner's Python. The systemd unit runs from here.
#   videolyrics/       the front end. Dormant: Vercel serves www.videolyrics.org
#                      and the Caddy block pointing here is a fallback. Kept
#                      fresh so the fallback is not a year-old build.
#
# Neither step needs sudo.
#
#   ./ops/deploy.sh            build, publish, restart the API, verify
#   ./ops/deploy.sh --no-test  skip the test suites
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

. "$HOME/bin/deploy-lib.sh"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

RUN_TESTS=1
[[ "${1:-}" == "--no-test" ]] && RUN_TESTS=0

API_DIR="$PUBLIC_ROOT/videolyrics-api"
WEB_DIR="$PUBLIC_ROOT/videolyrics"

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

# The unit ships in this repo, so install it before the drift check rather than
# after: otherwise a change to WorkingDirectory= here could never be applied,
# the check would fail against the copy already installed, and the only way
# through would be to edit ~/.config/systemd/user by hand.
step "Installing the unit"
UNIT_SRC="$ROOT/deploy/videolyrics-api.service"
UNIT_DST="$HOME/.config/systemd/user/videolyrics-api.service"
mkdir -p "$(dirname "$UNIT_DST")"
if ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  cp "$UNIT_SRC" "$UNIT_DST"
  systemctl --user daemon-reload
  green "unit file updated"
else
  green "unit file unchanged"
fi

# Aborts if the unit's WorkingDirectory= and PUBLIC_ROOT have drifted. Without
# it the publish lands where nothing runs it and the restart brings the old
# build straight back, so the deploy reports success and changes nothing.
assert_unit_workdir videolyrics-api "$API_DIR" --user

step "Publishing the API"
# server/ and shared/ import nothing outside node: builtins, so there is no
# node_modules to carry — package.json goes along for `type: module` and for
# anyone running node from in here by hand.
#
# The aligner's .py files come too, because server/aligner.mjs finds align.py
# relative to itself. What does not come is .venv, .torch and data/: they are
# 2.8 GB and the jobs in flight, pinned by absolute path in the unit instead.
rm -rf "$API_DIR.new"
mkdir -p "$API_DIR.new"
cp -a server shared package.json package-lock.json "$API_DIR.new/"
mkdir -p "$API_DIR.new/aligner" "$API_DIR.new/scripts"
cp -a aligner/*.py aligner/requirements.txt "$API_DIR.new/aligner/"
cp -a scripts/warm-models.py "$API_DIR.new/scripts/"
rm -rf "$API_DIR.old"
[[ -d "$API_DIR" ]] && mv "$API_DIR" "$API_DIR.old"
mv "$API_DIR.new" "$API_DIR"
green "published to $API_DIR"

step "Building the front end"
npx vite build

# dist/ is build scratch inside the source tree. Vercel serves the real front
# end; this publish keeps the dormant Caddy fallback current.
rm -rf "$WEB_DIR.new"
mkdir -p "$WEB_DIR.new"
cp -a dist/. "$WEB_DIR.new/"
rm -rf "$WEB_DIR.old"
[[ -d "$WEB_DIR" ]] && mv "$WEB_DIR" "$WEB_DIR.old"
mv "$WEB_DIR.new" "$WEB_DIR"
green "published to $WEB_DIR"

step "Warming the acoustic models"
# Downloads on first use would otherwise land inside somebody's first job and
# look like a two-minute stall.
FFMPEG_BIN="$FFMPEG" TORCH_HOME="$ROOT/aligner/.torch" \
  "$ROOT/aligner/.venv/bin/python" scripts/warm-models.py

step "Restarting the API"
systemctl --user enable --now videolyrics-api >/dev/null
systemctl --user restart videolyrics-api

step "Verifying"
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:3058/api/health >/dev/null 2>&1; then
    green "API healthy: $(curl -fsS http://127.0.0.1:3058/api/health)"
    break
  fi
  if [[ $attempt -eq 20 ]]; then
    red "API did not come up. The previous build is still at $API_DIR.old:"
    red "  rm -rf $API_DIR && mv $API_DIR.old $API_DIR && systemctl --user restart videolyrics-api"
    journalctl --user -u videolyrics-api -n 30 --no-pager
    exit 1
  fi
  sleep 0.5
done

# The API is what this box serves. api.videolyrics.org is the name the Vercel
# front end calls; videolyrics.org still answers /api too and is checked second
# while that block is alive.
API=""
for candidate in "${API_URL:-https://api.videolyrics.org}" https://videolyrics.org; do
  if curl -fsS --max-time 6 -o /dev/null -w '%{http_code}' "$candidate/api/health" 2>/dev/null | grep -q 200; then
    API="$candidate"
    break
  fi
done

if [[ -n "$API" ]]; then
  green "$API is live"
  rm -rf "$API_DIR.old" "$WEB_DIR.old"
else
  rm -rf "$WEB_DIR.old"
  printf '\n\033[33mNot reachable from outside.\033[0m Local health passed, so this is DNS,\n'
  printf 'Cloudflare or Caddy rather than the build. Keeping %s.old for now.\n' "$API_DIR"
  printf '  1. Cloudflare: an A record for api.videolyrics.org -> 5.161.231.48\n'
  printf '  2. The origin cert must cover api.videolyrics.org — a cert for the\n'
  printf '     bare name alone gives a 526 that looks like the API is down.\n'
  printf '  3. Caddy:      sudo %s/ops/install-caddy-site.sh\n' "$ROOT"
fi
