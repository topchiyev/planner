#!/bin/bash
# Run as root in a disposable Ubuntu guest with verified candidate media attached read-only.
set -Eeuo pipefail
trap 'printf "Native journal acceptance failed on line %s.\n" "$LINENO" >&2' ERR
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
work=$(mktemp -d /var/tmp/planner-native-journal.XXXXXX)
release=/opt/planner/current
fixture() { "$release/runtime/node/bin/node" "$media/native-journal-fixture.mjs" "$work" "$1"; }

wait_for_access() {
    local expected=$1
    for _ in {1..80}; do
        if curl -fsS --noproxy '*' --unix-socket /run/planner/admin.sock http://localhost/status > "$work/access.json" 2>/dev/null \
            && python3 -c 'import json, sys; assert json.load(open(sys.argv[1]))["access"] == json.loads(sys.argv[2])' \
                "$work/access.json" "$expected" 2>/dev/null; then
            return
        fi
        sleep 0.25
    done
    cat "$work/access.json" >&2
    journalctl -u planner.service --no-pager -n 25 >&2
    return 1
}
enrollment='{"kind":"enrollment","step":"recovery"}'
unavailable='{"kind":"unavailable","reason":"schema-or-recovery"}'

dpkg -i "$candidate"
/usr/bin/plannerctl setup --mode fresh --public-url https://planner.example.test --app-port 27530 --db-port 27531 \
    --json > "$work/setup.json"
wait_for_access "$enrollment"

systemctl stop planner.service
systemctl is-active --quiet planner-mongodb.service
interrupted=0
fixture interrupt || interrupted=$?
[ "$interrupted" = 137 ]
fixture verify-interrupted
systemctl start planner.service
recovered=false
for _ in {1..40}; do
    if fixture verify-recovered > "$work/replay.log" 2>&1; then
        recovered=true
        break
    fi
    sleep 0.25
done
if [ "$recovered" != true ]; then
    cat "$work/replay.log" >&2
    journalctl -u planner.service --no-pager -n 25 >&2
    exit 1
fi
echo 'The installed backend recovered the interrupted multi-document command.'

systemctl stop planner.service
fixture remove-outbox-event
systemctl start planner.service
invocation=$(systemctl show -p InvocationID --value planner.service)
closed=false
for _ in {1..80}; do
    if journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$invocation" | grep -F 'Planner command recovery could not be completed.'; then
        closed=true
        break
    fi
    sleep 0.25
done
[ "$closed" = true ]
wait_for_access "$unavailable"
echo 'The installed backend withheld enrollment after detecting a missing durable event.'
systemctl stop planner.service
fixture restore-outbox-event
systemctl start planner.service
wait_for_access "$enrollment"
fixture verify-recovered
echo 'NATIVE JOURNAL RECOVERY ACCEPTANCE PASSED'
