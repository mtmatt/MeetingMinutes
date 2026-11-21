#!/usr/bin/env bash
# Install a publicly trusted certificate issued by acme.sh (e.g. Let's Encrypt)
# for the built-in HTTPS server, and have every renewal restart the web server.
#
#   scripts/install-cert.sh minutes.example.com
#
# Issue the certificate first, with a DNS challenge (no root, no port 80), e.g.
# for a domain on Cloudflare:
#   export CF_Token=...            # an API token allowed to edit that zone's DNS
#   ~/.acme.sh/acme.sh --issue --dns dns_cf -d minutes.example.com
# (other DNS providers: https://github.com/acmesh-official/acme.sh/wiki/dnsapi)
#
# Then run this script once. acme.sh remembers the paths and the restart
# command, and its daily cron job renews the certificate before it expires.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
domain="${1:-}"
if [ -z "$domain" ]; then
  echo "usage: scripts/install-cert.sh <domain>" >&2
  exit 2
fi

acme="$(command -v acme.sh || true)"
[ -z "$acme" ] && [ -x "$HOME/.acme.sh/acme.sh" ] && acme="$HOME/.acme.sh/acme.sh"
[ -n "$acme" ] || { echo "acme.sh not found. Install it: curl https://get.acme.sh | sh" >&2; exit 1; }

dir="$PROJECT_DIR/data/tls"
mkdir -p "$dir"
chmod 700 "$dir"
umask 077

"$acme" --install-cert -d "$domain" \
  --key-file "$dir/server.key" \
  --fullchain-file "$dir/server.crt" \
  --reloadcmd "$PROJECT_DIR/scripts/restart.sh web"

cat <<EON

Certificate installed in $dir. Make sure .env has:

  HOST=0.0.0.0
  PORT=8443
  TLS_CERT_FILE=data/tls/server.crt
  TLS_KEY_FILE=data/tls/server.key
  PUBLIC_URL=https://$domain:8443

acme.sh restarts the web server (scripts/restart.sh web) after each renewal.
EON
