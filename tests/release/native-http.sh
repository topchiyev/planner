#!/bin/bash
# Run inside a clean offline Ubuntu guest with signed Planner and pinned nginx media.
set -Eeuo pipefail
trap 'printf "Native HTTP acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the read-only qualification media mount point}
release=/opt/planner/current
node=$release/runtime/node/bin/node
work=$(mktemp -d /var/tmp/planner-native-http.XXXXXX)
origin=https://planner.example.test
backend=http://127.0.0.1:27430
admin=/run/planner/admin.sock
proxy=/run/planner-proxy/http.sock
fixture_pid=
trap 'if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi' EXIT

[ "$(id -u)" = 0 ]
[ "$(ls /sys/class/net)" = lo ]
[ "$(ps -o comm= -p 1)" = systemd ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
[ ! -e /etc/planner ]
openssl pkeyutl -verify -rawin -pubin -inkey "$media/test-key.pub.pem" \
    -in "$media/manifest.json" -sigfile "$media/manifest.json.sig"
package=$(python3 - "$media" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
root = Path(sys.argv[1])
item = json.loads((root / 'manifest.json').read_text())['package']
assert item['name'] == 'planner-workspace' and item['architecture'] == 'amd64'
package = root / 'planner-workspace_0.1.0_amd64.deb'
assert item['filename'] == package.name and package.stat().st_size == item['size']
with package.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256']
print(package)
PY
)
(
    cd "$media/nginx"
    sha256sum -c <<'HASHES'
4176112bca331776560304ced6f6e6ca36fee2818a834d6ccdf79c6c58ed5e28  nginx-common_1.24.0-2ubuntu7.21_all.deb
c125a2ad6bfd25b6fdf92e3534a3facbf35180e05a054dcb84f68b63fc38227e  nginx_1.24.0-2ubuntu7.21_amd64.deb
HASHES
)
dpkg -i "$package"
dpkg -i "$media/nginx/"*.deb
plannerctl preflight --public-url "$origin" --json > "$work/preflight.json"
plannerctl setup --mode fresh --public-url "$origin" --json > "$work/setup.json"
plannerctl status --json > "$work/status.json"
openssl rand -hex 32 > /etc/planner/proxy-token
chown root:planner /etc/planner/proxy-token
chmod 0640 /etc/planner/proxy-token
awk '{ printf "proxy_set_header X-Planner-Proxy-Token %s;\n", $0 }' /etc/planner/proxy-token > /etc/nginx/planner-proxy-auth.conf
install -d -m 0755 /etc/ssl/planner
openssl req -x509 -newkey rsa:2048 -noenc -days 1 -subj /CN=planner.example.test \
    -addext subjectAltName=DNS:planner.example.test \
    -out /etc/ssl/planner/fullchain.pem -keyout /etc/ssl/planner/privkey.pem 2> "$work/keygen"
chmod 0644 /etc/ssl/planner/fullchain.pem
install -m 0644 "$media/planner-nginx.conf" /etc/nginx/conf.d/planner.conf
nginx -t
systemctl restart nginx
plannerctl restart --json > "$work/restarted.json"
ps -o user= --ppid "$(cat /run/nginx.pid)" | awk '$1 != "www-data" {invalid=1} END {exit (invalid || NR == 0)}'

curl_loopback() { curl --noproxy '*' --silent --show-error --max-time 8 "$@"; }
curl_tls() {
    curl_loopback --cacert /etc/ssl/planner/fullchain.pem --resolve planner.example.test:443:127.0.0.1 "$@"
}
check_status() { curl_loopback --fail --unix-socket "$admin" http://localhost/status; }
check_access() {
    check_status | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v == {"version":"0.1.0","access":json.loads(sys.argv[1])},v' "$1"
}
status_code() { "$@" -o /dev/null -w '%{http_code}'; }

[ "$(ss -H -ltn 'sport = :27430' | awk '{print $4}')" = '127.0.0.1:27430' ]
[ "$(stat -c '%U:%G:%a' /run/planner)" = 'planner:planner:750' ]
[ "$(stat -c '%U:%G:%a' "$admin")" = 'planner:planner:600' ]
[ "$(stat -c '%U:%G:%a' /run/planner-proxy)" = 'planner:planner:711' ]
[ "$(stat -c '%U:%G:%a' "$proxy")" = 'planner:planner:666' ]
if runuser -u nobody -- touch /run/planner-proxy/foreign 2>/dev/null; then exit 1; fi
check_access '{"kind":"enrollment","step":"recovery"}'
runuser -u planner -- curl --noproxy '*' --silent --fail --unix-socket "$admin" http://localhost/status > /dev/null
if runuser -u nobody -- curl --noproxy '*' --silent --fail --unix-socket "$admin" http://localhost/status >/dev/null; then
    echo 'The unrelated account reached the operator socket.' >&2
    exit 1
fi
[ "$(status_code curl_tls "$origin/health/live")" = 200 ]
[ "$(status_code curl_tls -H 'Host: forged.invalid' "$origin/health/live")" = 421 ]
[ "$(curl_tls -D "$work/ready-headers" -o "$work/ready" -w '%{http_code}' "$origin/health/ready")" = 503 ]
grep -Eiq '^cache-control: no-store[[:space:]]*$' "$work/ready-headers"
python3 - "$work/ready" <<'PY'
import json, sys, uuid
with open(sys.argv[1]) as file:
    value = json.load(file)
assert set(value) == {'status', 'version', 'requestId'}
assert value['status'] == 'unavailable' and value['version'] == '0.1.0'
assert uuid.UUID(value['requestId']).version == 4
PY
for path in /api/v1/projects /files/object /api/v1/boards/board-fixture/events /mcp /oauth/consent /workspace /boards/board-fixture/cards/card /status; do
    [ "$(status_code curl_tls "$origin$path")" = 503 ]
done
[ "$(status_code curl_tls --head "$origin/files/object")" = 503 ]
[ "$(status_code curl_tls --request POST "$origin/api/v1/session/login")" = 503 ]
[ "$(status_code curl_tls "$origin/recover")" = 200 ]
[ "$(status_code curl_tls "$origin/enroll-mfa")" = 503 ]
[ "$(status_code curl_tls -X POST -H 'Origin: https://forged.invalid' "$origin/api/v1/recovery/consume")" = 503 ]
[ "$(status_code curl_loopback -X POST -H "Origin: $origin" -H 'X-Forwarded-For: 192.0.2.9' \
    -H 'X-Forwarded-Host: planner.example.test' -H 'X-Forwarded-Proto: https' "$backend/api/v1/recovery/consume")" = 503 ]
[ "$(status_code curl_tls -X POST -H "Origin: $origin" "$origin/api/v1/recovery/consume")" = 404 ]

chmod 0710 /var/lib/planner/staging
check_access '{"kind":"unavailable","reason":"staging"}'
[ "$(status_code curl_tls "$origin/recover")" = 503 ]
chmod 0700 /var/lib/planner/staging
mv /var/lib/planner/staging /var/lib/planner/staging-fixture
plannerctl restart --json > "$work/staging-restart.json"
[ "$(status_code curl_tls "$origin/health/live")" = 200 ]
check_access '{"kind":"unavailable","reason":"staging"}'
mv /var/lib/planner/staging-fixture /var/lib/planner/staging
plannerctl restart --json > "$work/restored-staging.json"
runuser -u planner -- "$node" "$media/native-http-fixture.mjs" database
check_access '{"kind":"enrollment","step":"recovery"}'
systemctl stop planner-mongodb.service
check_access '{"kind":"unavailable","reason":"database"}'
[ "$(status_code curl_tls "$origin/health/live")" = 200 ]
[ "$(status_code curl_tls "$origin/health/ready")" = 503 ]
[ "$(status_code curl_tls "$origin/recover")" = 503 ]
systemctl start planner-mongodb.service
for attempt in {1..60}; do
    if check_access '{"kind":"enrollment","step":"recovery"}' > /dev/null 2>&1; then break; fi
    sleep .2
done
check_access '{"kind":"enrollment","step":"recovery"}'

systemctl kill --kill-whom=main --signal=KILL planner.service
for attempt in {1..60}; do
    if [ "$(systemctl show -p MainPID --value planner.service)" = 0 ]; then break; fi
    sleep .1
done
[ -S "$admin" ]
[ -S "$proxy" ]
plannerctl start --json > "$work/started.json"
check_access '{"kind":"enrollment","step":"recovery"}'
plannerctl stop --json > "$work/stopped.json"
[ ! -e "$admin" ]
[ ! -e "$proxy" ]

runuser -u nobody -- "$node" "$media/native-http-fixture.mjs" inert > "$work/inert.log" 2>&1 &
fixture_pid=$!
for attempt in {1..60}; do
    if grep -Fqx 'INERT LISTENER READY' "$work/inert.log"; then break; fi
    sleep .1
done
grep -Fqx 'INERT LISTENER READY' "$work/inert.log"
[ "$(status_code curl_tls "$origin/health/live")" = 502 ]
if grep -Fqx 'UNEXPECTED REQUEST' "$work/inert.log"; then exit 1; fi
kill "$fixture_pid"
wait "$fixture_pid" 2>/dev/null || true
fixture_pid=
echo 'The TLS proxy sent zero requests to the unrelated TCP listener during Planner downtime.'

runuser -u planner -- "$node" "$media/native-http-fixture.mjs" serve > "$work/fixture.log" 2>&1 &
fixture_pid=$!
for attempt in {1..60}; do
    if [ "$(status_code curl_loopback "$backend/health/ready" 2>/dev/null)" = 200 ]; then break; fi
    sleep .1
done
forged=( -H 'X-Forwarded-For: 198.51.100.10' -H 'X-Forwarded-Host: forged.invalid' -H 'X-Forwarded-Proto: http'
    -H 'X-Real-IP: 198.51.100.11' -H 'X-Planner-Proxy-Token: fabricated' -H 'Forwarded: host=forged.invalid;proto=http'
    -H 'X-Unrelated: preserved' )
curl_loopback --fail "${forged[@]}" -H 'Host: forged.invalid' "$backend/fixture/context" > "$work/direct.json"
curl_tls --fail --interface 127.0.0.2 "${forged[@]}" "$origin/fixture/context" > "$work/proxied.json"
python3 - "$work" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
for path, address in [('direct.json', None), ('proxied.json', '127.0.0.2')]:
    value = json.loads((root / path).read_text())
    assert value == {'context': {'origin': 'https://planner.example.test', 'clientAddress': address},
                     'host': 'planner.example.test', 'rawAddress': '127.0.0.1' if address is None else None,
                     'forwardingRemoved': True, 'canonicalHost': True, 'unrelated': ['preserved']}, value
PY
[ "$(status_code curl_tls "$origin/health/ready")" = 200 ]
"$node" "$media/native-http-fixture.mjs" stream
printf 'NATIVE HTTP ACCEPTANCE PASSED\n'
