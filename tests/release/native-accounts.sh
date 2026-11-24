#!/bin/bash
# Run as root in a disposable Ubuntu guest with verified candidate media attached read-only.
set -Eeuo pipefail
trap 'printf "Native account approval acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the mount point of the read-only candidate ISO}
[ "$(id -u)" = 0 ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
[ "$(ls -1 /sys/class/net)" = lo ]
[ -z "$(ip route show default)" ]
for path in /opt/planner /etc/planner /var/lib/planner; do [ ! -e "$path" ]; done

verify_package() {
    openssl pkeyutl -verify -rawin -pubin -inkey "$1/test-key.pub.pem" \
        -in "$1/manifest.json" -sigfile "$1/manifest.json.sig" >&2
    python3 - "$1" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
item = json.loads((root / 'manifest.json').read_text())['package']
assert item['name'] == 'planner-workspace' and item['architecture'] == 'amd64'
assert item['filename'] == 'planner-workspace_0.1.0_amd64.deb'
package = root / item['filename']
with package.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256']
assert package.stat().st_size == item['size']
print(package)
PY
}

candidate=$(verify_package "$media")
work=$(mktemp -d /var/tmp/planner-native-accounts.XXXXXX)
origin=https://planner.example.test
public=/run/planner-proxy/http.sock
admin=/run/planner/admin.sock
admin_email=admin@example.test
member_email=member@example.test
password='Synthetic test password number 42'
proxy_token=$(openssl rand -hex 32)

read_json() {
    python3 - "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    value = json.load(stream)
for key in sys.argv[2].split('.'):
    value = value[key]
print(value)
PY
}

proxy_call() {
    local method=$1 path=$2
    shift 2
    curl -sS --noproxy '*' --max-time 12 --unix-socket "$public" -o "$work/body.json" -D "$work/headers" \
        -w '%{http_code}' -X "$method" -H "Origin: $origin" -H "X-Planner-Proxy-Token: $proxy_token" \
        -H 'X-Forwarded-Host: planner.example.test' -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-For: 192.0.2.9' \
        "$@" "http://localhost$path"
}

expect_code() {
    local expected=$1
    shift
    local actual
    actual=$(proxy_call "$@")
    if [ "$actual" != "$expected" ]; then
        printf 'Guest fixture %s %s expected %s and got %s.\n' "$1" "$2" "$expected" "$actual" >&2
        return 1
    fi
}

dpkg -i "$candidate"
/usr/bin/plannerctl setup --mode fresh --public-url "$origin" --app-port 27530 --db-port 27531 --json > "$work/setup.json"
install -m 0640 -o root -g planner /dev/null /etc/planner/proxy-token
printf '%s\n' "$proxy_token" > /etc/planner/proxy-token
systemctl restart planner.service
for _ in {1..80}; do
    if [ "$(proxy_call GET /recover 2>/dev/null || true)" = 200 ]; then break; fi
    sleep .25
done

python3 - "$work/setup.json" "$admin_email" "$password" > "$work/enroll.json" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    grant = json.load(stream)['firstAdminGrant']['token']
print(json.dumps(dict(grant=grant, name='Synthetic administrator', email=sys.argv[2], password=sys.argv[3])))
PY
expect_code 200 POST /api/v1/recovery/consume -H 'Content-Type: application/json' --data-binary "@$work/enroll.json"
printf '{"identifier":"%s","password":"%s"}\n' "$admin_email" "$password" > "$work/admin-login.json"
expect_code 200 POST /api/v1/session/login -H 'Content-Type: application/json' --data-binary "@$work/admin-login.json"
csrf=$(read_json "$work/body.json" csrfToken)
cookie=$(awk 'tolower($1)=="set-cookie:" { split($2, value, ";"); print value[1] }' "$work/headers")
auth=(-H "Cookie: $cookie" -H "X-CSRF-Token: $csrf")

printf '{"name":"Synthetic member","email":"%s","username":null,"role":"boardUser"}\n' "$member_email" > "$work/provision.json"
expect_code 201 POST /api/v1/admin/accounts "${auth[@]}" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" --data-binary "@$work/provision.json"
member=$(read_json "$work/body.json" id)
expect_code 202 POST "/api/v1/admin/accounts/$member/recovery" "${auth[@]}" -H 'Content-Type: application/json' --data-binary '{"revision":1}'
approval=$(read_json "$work/body.json" id)
python3 - "$work/body.json" "$member" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    result = json.load(stream)
assert set(result) == {'id', 'actorId', 'targetId', 'revision', 'change', 'expiresAt'}
assert result['targetId'] == sys.argv[2] and result['change'] == {'action':'recovery'}
PY

[ "$(stat -c '%U:%G:%a' "$admin")" = 'planner:planner:600' ]
if runuser -u nobody -- curl -fsS --noproxy '*' --unix-socket "$admin" "http://localhost/accounts/approvals/$approval" >/dev/null 2>&1; then
    echo 'Unprivileged guest user reached the operator socket.' >&2
    exit 1
fi
expect_code 404 POST "/accounts/approvals/$approval/confirm" "${auth[@]}"
if plannerctl accounts confirm "$approval" > /dev/null 2>&1; then
    echo 'Operator CLI accepted confirmation without --yes.' >&2
    exit 1
fi
plannerctl accounts inspect "$approval" --json > "$work/inspection.json"
[ "$(read_json "$work/inspection.json" approval.targetId)" = "$member" ]
printf '{"identifier":"%s","password":"%s"}\n' "$member_email" "$password" > "$work/member-login.json"
expect_code 401 POST /api/v1/session/login -H 'Content-Type: application/json' --data-binary "@$work/member-login.json"
plannerctl accounts confirm "$approval" --yes --json > "$work/approved.json"
if plannerctl accounts confirm "$approval" --yes > /dev/null 2>&1; then
    echo 'Operator CLI consumed the same approval twice.' >&2
    exit 1
fi

python3 - "$work/approved.json" "$password" > "$work/recovery.json" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    result = json.load(stream)
assert result['outcome'] == 'applied'
print(json.dumps(dict(grant=result['recovery']['grant'], password=sys.argv[2])))
PY
expect_code 200 POST /api/v1/recovery/consume -H 'Content-Type: application/json' --data-binary "@$work/recovery.json"
expect_code 400 POST /api/v1/recovery/consume -H 'Content-Type: application/json' --data-binary "@$work/recovery.json"
expect_code 200 POST /api/v1/session/login -H 'Content-Type: application/json' --data-binary "@$work/member-login.json"
member_cookie=$(awk 'tolower($1)=="set-cookie:" { split($2, value, ";"); print value[1] }' "$work/headers")
expect_code 200 GET /api/v1/me/profile -H "Cookie: $member_cookie"
[ "$(read_json "$work/body.json" id)" = "$member" ]
echo 'NATIVE ACCOUNT APPROVAL ACCEPTANCE PASSED'
