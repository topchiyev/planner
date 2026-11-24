#!/bin/bash
# Run as root in a disposable Ubuntu guest with verified candidate media attached read-only.
set -Eeuo pipefail
trap 'printf "Native setup acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the mount point of the read-only candidate ISO}
mode=${2:?Choose fresh or import}
phase=${3:-initial}
case "$mode" in fresh|import) ;; *) exit 2 ;; esac
[ "$(id -u)" = 0 ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
[ "$(ls -1 /sys/class/net)" = lo ]
[ -z "$(ip route show default)" ]

work=/var/tmp/planner-native-setup-$mode
release=/opt/planner/current
node=$release/runtime/node/bin/node
app_port=27530
db_port=27531
origin=https://planner.example.test
intent=/etc/planner/setup-intent.json
config=/etc/planner/planner.json
setup=(/usr/bin/plannerctl setup --mode "$mode" --public-url "$origin" --app-port "$app_port" --db-port "$db_port" --json)

pid() { systemctl show -p MainPID --value "$1"; }

wait_live() {
    for attempt in {1..120}; do
        if curl -fsS --noproxy '*' "http://127.0.0.1:$app_port/health/live" > "$work/live.json"; then break; fi
        sleep .25
    done
    curl -sS --noproxy '*' -o "$work/ready.json" -w '%{http_code}' \
        "http://127.0.0.1:$app_port/health/ready" | grep -qx 503
    python3 - "$work" <<'PY'
import json
from pathlib import Path
import sys
root = Path(sys.argv[1])
for subject, status in (('live', 'live'), ('ready', 'unavailable')):
    report = json.loads((root / (subject + '.json')).read_text())
    assert set(report) == {'status', 'version', 'requestId'} and report['status'] == status, report
    assert report['version'] == '0.1.0'
PY
}

if [ "$phase" = reboot-check ]; then
    [ "$(cat "$work/boot-id")" != "$(cat /proc/sys/kernel/random/boot_id)" ]
    wait_live
    for unit in planner.service planner-mongodb.service; do
        [ "$(systemctl is-enabled "$unit")" = enabled ]
        [ "$(pid "$unit")" -gt 0 ]
    done
    sha256sum --check "$work/protected-files.sha256"
    [ "$(cat /var/lib/planner/blobs/setup-test)" = retained ]
    /usr/bin/plannerctl status --json > "$work/post-reboot.json"
    python3 - "$work/post-reboot.json" "$mode" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    report = json.load(stream)
assert report['configuration'] == 'configured' and report['mode'] == sys.argv[2], report
assert report['services'] == {'application': 'active', 'database': 'active'}, report
assert 'firstAdminGrant' not in report
PY
    echo "NATIVE OPERATOR $mode REBOOT ACCEPTANCE PASSED"
    exit 0
fi
[ "$phase" = initial ]

for path in /opt/planner /etc/planner /var/lib/planner "$work"; do [ ! -e "$path" ]; done
openssl pkeyutl -verify -rawin -pubin -inkey "$media/test-key.pub.pem" \
    -in "$media/manifest.json" -sigfile "$media/manifest.json.sig"
package=$(python3 - "$media" <<'PY'
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
)

install -d -m 0755 "$work" "$work/extracted"
dpkg-deb -x "$package" "$work/extracted"
fixture_release=$work/extracted/opt/planner/current
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin planner-test-mongo
install -d -o planner-test-mongo -g planner-test-mongo -m 0700 "$work/foreign-data"
cat > "$work/foreign.conf" <<CONFIG
storage:
  dbPath: $work/foreign-data
net:
  bindIp: 127.0.0.1
  port: 27017
  unixDomainSocket:
    enabled: false
setParameter:
  diagnosticDataCollectionEnabled: false
CONFIG
chmod 0644 "$work/foreign.conf"
systemd-run --unit=planner-test-foreign-mongo --uid=planner-test-mongo --gid=planner-test-mongo \
    "$fixture_release/runtime/mongodb/bin/mongod" --config "$work/foreign.conf" --wiredTigerCacheSizeGB 0.25
foreign_pid=$(pid planner-test-foreign-mongo.service)
foreign_start=$(awk '{print $22}' "/proc/$foreign_pid/stat")
foreign_config=$(sha256sum "$work/foreign.conf")
foreign_record() {
    "$fixture_release/runtime/node/bin/node" --input-type=module - "$fixture_release" "$1" <<'JS'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [, , release, action] = process.argv;
const { MongoClient } = await import(pathToFileURL(`${release}/node_modules/mongodb/lib/index.js`));
const client = new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true', { serverSelectionTimeoutMS: 8000 });
try {
  const records = client.db('nativeAcceptance').collection('sentinels');
  if (action === 'seed') await records.insertOne({ label: 'external', value: 2717 });
  const fixture = await records.findOne({ label: 'external' });
  assert.equal(fixture.value, 2717);
  console.log(fixture._id.toHexString());
} finally { await client.close(); }
JS
}
foreign_id=$(foreign_record seed)

dpkg -i "$package"
[[ "$(pid planner.service)" = 0 && "$(pid planner-mongodb.service)" = 0 ]]
[ "$(/usr/bin/plannerctl --version)" = 0.1.0 ]

expect_failure() {
    local diagnostic=$1
    shift
    if "$@" > "$work/refusal" 2>&1 || ! grep -F "$diagnostic" "$work/refusal"; then
        printf 'Expected refusal containing %s.\n' "$diagnostic" >&2
        cat "$work/refusal" >&2
        exit 1
    fi
}

expect_failure 'Specify an HTTPS public origin' /usr/bin/plannerctl setup --mode "$mode" --public-url http://invalid.test
expect_failure 'Choose distinct ports' /usr/bin/plannerctl setup --mode "$mode" --public-url "$origin" --app-port "$db_port" --db-port "$db_port"
expect_failure 'Complete Planner setup' /usr/bin/plannerctl start
minimum_port=$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start)
if [ "$minimum_port" -gt 1 ]; then
    privileged_port=$((minimum_port - 1))
    while [ "$privileged_port" -gt 1 ] && [ -n "$(ss -H -ltn "sport = :$privileged_port")" ]; do
        privileged_port=$((privileged_port - 1))
    done
    [ -z "$(ss -H -ltn "sport = :$privileged_port")" ]
    for role in app db; do
        rejected_app=$app_port rejected_db=$db_port
        if [ "$role" = app ]; then rejected_app=$privileged_port; else rejected_db=$privileged_port; fi
        expect_failure "Choose ports at or above $minimum_port" /usr/bin/plannerctl preflight \
            --public-url "$origin" --app-port "$rejected_app" --db-port "$rejected_db"
        expect_failure "Choose ports at or above $minimum_port" /usr/bin/plannerctl setup --mode "$mode" \
            --public-url "$origin" --app-port "$rejected_app" --db-port "$rejected_db"
    done
    [[ ! -e "$intent" && ! -e "$config" && ! -e /etc/planner/mongodb-init.json ]]
fi

ports_file=/etc/planner/native-ports
printf '%s %s\n' "$app_port" "$db_port" > "$ports_file"
foreign_ports=$(sha256sum "$ports_file")
expect_failure 'package ports do not match the setup intent' "${setup[@]}"
[ "$(sha256sum "$ports_file")" = "$foreign_ports" ]
unlink "$ports_file"
ln -s /dev/null "$ports_file"
expect_failure 'Unexpected Planner database file identity or permissions' "${setup[@]}"
[ "$(readlink "$ports_file")" = /dev/null ]
unlink "$ports_file"
[[ ! -e "$intent" && ! -e "$config" && ! -e /etc/planner/mongodb-init.json ]]
[[ "$(pid planner.service)" = 0 && "$(pid planner-mongodb.service)" = 0 ]]

for port in "$app_port" "$db_port"; do
    collision=planner-test-collision-$port.service
    systemd-run --unit="$collision" --uid=nobody /usr/bin/python3 -m http.server "$port" --bind 127.0.0.1
    for attempt in {1..50}; do
        if [ -n "$(ss -H -ltn "sport = :$port")" ]; then break; fi
        sleep .1
    done
    collision_pid=$(pid "$collision")
    if [ "$port" = "$app_port" ]; then
        expect_failure 'Planner application port' "${setup[@]}"
    else
        expect_failure 'selected Planner database port is occupied' "${setup[@]}"
    fi
    [ "$(pid "$collision")" = "$collision_pid" ]
    [[ ! -e "$intent" && ! -e "$config" && ! -e /etc/planner/mongodb-init.json ]]
    systemctl stop "$collision"
done

# Block the database bootstrap lock so the operator exits after the setup intent is durable.
exec 9</etc/planner
flock -nx 9
expect_failure 'initialization lock is unavailable' "${setup[@]}"
[ "$(stat -c '%U:%G:%a' "$intent")" = root:root:600 ]
[[ ! -e "$config" && ! -e /etc/planner/mongodb-init.json ]]
flock -u 9
exec 9<&-

python3 - "$intent" <<'PY'
import json, sys, time
from pathlib import Path
path = Path(sys.argv[1])
intent = json.loads(path.read_text())
intent['createdAt'] = int(time.time() * 1000) - 2 * 60 * 60 * 1000
assert 'expiresAt' not in intent.get('grant', {})
path.write_text(json.dumps(intent, indent=2) + '\n')
PY
sha256sum "$intent" > "$work/interrupted-intent.sha256"
printf '27430 %s\n' "$db_port" > "$ports_file"
expect_failure 'package ports do not match the setup intent' "${setup[@]}"
[[ ! -e "$config" && ! -e /etc/planner/mongodb-init.json ]]
printf '%s %s\n' "$app_port" "$db_port" > "$ports_file"
"${setup[@]}" > "$work/first.json"
sha256sum --check "$work/interrupted-intent.sha256"
wait_live
first_app=$(pid planner.service)
first_mongo=$(pid planner-mongodb.service)
"${setup[@]}" > "$work/repeated.json"
cmp "$work/first.json" "$work/repeated.json"
[[ "$(pid planner.service)" = "$first_app" && "$(pid planner-mongodb.service)" = "$first_mongo" ]]
other_mode=fresh
if [ "$mode" = fresh ]; then other_mode=import; fi
expect_failure 'originally selected mode, origin and ports' /usr/bin/plannerctl setup \
    --mode "$other_mode" --public-url "$origin" --app-port "$app_port" --db-port "$db_port"
[ "$(stat -c '%U:%G:%a' "$config")" = root:planner:640 ]
[ "$(stat -c '%U:%G:%a' /etc/planner/native-ports)" = root:root:600 ]
sha256sum "$intent" "$config" /etc/planner/native-ports /etc/planner/mongodb-app.json /etc/planner/mongod.conf \
    > "$work/protected-files.sha256"

database_setup() {
    "$node" --input-type=module - "$release" "$work/first.json" "$mode" "$1" <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [, , release, output, mode, action] = process.argv;
const { MongoClient } = await import(pathToFileURL(`${release}/node_modules/mongodb/lib/index.js`));
const credentials = JSON.parse(await readFile('/etc/planner/mongodb-app.json', 'utf8'));
const report = JSON.parse(await readFile(output, 'utf8'));
const socket = encodeURIComponent('/run/planner-mongodb/mongod.sock');
const client = new MongoClient(`mongodb://${socket}/?directConnection=true`, {
  auth: { username: 'planner-app', password: credentials.password }, authSource: 'planner',
});
try {
  const database = client.db('planner');
  const installation = database.collection('installation');
  const key = { _id: 'installation' };
  const recoveryGrants = database.collection('recoveryGrants');
  if (action === 'consume') {
    const result = await recoveryGrants.updateOne({ kind: 'first-admin', consumedAt: null },
      { $set: { consumedAt: new Date() } }, { writeConcern: { w: 1, j: true } });
    assert.equal(result.modifiedCount, 1);
  } else if (action === 'consumed') {
    const grants = await recoveryGrants.find().toArray();
    assert.equal(grants.length, 1);
    assert.equal(grants[0].tokenDigest, createHash('sha256').update(report.firstAdminGrant.token).digest('hex'));
    assert.equal(grants[0].expiresAt.toISOString(), report.firstAdminGrant.expiresAt);
    assert.ok(grants[0].consumedAt instanceof Date);
  } else if (action === 'prune-consumed') {
    const result = await recoveryGrants.deleteOne({ consumedAt: { $type: 'date' } }, { writeConcern: { w: 1, j: true } });
    assert.equal(result.deletedCount, 1);
  } else if (action === 'not-reissued') {
    assert.equal(await recoveryGrants.countDocuments(), 0);
    assert.ok((await installation.findOne(key)).setup.firstAdminGrantIssuedAt instanceof Date);
  } else if (action !== 'verify') {
    const installationId = action === 'wrong' ? 'c511939b-a51b-4af0-8e50-c2cf617c1959' : credentials.installationId;
    await installation.updateOne(key, { $set: { installationId } }, { writeConcern: { w: 1, j: true } });
  } else {
    const stored = await installation.findOne(key);
    assert.equal(stored.installationId, credentials.installationId);
    assert.equal(stored.activeGenerationId, null);
    assert.equal(stored.setup.mode, mode);
    assert.equal(report.configuration, 'configured');
    assert.equal(report.readiness, 'unavailable');
    assert.equal(report.pendingAction, stored.setup.pendingAction);
    const grants = await recoveryGrants.find().toArray();
    if (mode === 'fresh') {
      assert.equal(stored.setup.pendingAction, 'first-admin-enrollment');
      assert.equal(grants.length, 1);
      assert.equal(grants[0].generationId, stored.setup.enrollmentGenerationId);
      assert.equal(grants[0].installationId, credentials.installationId);
      assert.equal(grants[0].tokenDigest, createHash('sha256').update(report.firstAdminGrant.token).digest('hex'));
      assert.equal(grants[0].expiresAt.toISOString(), report.firstAdminGrant.expiresAt);
      assert.equal(grants[0].consumedAt, null);
      const intent = JSON.parse(await readFile('/etc/planner/setup-intent.json', 'utf8'));
      assert.equal(grants[0].expiresAt.getTime() - grants[0].issuedAt.getTime(), 30 * 60 * 1000);
      assert.ok(grants[0].issuedAt.getTime() - intent.createdAt > 60 * 60 * 1000);
      assert.equal(stored.setup.firstAdminGrantIssuedAt.getTime(), grants[0].issuedAt.getTime());
      assert.ok(grants[0].expiresAt.getTime() > Date.now());
      assert.ok(grants[0].expiresAt.getTime() - Date.now() <= 30 * 60 * 1000);
      assert.ok(!JSON.stringify(grants).includes(report.firstAdminGrant.token));
    } else {
      assert.equal(stored.setup.pendingAction, 'migration-preflight');
      assert.equal(stored.setup.enrollmentGenerationId, null);
      assert.deepEqual(grants, []);
      assert.ok(!('firstAdminGrant' in report));
    }
    assert.equal(await database.collection('sessions').countDocuments(), 0);
    assert.equal(await database.collection('importRuns').countDocuments(), 0);
  }
} finally { await client.close(); }
JS
}

database_setup verify
systemctl stop planner.service
database_setup wrong
expect_failure 'installation UUID does not match' /usr/bin/plannerctl start
[[ "$(pid planner.service)" = 0 && "$(pid planner-mongodb.service)" = "$first_mongo" ]]
database_setup restore
/usr/bin/plannerctl start
wait_live
/usr/bin/plannerctl restart
wait_live
database_setup verify

low_storage() {
    local scratch=$work/low-storage dir
    install -d -m 0700 "$scratch"
    mount -t tmpfs -o size=256m,mode=0711,nodev,nosuid tmpfs "$scratch"
    cp --preserve=mode,ownership /var/lib/planner/.native-installation "$scratch/"
    for dir in mongodb blobs staging backups; do
        mkdir "$scratch/$dir"
        mount --bind "/var/lib/planner/$dir" "$scratch/$dir"
    done
    mount --rbind "$scratch" /var/lib/planner
    [ "$(df -Pk /var/lib/planner | awk 'END {print $4}')" -lt 524288 ]
}

normal_storage() {
    local scratch=$work/low-storage dir
    for dir in mongodb blobs staging backups; do
        umount "/var/lib/planner/$dir"
        umount "$scratch/$dir"
    done
    umount /var/lib/planner
    umount "$scratch"
}

runuser -u planner -- sh -c 'printf "%s\n" retained > /var/lib/planner/blobs/setup-test'
/usr/bin/plannerctl stop
[[ "$(pid planner.service)" = 0 && "$(pid planner-mongodb.service)" = 0 ]]
expect_failure 'requested package ports differ' env PLANNER_INSTALL_APP_PORT=27430 dpkg -i "$package"
/usr/bin/plannerctl start
wait_live
low_storage
/usr/bin/plannerctl status --json > "$work/low-storage-status.json"
/usr/bin/plannerctl stop
[[ "$(pid planner.service)" = 0 && "$(pid planner-mongodb.service)" = 0 ]]
expect_failure 'At least 512 MiB must be free on the Planner state filesystem' /usr/bin/plannerctl preflight \
    --public-url "$origin" --app-port "$app_port" --db-port "$db_port"
expect_failure 'Planner native database ownership checks failed' /usr/bin/plannerctl start
normal_storage
/usr/bin/plannerctl start
wait_live
low_storage
dpkg -r planner-workspace
normal_storage
if systemctl is-active --quiet planner.service || systemctl is-active --quiet planner-mongodb.service; then
    echo 'Planner services are still active after package removal.' >&2
    exit 1
fi
if command -v plannerctl; then
    echo 'Planner CLI still exists after package removal.' >&2
    exit 1
fi
sha256sum --check "$work/protected-files.sha256"
[ "$(cat /var/lib/planner/blobs/setup-test)" = retained ]
dpkg -i "$package"
[[ "$(pid planner.service)" = 0 && "$(pid planner-mongodb.service)" = 0 ]]
/usr/bin/plannerctl start
wait_live
database_setup verify
sha256sum --check "$work/protected-files.sha256"
[ "$(cat /var/lib/planner/blobs/setup-test)" = retained ]
[ "$(pid planner-test-foreign-mongo.service)" = "$foreign_pid" ]
[ "$(awk '{print $22}' "/proc/$foreign_pid/stat")" = "$foreign_start" ]
[ "$(sha256sum "$work/foreign.conf")" = "$foreign_config" ]
[ "$(foreign_record check)" = "$foreign_id" ]
if [ "$mode" = fresh ]; then
    database_setup consume
    "${setup[@]}" > "$work/consumed.json"
    python3 - "$work/consumed.json" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    report = json.load(stream)
assert 'firstAdminGrant' not in report
PY
    database_setup consumed
    database_setup prune-consumed
    "${setup[@]}" > "$work/pruned.json"
    cmp "$work/consumed.json" "$work/pruned.json"
    database_setup not-reissued
fi
/usr/bin/plannerctl status --json > "$work/status.json"
python3 - "$work/status.json" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    report = json.load(stream)
assert 'firstAdminGrant' not in report
assert report['services'] == {'application': 'active', 'database': 'active'}, report
PY
cat /proc/sys/kernel/random/boot_id > "$work/boot-id"
echo "NATIVE OPERATOR $mode INSTALLATION ACCEPTANCE PASSED"
