#!/usr/bin/env bash
# Create an HTTPS certificate for serving MeetingMinutes directly on a port,
# without a reverse proxy and without sudo.
#
#   scripts/make-cert.sh 203.0.113.10                   # the server's public IP
#   scripts/make-cert.sh 203.0.113.10 minutes.lab.local # several IPs / host names
#
# It creates, under data/tls/:
#   ca.crt / ca.key          a private certificate authority for your team (10 years).
#                            Created once and reused, so re-issuing the server
#                            certificate (e.g. a new IP) needs nothing new on clients.
#   server.crt / server.key  the certificate the web server presents (825 days).
#
# Browsers show a warning until they trust ca.crt. Either install ca.crt on the
# team's computers once (see README, "Serving directly on a port"), or accept the
# warning after comparing the fingerprint printed below. If you have a domain
# name, a publicly trusted certificate (e.g. acme.sh with a DNS challenge) avoids
# the warning entirely; point TLS_CERT_FILE / TLS_KEY_FILE at it instead.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
  echo "usage: scripts/make-cert.sh <ip-or-hostname> [more ...]" >&2
  echo "  This machine's addresses: $(hostname -I 2>/dev/null || true)" >&2
  exit 2
fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

DIR=data/tls
mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077

san=""
for name in "$@"; do
  if [[ $name =~ ^[0-9.]+$ || $name == *:* ]]; then san+="IP:$name,"; else san+="DNS:$name,"; fi
done
san+="DNS:localhost,IP:127.0.0.1"

if [ ! -f "$DIR/ca.key" ]; then
  openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -keyout "$DIR/ca.key" -out "$DIR/ca.crt" -days 3650 \
    -subj "/CN=MeetingMinutes team CA ($(hostname))" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  echo "Created a new team CA: $DIR/ca.crt"
else
  echo "Reusing the existing team CA: $DIR/ca.crt"
fi

openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
  -keyout "$DIR/server.key" -out "$DIR/server.csr" -subj "/CN=$1" 2>/dev/null
cat > "$DIR/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=$san
EOF
openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial \
  -out "$DIR/server.crt" -days 825 -sha256 -extfile "$DIR/server.ext" 2>/dev/null
cat "$DIR/ca.crt" >> "$DIR/server.crt" # send the chain, so clients that trust the CA can verify it
rm -f "$DIR/server.csr" "$DIR/server.ext"
chmod 644 "$DIR/ca.crt" "$DIR/server.crt"

echo
echo "Server certificate for: ${san//,/, }"
echo "  valid until $(openssl x509 -in "$DIR/server.crt" -noout -enddate | cut -d= -f2)"
echo
echo "Team CA fingerprint (compare before trusting or accepting a warning):"
echo "  $(openssl x509 -in "$DIR/ca.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
echo
echo "Add to .env, then restart scripts/start.sh and scripts/worker.sh:"
echo "  HOST=0.0.0.0"
echo "  PORT=8443"
echo "  TLS_CERT_FILE=$DIR/server.crt"
echo "  TLS_KEY_FILE=$DIR/server.key"
echo "  PUBLIC_URL=https://$1:8443"
