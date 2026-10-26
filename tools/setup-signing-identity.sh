#!/bin/bash
# Creates a self-signed code-signing certificate named "ArcMod Local" in the login keychain.
#   bash tools/setup-signing-identity.sh
#   bun tools/build-mod.ts --sign-identity "ArcMod Local"
# The certificate keeps one keychain identity across rebuilds, so "Always Allow" on
# "ArcMod Safe Storage" survives the next build. It is not an Apple Developer ID.
# It does not enable iCloud Keychain passwords or passkeys.
set -euo pipefail

NAME="ArcMod Local"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
DIR="${HOME}/.arcmod"
mkdir -p "$DIR"
chmod 700 "$DIR"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "Certificate \"$NAME\" is already in the login keychain."
  echo "Sign with: bun tools/build-mod.ts --sign-identity \"$NAME\""
  exit 0
fi

CONF="$DIR/codesign.cnf"
cat >"$CONF" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_req
[dn]
CN = ${NAME}
[v3_req]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = CA:false
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$DIR/ArcModLocal.key" -out "$DIR/ArcModLocal.crt" -config "$CONF"
chmod 600 "$DIR/ArcModLocal.key" "$DIR/ArcModLocal.crt"

openssl pkcs12 -export -inkey "$DIR/ArcModLocal.key" -in "$DIR/ArcModLocal.crt" \
  -out "$DIR/ArcModLocal.p12" -passout pass:arcmod-local
security import "$DIR/ArcModLocal.p12" -k "$KEYCHAIN" -P arcmod-local \
  -T /usr/bin/codesign -T /usr/bin/security
rm -f "$DIR/ArcModLocal.p12"

# May prompt, or fail until Keychain Access is used. The key stays in ~/.arcmod either way.
if ! security add-trusted-cert -d -r trustRoot -p codeSign -k "$KEYCHAIN" "$DIR/ArcModLocal.crt"; then
  echo "Could not mark the certificate trusted from the command line."
  echo "Open Keychain Access → login → \"$NAME\" → Get Info → Trust → Code Signing: Always Trust."
fi

echo "Created \"$NAME\". The private key is $DIR/ArcModLocal.key — keep it if you want this identity after a reinstall."
echo "Next: bun tools/build-mod.ts --sign-identity \"$NAME\""
echo "This identity is not an Apple Developer ID and does not enable iCloud Keychain."
