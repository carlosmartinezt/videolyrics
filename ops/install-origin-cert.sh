#!/usr/bin/env bash
#
# Install a Cloudflare Origin CA certificate for videolyrics.org.
#
#   sudo ops/install-origin-cert.sh ~/videolyrics-origin.pem ~/videolyrics-origin.key
#
# Why this exists instead of Let's Encrypt:
#
# videolyrics.org sits behind Cloudflare's proxy, and something at the edge —
# "Always Use HTTPS", or a Redirect Rule — answers every http:// request with a
# 301 before it reaches this server. That includes
# /.well-known/acme-challenge/, so Let's Encrypt's HTTP-01 validation never
# arrives, no certificate is ever issued, and Cloudflare then reports 525
# because SSL mode Full expects an origin certificate that cannot exist.
# TLS-ALPN-01 is no escape either: Cloudflare terminates TLS at the edge, so
# that challenge never reaches this machine.
#
# A Cloudflare Origin CA certificate breaks the loop by removing the challenge
# entirely. It is issued by Cloudflare from the dashboard, lasts fifteen years,
# needs no renewal, and is trusted by Cloudflare's proxy specifically — which
# is the only party that ever sees it. Visitors continue to see Cloudflare's
# own public certificate, exactly as they do today.
#
# It is *not* publicly trusted, and that is the point worth understanding: it
# is valid only for the Cloudflare-to-origin hop. If this domain is ever taken
# out from behind the proxy, this certificate stops being appropriate and the
# host should go back to automatic Let's Encrypt — which is what
# videolyrics.carlosmartinezt.com still uses, deliberately left alone.
#
set -euo pipefail

CERT_SRC="${1:-}"
KEY_SRC="${2:-}"

DEST_DIR=/etc/caddy/origin-certs
DEST_CERT="$DEST_DIR/videolyrics.crt"
DEST_KEY="$DEST_DIR/videolyrics.key"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

if [[ -z "$CERT_SRC" || -z "$KEY_SRC" ]]; then
  red "usage: sudo ops/install-origin-cert.sh <certificate.pem> <private-key.key>"
  exit 1
fi
[[ -f "$CERT_SRC" ]] || { red "no such file: $CERT_SRC"; exit 1; }
[[ -f "$KEY_SRC"  ]] || { red "no such file: $KEY_SRC";  exit 1; }
[[ $EUID -eq 0 ]]    || { red "this writes $DEST_DIR — run it with sudo"; exit 1; }
command -v openssl >/dev/null || { red "openssl is not on PATH"; exit 1; }

step "Checking the certificate"

openssl x509 -in "$CERT_SRC" -noout >/dev/null 2>&1 \
  || { red "$CERT_SRC is not a PEM certificate. Copy the whole block including the BEGIN/END lines."; exit 1; }

# Cloudflare hands out RSA by default and ECDSA on request, so accept either
# rather than assuming.
if   openssl rsa -in "$KEY_SRC" -check -noout >/dev/null 2>&1; then KEY_KIND=RSA
elif openssl ec  -in "$KEY_SRC" -check -noout >/dev/null 2>&1; then KEY_KIND=ECDSA
else red "$KEY_SRC is not a usable private key. Copy the whole block including the BEGIN/END lines."; exit 1
fi

# The single most likely mistake is pasting a certificate and a key from two
# different "Create Certificate" clicks. Compare the public keys; if they
# disagree, Caddy would fail to start and take the other nine sites with it.
CERT_PUB=$(openssl x509 -in "$CERT_SRC" -noout -pubkey 2>/dev/null | openssl sha256)
KEY_PUB=$(openssl pkey -in "$KEY_SRC" -pubout 2>/dev/null | openssl sha256)
if [[ "$CERT_PUB" != "$KEY_PUB" ]]; then
  red "The certificate and the private key do not match."
  red "They must come from the same 'Create Certificate' click in Cloudflare."
  exit 1
fi
green "$KEY_KIND key matches the certificate"

SUBJECT_ALT=$(openssl x509 -in "$CERT_SRC" -noout -ext subjectAltName 2>/dev/null | tr -d ' ' | grep -o 'DNS:[^,]*' | sed 's/DNS://' || true)
printf '  covers: %s\n' "$(echo "$SUBJECT_ALT" | tr '\n' ' ')"
for needed in videolyrics.org '*.videolyrics.org'; do
  if ! grep -qxF "$needed" <<<"$SUBJECT_ALT"; then
    red "The certificate does not cover $needed."
    red "In Cloudflare, the hostname list must contain both videolyrics.org and *.videolyrics.org."
    exit 1
  fi
done
green "covers videolyrics.org and *.videolyrics.org"

NOT_AFTER=$(openssl x509 -in "$CERT_SRC" -noout -enddate | cut -d= -f2)
printf '  expires: %s\n' "$NOT_AFTER"

step "Installing"

install -d -m 0755 -o root -g root "$DEST_DIR"
install -m 0644 -o root -g caddy "$CERT_SRC" "$DEST_CERT"
install -m 0640 -o root -g caddy "$KEY_SRC"  "$DEST_KEY"
green "$DEST_CERT"
green "$DEST_KEY (group caddy, mode 0640)"

step "Next"
cat <<'EOF'
  1. sudo ops/install-caddy-site.sh
       points videolyrics.org and www.videolyrics.org at this certificate

  2. In Cloudflare, SSL/TLS -> Overview, set the mode to Full (strict)
       Full alone accepts any certificate from the origin, including a forged
       one, which makes the encryption between Cloudflare and this server
       decorative. Strict verifies it, and an Origin CA certificate is exactly
       what it expects.

  The private key is on this machine and nowhere else. If it ever leaks,
  revoke it in Cloudflare under SSL/TLS -> Origin Server and issue a new one.
EOF
