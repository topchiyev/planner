#!/bin/bash
# Run as root in a disposable, offline Noble guest with qualification media mounted read-only.
set -Eeuo pipefail
trap 'printf "Native private media acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077
media=${1:?Pass the mount point of the read-only qualification media}
[ "$(id -u)" = 0 ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
[ "$(ls -1 /sys/class/net)" = lo ]
[ -z "$(ip route show default)" ]
for path in /opt/planner /etc/planner /var/lib/planner; do [ ! -e "$path" ]; done
work=$(mktemp -d /var/tmp/planner-native-media.XXXXXX)
origin=https://planner.example.test
candidate="$media/planner-workspace_0.1.0_amd64.deb"
openssl pkeyutl -verify -rawin -pubin -inkey "$media/test-key.pub.pem" -in "$media/manifest.json" -sigfile "$media/manifest.json.sig"
python3 - "$media" "$candidate" <<'PY'
import hashlib, json, sys
from pathlib import Path
root, package = map(Path, sys.argv[1:])
manifest = json.loads((root / 'manifest.json').read_text())
item = manifest['package']
assert item['name'] == 'planner-workspace' and item['architecture'] == 'amd64'
assert item['filename'] == package.name and package.stat().st_size == item['size']
assert manifest['mediaDecoder']['package'] == 'python3-pil'
with package.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256']
PY
(cd "$media/pillow" && sha256sum --strict -c "$media/noble-media-closure.sha256")
(cd "$media/nginx" && sha256sum --strict -c <<'HASHES'
4176112bca331776560304ced6f6e6ca36fee2818a834d6ccdf79c6c58ed5e28  nginx-common_1.24.0-2ubuntu7.21_all.deb
c125a2ad6bfd25b6fdf92e3534a3facbf35180e05a054dcb84f68b63fc38227e  nginx_1.24.0-2ubuntu7.21_amd64.deb
HASHES
)
dpkg -i "$media/pillow/"*.deb "$media/nginx/"*.deb "$candidate"
dpkg --compare-versions "$(dpkg-query -W -f='${Version}' python3-pil)" ge 10.2.0-1ubuntu1.5
[ "$(stat -c '%U:%G:%a' /opt/planner/current/lib/decode-media.py)" = root:root:644 ]
plannerctl setup --mode fresh --public-url "$origin" --json > "$work/setup.json"
for path in staging blobs; do
    [ "$(stat -c '%U:%G:%a' "/var/lib/planner/$path")" = planner:planner:700 ]
    if runuser -u www-data -- test -r "/var/lib/planner/$path"; then exit 1; fi
done
openssl rand -hex 32 > /etc/planner/proxy-token
chown root:planner /etc/planner/proxy-token
chmod 0640 /etc/planner/proxy-token
awk '{ printf "proxy_set_header X-Planner-Proxy-Token %s;\n", $0 }' /etc/planner/proxy-token > /etc/nginx/planner-proxy-auth.conf
install -d -m 0755 /etc/ssl/planner
openssl req -x509 -newkey rsa:2048 -noenc -days 1 -subj /CN=planner.example.test \
    -addext subjectAltName=DNS:planner.example.test -out /etc/ssl/planner/fullchain.pem -keyout /etc/ssl/planner/privkey.pem 2> "$work/keygen"
install -m 0644 "$media/planner-nginx.conf" /etc/nginx/conf.d/planner.conf
nginx -t
systemctl restart nginx
systemctl restart planner.service

json() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v[sys.argv[2]])' "$1" "$2"; }
new_key() { cat /proc/sys/kernel/random/uuid; }
call() {
    local method=$1 path=$2
    shift 2
    curl -sS --noproxy '*' --max-time 50 --cacert /etc/ssl/planner/fullchain.pem --resolve planner.example.test:443:127.0.0.1 \
        -o "$work/body" -D "$work/headers" -w '%{http_code}' -X "$method" -H "Origin: $origin" "$@" "$origin$path"
}
expect() {
    local expected=$1 actual
    shift
    actual=$(call "$@")
    if [ "$actual" != "$expected" ]; then
        printf 'Guest media %s %s expected %s and got %s.\n' "$1" "$2" "$expected" "$actual" >&2
        python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v.get("error",{}).get("code",""))' "$work/body" 2>/dev/null || true
        return 1
    fi
}
wait_for() {
    local status=$1 path=$2
    for _ in {1..100}; do
        if [ "$(call GET "$path" 2>/dev/null || true)" = "$status" ]; then return 0; fi
        sleep .2
    done
    journalctl -u planner.service --no-pager -n 25
    return 1
}

wait_for 200 /recover
main_pid=$(systemctl show -p MainPID --value planner.service)
nsenter --target "$main_pid" --mount -- runuser -u planner -- /bin/bash -euc '
  [ "$(findmnt -no ID -T /var/lib/planner/staging)" = "$(findmnt -no ID -T /var/lib/planner/blobs)" ]
  ! test -x /var/lib/planner/mongodb
  ! ls /var/lib/planner/mongodb >/dev/null 2>&1
  probe=$(mktemp /var/lib/planner/staging/qualification.XXXXXX)
  link=/var/lib/planner/blobs/.qualification-atomic-link
  trap '''rm -f -- "$probe" "$link"''' EXIT
  ln "$probe" "$link"
  [ "$(stat -c "%d:%i" "$probe")" = "$(stat -c "%d:%i" "$link")" ]
'
echo 'Planner service mount permits atomic publication and shields MongoDB data.'
python3 - "$work/setup.json" > "$work/enroll.json" <<'PY'
import json, sys
from pathlib import Path
grant = json.loads(Path(sys.argv[1]).read_text())['firstAdminGrant']['token']
print(json.dumps(dict(grant=grant, name='Synthetic administrator', email='admin@example.test', password='Synthetic test password number 42')))
PY
expect 200 POST /api/v1/recovery/consume -H 'Content-Type: application/json' --data-binary "@$work/enroll.json"
expect 200 POST /api/v1/session/login -H 'Content-Type: application/json' \
    --data-binary '{"identifier":"admin@example.test","password":"Synthetic test password number 42"}'
csrf=$(json "$work/body" csrfToken)
cookie=$(awk 'tolower($1)=="set-cookie:" { split($2, value, ";"); print value[1] }' "$work/headers")
auth=(-H "Cookie: $cookie" -H "X-Csrf-Token: $csrf")
expect 200 GET /api/v1/me/profile "${auth[@]}"
revision=$(json "$work/body" revision)
key=$(new_key)
cp "$media/sample.png" "$work/avatar.png"
truncate -s 2097152 "$work/avatar.png"
size=$(stat -c %s "$work/avatar.png")
expect 422 PUT /api/v1/me/avatar "${auth[@]}" -H "If-Match: \"$revision\"" -H "Idempotency-Key: $(new_key)" \
    -F 'byteLength=1' -F "file=@$work/avatar.png"
for _ in 1 2; do
    expect 200 PUT /api/v1/me/avatar "${auth[@]}" -H "If-Match: \"$revision\"" -H "Idempotency-Key: $key" \
        -F "byteLength=$size" -F "file=@$work/avatar.png"
    grep -i '^content-type: application/json' "$work/headers" >/dev/null
    if [ -e "$work/committed" ]; then cmp "$work/committed" "$work/body"; else cp "$work/body" "$work/committed"; fi
done
expect 200 GET /api/v1/me/avatar "${auth[@]}"
cp "$work/body" "$work/thumbnail.png"
/usr/bin/python3 -I - "$work/thumbnail.png" <<'PY'
import sys
from PIL import Image
with Image.open(sys.argv[1]) as image:
    image.load()
    assert image.format == 'PNG' and image.width == 320 and image.mode == 'RGBA'
    assert not image.info
PY
expect 401 GET /api/v1/me/avatar -H 'Range: bytes=0-5' -H 'If-None-Match: *'
if grep -iqE '^(etag|content-range|accept-ranges):' "$work/headers"; then exit 1; fi
expect 206 GET /api/v1/me/avatar "${auth[@]}" -H 'Range: bytes=0-7'
head -c 8 "$work/thumbnail.png" > "$work/png-header"
cmp "$work/png-header" "$work/body"
[ -z "$(find /var/lib/planner/staging -mindepth 1 -print -quit)" ]

physical=$(sha256sum "$work/thumbnail.png" | cut -d' ' -f1)
blob="/var/lib/planner/blobs/$physical"
[ "$(stat -c '%U:%G:%a' "$blob")" = planner:planner:400 ]
plannerctl stop --json > "$work/stopped.json"
mv "$blob" "$work/intact.png"
plannerctl start --json > "$work/started.json"
wait_for 503 /health/ready
systemctl is-active --quiet planner.service
mv "$work/intact.png" "$blob"
wait_for 200 /health/ready
expect 200 GET /api/v1/me/avatar "${auth[@]}"
cmp "$work/thumbnail.png" "$work/body"
next_revision=$((revision + 1))
expect 204 DELETE /api/v1/me/avatar "${auth[@]}" -H "If-Match: \"$next_revision\"" -H "Idempotency-Key: $(new_key)"
grep -i '^planner-parent-revision:' "$work/headers" >/dev/null
expect 404 GET /api/v1/me/avatar "${auth[@]}"
echo 'NATIVE PRIVATE MEDIA ACCEPTANCE PASSED'
