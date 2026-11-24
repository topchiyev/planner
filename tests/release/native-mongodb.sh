#!/bin/bash
# Run as root inside a disposable Ubuntu guest after native-installation.sh passes.
set -Eeuo pipefail
trap 'printf "Native MongoDB acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077

work=$(mktemp -d /var/tmp/planner-mongo-test.XXXXXX)
release=/opt/planner/current
node=$release/runtime/node/bin/node
entry=$release/apps/backend/dist/native/bootstrap-mongo.js
port=27431
config=/etc/planner
journal=$config/mongodb-init.json
socket=/var/lib/planner/mongodb/.planner-bootstrap/mongod.sock
amongo=planner-mongodb.service
temporary=planner-mongodb-bootstrap.service
collision=planner-test-mongo-collision.service
sentinel=planner-test-foreign-mongo.service

pid() { systemctl show -p MainPID --value "$1"; }
initialize() { "$node" "$entry" "$port"; }
wait_for() {
    for attempt in {1..300}; do
        if "$@"; then return; fi
        sleep .02
    done
    echo "Condition timed out: $*" >&2
    return 1
}
check_readiness() {
    runuser -u planner -- "$node" --input-type=module - "$release" "${1:-}" <<'JS'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { checkMongoReadiness } = await import(pathToFileURL(process.argv[2] + '/apps/backend/dist/native/mongo-readiness.js'));
const expected = process.argv[3];
if (expected) await assert.rejects(checkMongoReadiness(), (error) => error.message.includes(expected));
else await checkMongoReadiness();
JS
}

[ "$(id -u)" = 0 ]
[ ! -e "$journal" ]
[ ! -e "$config/mongod.conf" ]
systemctl stop planner-test-port.service
foreign_pid=$(pid "$sentinel")
[ "$foreign_pid" -gt 0 ]
foreign_stat=$(awk '{print $22}' "/proc/$foreign_pid/stat")
config_before=$(ls -A "$config")

systemd-run --unit="$collision" --uid=nobody /usr/bin/python3 -c '
import socket
server = socket.socket()
server.bind(("127.0.0.1", 27431))
server.listen()
while True:
    client, _ = server.accept()
    print("UNEXPECTED CONNECTION", flush=True)
    client.close()
'
wait_for sh -c 'ss -H -ltn "sport = :27431" | grep -q LISTEN'
collision_pid=$(pid "$collision")
if initialize > "$work/collision" 2>&1; then exit 1; fi
grep -F 'occupied by an unexpected listener' "$work/collision"
[ "$(pid "$collision")" = "$collision_pid" ]
if journalctl -u "$collision" "_PID=$collision_pid" _TRANSPORT=stdout --no-pager --output=cat |
    grep -Fx 'UNEXPECTED CONNECTION' >/dev/null; then
    echo 'The bootstrap controller connected to the foreign listener.' >&2
    exit 1
fi
[ ! -e "$journal" ]
[ ! -e "$config/mongodb-app.json" ]
[ "$(ls -A "$config")" = "$config_before" ]
[ -z "$(ls -A /var/lib/planner/mongodb)" ]
systemctl stop "$collision"

exec 8<"$config"
flock -x 8
if initialize > "$work/lock" 2>&1; then exit 1; fi
grep -F 'initialization lock is unavailable' "$work/lock"
[ ! -e "$journal" ]
[ "$(ls -A "$config")" = "$config_before" ]
flock -u 8
exec 8<&-

"$node" "$entry" "$port" > "$work/interrupted" 2>&1 &
controller=$!
wait_for test -S "$socket"
kill -STOP "$controller"
bootstrap_pid=$(pid "$temporary")
[ "$bootstrap_pid" -gt 0 ]
[ "$(stat -c '%U:%G:%a' "$(dirname "$socket")")" = planner-mongodb:planner-mongodb:700 ]
[ "$(stat -c '%U' "$socket")" = planner-mongodb ]
[ ! -e "$config/mongod.conf" ]
if ss -H -ltnp | grep -Fq "pid=$bootstrap_pid,"; then exit 1; fi
cp "$journal" "$work/journal-before"
cp "/proc/$bootstrap_pid/cmdline" "$work/bootstrap-arguments"
kill -KILL "$controller"
wait "$controller" 2>/dev/null || true
[ "$(pid "$temporary")" = "$bootstrap_pid" ]
initialize > "$work/initialized" || { cat "$work/interrupted" >&2; exit 1; }
[ "$(pid "$temporary")" = 0 ]
[ ! -S "$socket" ]
[ "$(stat -c '%U:%G:%a' "$config/mongodb-app.json")" = root:planner:640 ]
[ "$(stat -c '%U:%G:%a' "$config/mongod.conf")" = root:planner-mongodb:640 ]
[ "$(stat -c '%U:%G:%a' "$journal")" = root:root:600 ]
first_pid=$(pid "$amongo")
[ "$first_pid" -gt 0 ]
[ "$(stat -c '%U' "/proc/$first_pid")" = planner-mongodb ]
[ "$(stat -c '%U:%G:%a' /run/planner-mongodb)" = planner-mongodb:planner-mongodb:711 ]
[ "$(stat -c '%U:%G:%a' /run/planner-mongodb/mongod.sock)" = planner-mongodb:planner-mongodb:777 ]
if runuser -u nobody -- touch /run/planner-mongodb/foreign 2>/dev/null; then exit 1; fi

check_readiness

systemctl restart "$amongo"
wait_for test -S /run/planner-mongodb/mongod.sock
wait_for sh -c 'ss -H -ltn "sport = :27431" | grep -q LISTEN'
initialize > "$work/restarted"
cmp "$work/initialized" "$work/restarted"
restarted_pid=$(pid "$amongo")
[ "$restarted_pid" -gt 0 ] && [ "$restarted_pid" != "$first_pid" ]
cp "/proc/$restarted_pid/cmdline" "$work/permanent-arguments"
journalctl --no-pager --output=cat -u "$temporary" -u "$amongo" > "$work/service-logs"
python3 - "$work" <<'PY'
import json
from pathlib import Path
import sys

work = Path(sys.argv[1])
state = json.loads((work / "journal-before").read_text())
final = json.loads(Path("/etc/planner/mongodb-init.json").read_text())
assert "adminPassword" not in final and final["phase"] == "provisioned"
assert final["credentials"] == state["credentials"]
assert json.loads((work / "initialized").read_text()) == {
    "installationId": final["credentials"]["installationId"], "dbPort": 27431
}
mongo = json.loads(Path("/etc/planner/mongod.conf").read_text())
assert mongo["security"]["authorization"] == "enabled"
assert mongo["setParameter"]["enableLocalhostAuthBypass"] is False
assert b'"remote":"127.0.0.1:' not in (work / "service-logs").read_bytes()
for secret in (state["adminPassword"], state["credentials"]["password"]):
    for name in ("bootstrap-arguments", "permanent-arguments", "service-logs", "interrupted", "initialized", "restarted"):
        assert secret.encode() not in (work / name).read_bytes(), name
PY

# The live backend keeps setup gated with a correctly provisioned database and after loss of identity.
runuser -u planner -- env PLANNER_HTTP_PORT=0 "$node" "$release/apps/backend/dist/main.js" > "$work/backend" 2>&1 &
backend=$!
wait_for test -s "$work/backend"
origin=$(head -n1 "$work/backend")
health() {
    "$node" --input-type=module - "$origin" <<'JS'
import assert from 'node:assert/strict';
for (const [path, status, result] of [['live', 200, 'live'], ['ready', 503, 'unavailable']]) {
  const response = await fetch(process.argv[2] + '/health/' + path);
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['requestId', 'status', 'version']);
  assert.equal(body.status, result);
  assert.equal(body.version, '0.1.0');
}
JS
}
change_identity() {
    "$node" --input-type=module - "$release" "$1" <<'JS'
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const native = process.argv[2] + '/apps/backend/dist/native/';
const { appUsername, databaseName, mongoClient } = await import(pathToFileURL(native + 'mongo-identity.js'));
const { mongoRuntimeSocket } = await import(pathToFileURL(native + 'mongo-readiness.js'));
const expected = JSON.parse(await readFile('/etc/planner/mongodb-app.json', 'utf8'));
const client = mongoClient(encodeURIComponent(mongoRuntimeSocket), databaseName, appUsername, expected.password);
try {
  const value = process.argv[3] === 'wrong' ? randomUUID() : expected.installationId;
  await client.db(databaseName).collection('installation').updateOne({ _id: 'installation' }, { $set: { installationId: value } });
} finally { await client.close(); }
JS
}
health
change_identity wrong
check_readiness 'installation UUID does not match'
if initialize > "$work/wrong-identity" 2>&1; then exit 1; fi
grep -F 'installation UUID does not match' "$work/wrong-identity"
[ "$(pid "$amongo")" = "$restarted_pid" ]
health
change_identity restore
initialize > "$work/restored"
cmp "$work/initialized" "$work/restored"
systemctl stop "$amongo"
check_readiness 'listener has unexpected ownership or binding'
health
kill "$backend"
wait "$backend" 2>/dev/null || true
[ "$(pid "$sentinel")" = "$foreign_pid" ]
[ "$(awk '{print $22}' "/proc/$foreign_pid/stat")" = "$foreign_stat" ]
echo 'NATIVE MONGODB ACCEPTANCE PASSED'
