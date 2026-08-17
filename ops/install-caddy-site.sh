#!/usr/bin/env bash
#
# Install videolyrics' Caddy configuration.
#
#   sudo ops/install-caddy-site.sh          apply
#   sudo ops/install-caddy-site.sh --dry    show the result, change nothing
#
# /etc/caddy/Caddyfile serves six sites. This replaces only the videolyrics
# region — marked by sentinel comments, or matched by site address on the
# first run — and refuses to write anything that does not validate. A
# timestamped backup is kept either way.
#
# Needs root because the Caddyfile does. Nothing else here does.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
SNIPPET="$ROOT/deploy/Caddyfile.snippet"
DRY=0
[[ "${1:-}" == "--dry" ]] && DRY=1

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

[[ -f "$SNIPPET" ]]   || { red "missing $SNIPPET"; exit 1; }
[[ -f "$CADDYFILE" ]] || { red "missing $CADDYFILE"; exit 1; }
command -v caddy >/dev/null || { red "caddy is not on PATH"; exit 1; }

if [[ $DRY -eq 0 && $EUID -ne 0 ]]; then
  red "This writes $CADDYFILE — run it with sudo, or pass --dry to preview."
  exit 1
fi

step "Building the new configuration"

MERGED=$(mktemp)
trap 'rm -f "$MERGED"' EXIT

# The surgery is done in node rather than sed: removing a site block means
# matching braces, and a regex that gets that wrong on a six-site file is a
# much worse outcome than a few extra lines of script.
node - "$CADDYFILE" "$SNIPPET" > "$MERGED" <<'NODE'
const fs = require('node:fs');
const [caddyfile, snippet] = process.argv.slice(2);

let text = fs.readFileSync(caddyfile, 'utf8');
const block = fs.readFileSync(snippet, 'utf8')
  // Keep only the managed region of the snippet, so the file's own preamble
  // does not end up pasted into the Caddyfile.
  .replace(/^[\s\S]*?(?=# >>> videolyrics)/, '')
  .trimEnd();

const START = '# >>> videolyrics (managed by ops/install-caddy-site.sh) >>>';
const END = '# <<< videolyrics <<<';

// 1. If the managed region already exists, cut it out.
const from = text.indexOf(START);
const to = text.indexOf(END);
if (from !== -1 && to !== -1 && to > from) {
  text = text.slice(0, from) + text.slice(to + END.length);
}

/**
 * Remove a top-level site block by its address, matching braces so a nested
 * `handle { … }` cannot end the block early.
 */
function removeSite(source, address) {
  const pattern = new RegExp(
    `(^|\\n)((?:[ \\t]*#[^\\n]*\\n)*)[ \\t]*${address.replace(/\./g, '\\.')}[^\\n{]*\\{`,
    'g',
  );
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const blockStart = match.index + (match[1] ? 1 : 0);
    let depth = 0;
    let i = source.indexOf('{', match.index);
    let inComment = false;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '#') inComment = true;
      else if (ch === '\n') inComment = false;
      else if (!inComment && ch === '{') depth++;
      else if (!inComment && ch === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    if (depth !== 0) {
      process.stderr.write(`unbalanced braces around ${address}; refusing to guess\n`);
      process.exit(2);
    }
    source = source.slice(0, blockStart) + source.slice(i);
    pattern.lastIndex = 0;
  }
  return source;
}

// 2. Drop the hand-written header from the first install, which names the
//    old subdomain and would now sit above a videolyrics.org block. Matched
//    as a contiguous run of comment lines that mentions videolyrics by name,
//    rather than by exact text: the wording in the live file already drifted
//    from the wording in this repo once.
{
  const lines = text.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#/.test(lines[i])) { kept.push(lines[i]); continue; }
    let j = i;
    while (j < lines.length && /^\s*#/.test(lines[j])) j++;
    const run = lines.slice(i, j).join('\n');
    const isOurStaleHeader = /Caddy site block for videolyrics/i.test(run);
    if (!isOurStaleHeader) kept.push(...lines.slice(i, j));
    i = j - 1;
  }
  text = kept.join('\n');
}

// 3. Remove any pre-sentinel blocks for the hosts we are about to define.
for (const address of ['videolyrics.org', 'www.videolyrics.org', 'videolyrics.carlosmartinezt.com']) {
  text = removeSite(text, address);
}

process.stdout.write(text.replace(/\n{3,}$/, '\n').trimEnd() + '\n\n' + block + '\n');
NODE

step "Validating"
if ! caddy validate --config "$MERGED" --adapter caddyfile > /tmp/caddy-validate.$$ 2>&1; then
  red "The merged configuration is invalid. Nothing has been changed."
  tail -20 /tmp/caddy-validate.$$
  rm -f /tmp/caddy-validate.$$
  exit 1
fi
rm -f /tmp/caddy-validate.$$
green "valid"

if [[ $DRY -eq 1 ]]; then
  step "Dry run — this is what would be written"
  diff -u "$CADDYFILE" "$MERGED" || true
  exit 0
fi

BACKUP="$CADDYFILE.$(date +%Y%m%d-%H%M%S).bak"
cp -a "$CADDYFILE" "$BACKUP"
green "backed up to $BACKUP"

cat "$MERGED" > "$CADDYFILE"

step "Reloading Caddy"
if systemctl reload caddy; then
  green "reloaded"
else
  red "reload failed — restoring the backup"
  cat "$BACKUP" > "$CADDYFILE"
  systemctl reload caddy || true
  exit 1
fi

step "Checking the hosts"
for host in videolyrics.org www.videolyrics.org videolyrics.carlosmartinezt.com; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://$host/" 2>/dev/null || echo "---")
  printf '  %-34s %s\n' "$host" "$code"
done

printf '\nA certificate for a brand new hostname can take a minute to issue.\n'
printf 'Watch it with:  journalctl -u caddy -f\n'
