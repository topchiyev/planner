#!/bin/bash
set -Eeuo pipefail
trap 'printf "Staged native MFA acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the read-only qualification media mount point}
node=/opt/planner/current/runtime/node/bin/node
work=$(mktemp -d /var/tmp/planner-staged-mfa.XXXXXX)
origin=https://planner.example.test
cert=/etc/ssl/planner/fullchain.pem
trap 'rm -rf "$work"' EXIT

[ "$(id -u)" = 0 ]
[ "$(ls /sys/class/net)" = lo ]
[ "$(ps -o comm= -p 1)" = systemd ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
[ ! -e /etc/planner ]

openssl pkeyutl -verify -rawin -pubin -inkey "$media/test-key.pub.pem" \
    -in "$media/manifest.json" -sigfile "$media/manifest.json.sig"
package="$media/planner-workspace_0.1.0_amd64.deb"
python3 - "$media/manifest.json" "$package" <<'PY'
import hashlib, json, pathlib, sys
manifest, package = map(pathlib.Path, sys.argv[1:])
entry = json.loads(manifest.read_text())['package']
assert entry['filename'] == package.name and entry['size'] == package.stat().st_size
with package.open('rb') as stream:
    assert entry['sha256'] == hashlib.file_digest(stream, 'sha256').hexdigest()
PY
(
    cd "$media/nginx"
    sha256sum -c <<'HASHES'
4176112bca331776560304ced6f6e6ca36fee2818a834d6ccdf79c6c58ed5e28  nginx-common_1.24.0-2ubuntu7.21_all.deb
c125a2ad6bfd25b6fdf92e3534a3facbf35180e05a054dcb84f68b63fc38227e  nginx_1.24.0-2ubuntu7.21_amd64.deb
HASHES
)
dpkg -i "$package"
dpkg -i "$media/nginx/"*.deb
plannerctl setup --mode import --public-url "$origin" --json > "$work/setup.json"
openssl rand -hex 32 > /etc/planner/proxy-token
chown root:planner /etc/planner/proxy-token
chmod 0640 /etc/planner/proxy-token
awk '{ printf "proxy_set_header X-Planner-Proxy-Token %s;\n", $0 }' /etc/planner/proxy-token > /etc/nginx/planner-proxy-auth.conf
install -d -m 0755 /etc/ssl/planner
openssl req -x509 -newkey rsa:2048 -noenc -days 1 -subj /CN=planner.example.test -addext subjectAltName=DNS:planner.example.test \
    -out "$cert" -keyout /etc/ssl/planner/privkey.pem 2> "$work/keygen"
chmod 0644 "$cert"
install -m 0644 "$media/planner-nginx.conf" /etc/nginx/conf.d/planner.conf
nginx -t
systemctl restart nginx

systemctl stop planner.service
"$node" "$media/native-mfa-stage-fixture.mjs" prepare "$work/ticket"
plannerctl start --json > "$work/started.json"
certificate_key=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | \
    openssl dgst -sha256 -binary | openssl base64 -A)
chgrp nogroup "$work" "$work/ticket"
chmod 0710 "$work"
chmod 0640 "$work/ticket"
runuser -u nobody -- env LD_LIBRARY_PATH="$media/browser-libs" "$node" "$media/native-mfa-browser.mjs" \
    "$media/chromium/chrome-headless-shell" "$certificate_key" "$work/ticket"
systemctl stop planner.service
"$node" "$media/native-mfa-stage-fixture.mjs" verify
printf 'STAGED NATIVE MFA ACCEPTANCE PASSED\n'
