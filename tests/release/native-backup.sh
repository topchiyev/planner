#!/bin/bash
# Run as root on separately blank, offline Noble guests. Transfer is writable only in source mode.
set -Eeuo pipefail
trap 'printf "Native backup acceptance failed in %s on line %s.\n" "$profile" "$LINENO" >&2' ERR
umask 077
profile=$1
media=$2
transfer=$3
[[ "$profile" = source || "$profile" = target ]]
[ "$(id -u)" = 0 ]
[ "$(ls /sys/class/net)" = lo ]
[ -z "$(ip route show default)" ]
for path in /opt/planner /var/lib/planner /etc/planner; do [ ! -e "$path" ]; done
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
if [ "$profile" = target ]; then findmnt -no OPTIONS --target "$transfer" | grep -Eq '(^|,)ro(,|$)'; fi

candidate="$media/planner-workspace_0.1.0_amd64.deb"
openssl pkeyutl -verify -rawin -pubin -inkey "$media/test-key.pub.pem" -in "$media/manifest.json" -sigfile "$media/manifest.json.sig"
python3 - "$media" "$candidate" <<'PY'
import hashlib,json,sys
from pathlib import Path
media, package = map(Path, sys.argv[1:])
item=json.loads((media/'manifest.json').read_text())['package']
assert item['name']=='planner-workspace' and item['architecture']=='amd64' and item['filename']==package.name
with package.open('rb') as stream: assert hashlib.file_digest(stream, 'sha256').hexdigest()==item['sha256']
assert item['size']==package.stat().st_size
PY
(cd "$media/pillow" && sha256sum --strict -c "$media/noble-media-closure.sha256")
dpkg -i "$media/pillow/"*.deb "$candidate"
work=$(mktemp -d /root/.planner-backup-acceptance.XXXXXX)
origin="https://$profile.example.test"
proxy=/run/planner-proxy/http.sock
admin=/run/planner/admin.sock
password='Synthetic test password number 42'
node=/opt/planner/current/runtime/node/bin/node
fixture=/var/tmp/owned-synthetic-backup-fixture.mjs
install -o root -g root -m 0644 "$media/native-backup-fixture.mjs" "$fixture"

json() {
    python3 - "$1" "$2" <<'PYJSON'
import json,sys
with open(sys.argv[1]) as stream:
    value=json.load(stream)
for key in sys.argv[2].split('.'):
    value=value[key]
print(value)
PYJSON
}
new_key() { cat /proc/sys/kernel/random/uuid; }
call() {
    local method=$1 route=$2
    shift 2
    curl -sS --noproxy '*' --max-time 25 --unix-socket "$proxy" -X "$method" -o "$work/body" -D "$work/headers" -w '%{http_code}' \
        -H "Origin: $origin" -H "X-Forwarded-Host: $profile.example.test" -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-For: 192.0.2.9' \
        -H "X-Planner-Proxy-Token: $token" "$@" "http://localhost$route"
}
expect() {
    local want=$1 got
    shift
    got=$(call "$@")
    if [ "$got" != "$want" ]; then
        printf 'Guest %s %s expected %s and got %s.\n' "$1" "$2" "$want" "$got" >&2
        python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v.get("error",{}).get("code",""))' "$work/body" 2>/dev/null || true
        return 1
    fi
}
wait_for() {
    local want=$1 route=$2
    for _ in {1..120}; do
        if [ "$(call GET "$route" 2>/dev/null || true)" = "$want" ]; then return 0; fi
        sleep .25
    done
    journalctl -u planner.service --no-pager -n 25
    return 1
}
write_proxy() {
    token=$(openssl rand -hex 32)
    install -o root -g planner -m 0640 /dev/null /etc/planner/proxy-token
    printf '%s\n' "$token" > /etc/planner/proxy-token
}
login() {
    expect 200 POST /api/v1/session/login -H 'Content-Type: application/json' --data-binary "{\"identifier\":\"$1\",\"password\":\"$password\"}"
    cookie=$(awk 'tolower($1)=="set-cookie:" { split($2, value, ";"); print value[1] }' "$work/headers")
}

if [ "$profile" = source ]; then
    plannerctl setup --mode fresh --public-url "$origin" --app-port 27820 --db-port 27821 --json > "$work/setup"
    write_proxy
    systemctl restart planner.service
    wait_for 200 /recover
    python3 - "$work/setup" "$password" > "$work/enroll" <<'PY'
import json,sys
v=json.load(open(sys.argv[1])); print(json.dumps(dict(grant=v['firstAdminGrant']['token'],name='Synthetic backup administrator',email='admin@example.test',password=sys.argv[2])))
PY
    expect 200 POST /api/v1/recovery/consume -H 'Content-Type: application/json' --data-binary "@$work/enroll"
    systemctl stop planner.service
    runuser -u planner -- "$node" "$fixture" seed > "$work/evidence"
    plannerctl start --json > "$work/restarted"
    wait_for 200 /health/ready
    login admin@example.test
    csrf=$(json "$work/body" csrfToken)
    card=$(json "$work/evidence" card)
    size=$(stat -c %s "$media/sample.png")
    expect 201 POST "/api/v1/cards/$card/attachment-files" -H "Cookie: $cookie" -H "X-CSRF-Token: $csrf" \
        -H 'If-Match: "1"' -H "Idempotency-Key: $(new_key)" -F "byteLength=$size" -F "file=@$media/sample.png"
    attachment=$(json "$work/body" data.reference.id)
    expect 200 GET "/api/v1/attachments/$attachment/download" -H "Cookie: $cookie"
    cmp "$media/sample.png" "$work/body"
    expect 200 GET "/api/v1/attachments/$attachment/thumbnail/small" -H "Cookie: $cookie"
    thumb_sha=$(sha256sum "$work/body" | cut -d' ' -f1)
    if runuser -u nobody -- plannerctl backup create > /dev/null 2>&1; then exit 1; fi
    expect 404 POST /backup/create -H "Cookie: $cookie" -H "X-CSRF-Token: $csrf"
    plannerctl backup create --json > "$work/backup"
    bundle=$(json "$work/backup" directory)
    fingerprint=$(json "$work/backup" manifestSha256)
    [ "$(stat -c '%U:%G:%a' "$bundle")" = planner:planner:700 ]
    [ "$(stat -c '%U:%G:%a' "$bundle/secrets.json")" = planner:planner:600 ]
    [ "$(sha256sum "$bundle/manifest.json" | cut -d' ' -f1)" = "$fingerprint" ]
    chmod 0700 "$transfer"
    cp -a --no-preserve=ownership "$bundle" "$transfer/snapshot"
    file_sha=$(sha256sum "$media/sample.png" | cut -d' ' -f1)
    python3 - "$work/evidence" "$fingerprint" "$attachment" "$file_sha" "$thumb_sha" "$cookie" > "$transfer/evidence.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1])); v.update(zip(['manifest','attachmentId','fileSha','thumbSha','originalCookie'],sys.argv[2:])); print(json.dumps(v))
PY
    if plannerctl backup restore --archive "$transfer/snapshot" --expect-manifest "$fingerprint" --public-url "$origin" --app-port 27820 --db-port 27821 > /dev/null 2>&1; then exit 1; fi
    expect 200 GET "/api/v1/attachments/$attachment/download" -H "Cookie: $cookie"
    cmp "$media/sample.png" "$work/body"
    sync
    echo 'NATIVE BACKUP SOURCE ACCEPTANCE PASSED'
else
    fingerprint=$(json "$transfer/evidence.json" manifest)
    attachment=$(json "$transfer/evidence.json" attachmentId)
    original=$(json "$transfer/evidence.json" originalCookie)
    wrong=$(printf '%064d' 0)
    args=(--archive "$transfer/snapshot" --public-url "$origin" --app-port 27840 --db-port 27841)
    if plannerctl backup restore "${args[@]}" --expect-manifest "$wrong" > /dev/null 2>&1; then exit 1; fi
    [ ! -e /etc/planner/backup-restore.json ]
    cp -a "$transfer/snapshot" "$work/tampered"
    printf X >> "$work/tampered/db/cards.bson"
    if plannerctl backup restore --archive "$work/tampered" --expect-manifest "$fingerprint" --public-url "$origin" --app-port 27840 --db-port 27841 > /dev/null 2>&1; then exit 1; fi
    [ ! -e /etc/planner/backup-restore.json ]
    exec {held}< /run/planner
    flock -n "$held"
    if plannerctl backup restore "${args[@]}" --expect-manifest "$fingerprint" > /dev/null 2>&1; then exit 1; fi
    flock -u "$held"
    exec {held}<&-
    plannerctl backup restore "${args[@]}" --expect-manifest "$fingerprint" --json > "$work/staged"
    [ "$(json "$work/staged" state)" = staged ]
    plannerctl backup restore "${args[@]}" --expect-manifest "$fingerprint" --json > "$work/staged-retry"
    cmp "$work/staged" "$work/staged-retry"
    if plannerctl setup --mode fresh --public-url "$origin" --app-port 27840 --db-port 27841 > /dev/null 2>&1; then exit 1; fi
    if plannerctl start > /dev/null 2>&1; then exit 1; fi
    if plannerctl backup activate --expect-manifest "$wrong" --yes > /dev/null 2>&1; then exit 1; fi
    [ ! -e /etc/planner/planner.json ]
    [ "$(systemctl show -p MainPID --value planner.service)" = 0 ]
    install -o root -g planner -m 0640 "$transfer/evidence.json" /var/tmp/owned-synthetic-backup-evidence.json
    runuser -u planner -- "$node" "$fixture" staged /var/tmp/owned-synthetic-backup-evidence.json
    write_proxy
    plannerctl backup activate --expect-manifest "$fingerprint" --yes --json > "$work/activated"
    [ "$(json "$work/activated" state)" = active ]
    wait_for 200 /health/ready
    plannerctl backup activate --expect-manifest "$fingerprint" --yes --json > "$work/activation-retry"
    cmp "$work/activated" "$work/activation-retry"
    runuser -u planner -- "$node" "$fixture" active /var/tmp/owned-synthetic-backup-evidence.json
    expect 401 GET /api/v1/session -H "Cookie: $original"
    login admin@example.test
    [ "$(json "$work/body" account.id)" = "$(json "$transfer/evidence.json" admin)" ]
    expect 200 GET "/api/v1/attachments/$attachment/download" -H "Cookie: $cookie"
    cmp "$media/sample.png" "$work/body"
    expect 200 GET "/api/v1/attachments/$attachment/thumbnail/small" -H "Cookie: $cookie"
    [ "$(sha256sum "$work/body" | cut -d' ' -f1)" = "$(json "$transfer/evidence.json" thumbSha)" ]
    login restore-fixture@example.test
    challenge=$(json "$work/body" challengeId)
    code=$(python3 - "$transfer/evidence.json" <<'PYTOTP'
import base64, hashlib, hmac, json, struct, sys, time
secret=json.load(open(sys.argv[1]))['mfaSecret']
key=base64.b32decode(secret + '=' * ((-len(secret)) % 8))
value=hmac.new(key, struct.pack('>Q', int(time.time()) // 30), hashlib.sha1).digest()
offset=value[-1] & 15
print(f"{(int.from_bytes(value[offset:offset + 4], 'big') & 0x7fffffff) % 1000000:06}")
PYTOTP
)
    expect 200 POST /api/v1/session/verify-mfa -H 'Content-Type: application/json' \
        --data-binary "{\"challengeId\":\"$challenge\",\"totpCode\":\"$code\"}"
    plannerctl restart --json > "$work/restarted"
    wait_for 200 /health/ready
    [ "$(sha256sum "$transfer/snapshot/manifest.json" | cut -d' ' -f1)" = "$fingerprint" ]
    echo 'NATIVE BACKUP TARGET ACCEPTANCE PASSED'
fi
