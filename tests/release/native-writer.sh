#!/bin/bash
# Run inside a clean offline Ubuntu guest with signed current and previous packages.
set -Eeuo pipefail
trap 'printf "Native writer acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the read-only qualification media mount point}
release=/opt/planner/current
node=$release/runtime/node/bin/node
work=$(mktemp -d /var/tmp/planner-native-writer.XXXXXX)
runtime=/run/planner
admin=$runtime/admin.sock
proxy=/run/planner-proxy/http.sock
uri=http://127.0.0.1:27430
origin=https://planner.example.test
setup=(plannerctl setup --mode fresh --public-url "$origin" --json)
sentinel=planner-test-writer-port.service
trap 'systemctl stop "$sentinel" 2>/dev/null || true' EXIT

[ "$(id -u)" = 0 ]
[ "$(ls /sys/class/net)" = lo ]
[ -z "$(ip route show default)" ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
[ ! -e /etc/planner ]
python3 "$media/release.py" verify "$media" "$media/test-key.pub.pem"
python3 "$media/release.py" verify "$media/previous" "$media/previous/test-key.pub.pem"
package=$media/planner-workspace_0.1.0_amd64.deb
[ -x /usr/bin/flock ]
dpkg-deb -f "$package" Pre-Depends | grep -F 'util-linux'
dpkg -i "$media/previous/planner-workspace_0.1.0_amd64.deb"
"${setup[@]}" > "$work/legacy-setup.json"
plannerctl stop > "$work/legacy-stop"
dpkg -i "$package"

pid() { systemctl show -p MainPID --value planner.service; }
probe() { curl --noproxy '*' -sS --max-time 8 -o "$work/health.json" -w '%{http_code}' "$uri/health/$1"; }
state() {
    "$node" --input-type=module - "$release" "${1:-report}" <<'JS'
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [, , release, action] = process.argv;
const { connectVerifiedNativeMongo } = await import(pathToFileURL(release + '/apps/backend/dist/native/mongo-readiness.js'));
const credential = JSON.parse(await readFile('/etc/planner/mongodb-app.json', 'utf8'));
const client = await connectVerifiedNativeMongo(credential);
const db = client.db('planner');
try {
  const installation = db.collection('installation');
  if (action !== 'report') {
    await installation.updateOne({ _id: 'installation' }, { $set: { schemaVersion: Number(action) } });
  }
  const record = await installation.findOne({ _id: 'installation' });
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  console.log(JSON.stringify({ schemaVersion: record.schemaVersion, inProgress: record.schemaMigration !== undefined,
    collections: collections.map((item) => item.name).sort(), grants: await db.collection('recoveryGrants').countDocuments({}) }));
} finally { await client.close(); }
JS
}

systemctl start planner-mongodb.service
for attempt in {1..100}; do if state > "$work/schema0.json" 2>/dev/null; then break; fi; sleep .1; done
python3 - "$work/schema0.json" <<'PY'
import json, sys
with open(sys.argv[1]) as file:
    record = json.load(file)
assert record['schemaVersion'] == 0 and not record['inProgress'] and record['grants'] == 1, record
PY
exec 8<"$runtime"
flock -nx 8
mongo_pid=$(systemctl show -p MainPID --value planner-mongodb.service)
[ "$mongo_pid" -gt 0 ]
for operation in start restart stop; do
    if plannerctl "$operation" 8<&- > "$work/refused-$operation" 2>&1; then exit 1; fi
    grep -F 'Another Planner writer already owns this installation.' "$work/refused-$operation"
done
if "$node" "$release/apps/backend/dist/native/operate.js" package-remove 8<&- > "$work/refused-remove" 2>&1; then exit 1; fi
grep -F 'Another Planner writer already owns this installation.' "$work/refused-remove"
[ "$(systemctl show -p MainPID --value planner-mongodb.service)" = "$mongo_pid" ]
[ "$(pid)" = 0 ]
state 8<&- > "$work/blocked-migration.json"
cmp "$work/schema0.json" "$work/blocked-migration.json"
echo 'Competing lifecycle commands preserved the maintenance process and unmigrated database.'
flock -u 8
exec 8<&-
plannerctl start > "$work/migrated-start"
plannerctl storage verify --json > "$work/verified-schema.json"
python3 - "$work/verified-schema.json" <<'PY'
import json, sys
with open(sys.argv[1]) as file:
    assert json.load(file) == {'schemaVersion': 1, 'activeGeneration': False}
PY

inode=$(stat -Lc '%d:%i' "$runtime")
assert_writer() {
    local main_pid=$1 fd matches=0
    [ "$main_pid" -gt 0 ]
    [ "$(stat -Lc '%d:%i' "/proc/$main_pid/root$runtime")" = "$inode" ]
    for fd in "/proc/$main_pid/fd/"*; do
        if [ "$(stat -Lc '%d:%i' "$fd" 2>/dev/null || true)" = "$inode" ]; then matches=$((matches + 1)); fi
    done
    [ "$matches" = 1 ]
    if flock -nx -E 75 "$runtime" true; then exit 1; else [ "$?" -eq 75 ]; fi
}
first=$(pid)
assert_writer "$first"
state > "$work/schema1.json"
plannerctl start > "$work/read-only-start"
"${setup[@]}" > "$work/replayed-setup.json"
[ "$(pid)" = "$first" ]
state > "$work/read-only-state.json"
cmp "$work/schema1.json" "$work/read-only-state.json"
python3 - "$work" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
before = json.loads((root / 'legacy-setup.json').read_text())
after = json.loads((root / 'replayed-setup.json').read_text())
assert before['firstAdminGrant'] == after['firstAdminGrant']
PY
state 0 > "$work/online-old-schema.json"
[ "$(probe live)" = 200 ]
[ "$(probe ready)" = 503 ]
if plannerctl start > "$work/online-old-refused" 2>&1; then exit 1; fi
state > "$work/still-old-schema.json"
cmp "$work/online-old-schema.json" "$work/still-old-schema.json"
state 1 > /dev/null

systemctl kill --kill-whom=main --signal=KILL planner.service
for attempt in {1..100}; do if [ "$(pid)" = 0 ]; then break; fi; sleep .1; done
[ "$(pid)" = 0 ]
[ -S "$admin" ] && [ -S "$proxy" ]
flock -nx "$runtime" true
plannerctl start > "$work/after-kill"
second=$(pid)
[ "$first" != "$second" ]
assert_writer "$second"
plannerctl stop > "$work/stop"
[ ! -e "$admin" ] && [ ! -e "$proxy" ]
flock -nx "$runtime" true

systemd-run --unit="$sentinel" --uid=nobody /usr/bin/python3 -m http.server 27430 --bind 127.0.0.1
for attempt in {1..100}; do
    if ss -H -ltn 'sport = :27430' | grep -q LISTEN; then break; fi
    sleep .1
done
ss -H -ltn 'sport = :27430' | grep -q LISTEN
sentinel_pid=$(systemctl show -p MainPID --value "$sentinel")
if runuser -u planner -- env PLANNER_NATIVE_INSTALLATION=1 "$node" "$release/apps/backend/dist/main.js" > "$work/launch" 2>&1; then exit 1; fi
grep -F 'Planner could not start its listeners.' "$work/launch"
[ ! -e "$admin" ] && [ ! -e "$proxy" ]
[ "$(systemctl show -p MainPID --value "$sentinel")" = "$sentinel_pid" ]
flock -nx "$runtime" true
systemctl stop "$sentinel"
plannerctl start > "$work/final-start"
assert_writer "$(pid)"
[ "$(probe live)" = 200 ]
[ "$(probe ready)" = 503 ]
printf 'NATIVE WRITER ACCEPTANCE PASSED\n'
