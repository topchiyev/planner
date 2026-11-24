#!/bin/bash
# Run as root inside a disposable Ubuntu guest with verified candidate media attached read-only.
set -euo pipefail

media=${1:?Pass the mount point of the read-only candidate ISO}
[ "$(id -u)" = 0 ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
for path in /opt/planner /etc/planner /var/lib/planner /run/planner; do [ ! -e "$path" ]; done
[ -z "$(getent passwd planner planner-mongodb || :)" ]

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
package = root / item['filename']
with package.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256']
assert package.stat().st_size == item['size']
print(package)
PY
)

work=$(mktemp -d /var/tmp/planner-native-test.XXXXXX)
chmod 0755 "$work"
dpkg-deb -x "$package" "$work/extracted"
private_runtime=$work/extracted/opt/planner/current
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin planner-test-mongo
install -d -o planner-test-mongo -g planner-test-mongo -m 0700 "$work/mongo"
cat > "$work/sentinel.conf" <<CONFIG
storage:
  dbPath: $work/mongo
net:
  bindIp: 127.0.0.1
  port: 27017
  unixDomainSocket:
    enabled: false
setParameter:
  diagnosticDataCollectionEnabled: false
CONFIG
systemd-run --unit=planner-test-foreign-mongo --uid=planner-test-mongo --gid=planner-test-mongo \
    "$private_runtime/runtime/mongodb/bin/mongod" --config "$work/sentinel.conf" --wiredTigerCacheSizeGB 0.25
sentinel_pid=$(systemctl show -p MainPID --value planner-test-foreign-mongo)
[ "$sentinel_pid" -gt 0 ]
sentinel_time=$(awk '{print $22}' "/proc/$sentinel_pid/stat")
sentinel_config=$(sha256sum "$work/sentinel.conf")
sentinel_data() {
    "$private_runtime/runtime/node/bin/node" --input-type=module - "$private_runtime" "$1" <<'JS'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [, , release, action] = process.argv;
const { MongoClient } = await import(pathToFileURL(`${release}/node_modules/mongodb/lib/index.js`));
const mongo = new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true', { serverSelectionTimeoutMS: 8000 });
try {
  const sentinel = mongo.db('nativeAcceptance').collection('sentinels');
  if (action === 'seed') await sentinel.insertOne({ label: 'owned by the other service', value: 2717 });
  const record = await sentinel.findOne({ label: 'owned by the other service' });
  assert.equal(record.value, 2717);
  console.log(record._id.toHexString());
} finally { await mongo.close(); }
JS
}
sentinel_id=$(sentinel_data seed)

reject_install() {
    if dpkg -i "$package" > "$work/refused" 2>&1; then
        echo "Install unexpectedly succeeded for $1" >&2
        exit 1
    fi
    grep -F "$2" "$work/refused"
    for path in /opt/planner /run/planner /usr/bin/plannerctl; do [ ! -e "$path" ]; done
    [ -z "$(getent passwd planner planner-mongodb || :)" ]
}

install -d -o nobody -g nogroup -m 0700 /var/lib/planner
printf 'foreign fixture\n' > /var/lib/planner/existing
foreign=$(sha256sum /var/lib/planner/existing)
reject_install ownership 'Unexpected directory owner, mode or type at /var/lib/planner.'
[ "$(sha256sum /var/lib/planner/existing)" = "$foreign" ]
unlink /var/lib/planner/existing
rmdir /var/lib/planner
ln -s "$work" /etc/planner
reject_install symlink 'Unexpected directory owner, mode or type at /etc/planner.'
[ "$(readlink /etc/planner)" = "$work" ]
unlink /etc/planner
groupadd --system planner
reject_install identity 'System identity planner is already in use.'
groupdel planner

systemd-run --unit=planner-test-port --uid=nobody /usr/bin/python3 -m http.server 27431 --bind 127.0.0.1
for attempt in {1..50}; do
    if ss -H -ltn | grep -q ':27431 '; then break; fi
    sleep .1
done
reject_install collision 'Planner database port 27431 is occupied.'
[ ! -e /etc/planner ]
[ ! -e /var/lib/planner ]

install_planner() { PLANNER_INSTALL_APP_PORT=27530 PLANNER_INSTALL_DB_PORT=27531 dpkg -i "$package"; }
install_planner
systemctl daemon-reload
systemd-analyze verify planner.service planner-mongodb.service
for unit in planner.service planner-mongodb.service; do
    [ "$(systemctl is-enabled "$unit" || true)" = disabled ]
    [ "$(systemctl show -p MainPID --value "$unit")" = 0 ]
done
systemctl start planner.service planner-mongodb.service
for unit in planner.service planner-mongodb.service; do
    [ "$(systemctl show -p MainPID --value "$unit")" = 0 ]
    [ "$(systemctl show -p ConditionResult --value "$unit")" = no ]
done

for account in planner planner-mongodb; do
    [ "$(getent passwd "$account" | cut -d: -f7)" = /usr/sbin/nologin ]
    [ "$(id -G "$account")" = "$(getent group "$account" | cut -d: -f3)" ]
done
[ "$(stat -c '%U:%G:%a' /etc/planner /var/lib/planner | sort -u)" = root:root:711 ]
[ "$(stat -c '%U:%G:%a' /var/lib/planner/mongodb)" = planner-mongodb:planner-mongodb:700 ]
[ "$(stat -c '%U:%G:%a' /var/lib/planner/{blobs,staging,backups} | sort -u)" = planner:planner:700 ]
[ "$(stat -c '%U:%G:%a' /run/planner)" = planner:planner:750 ]
[ "$(stat -c '%U:%G:%a' /opt/planner/releases/0.1.0)" = root:root:755 ]
[ "$(/usr/bin/plannerctl --version)" = 0.1.0 ]

if runuser -u nobody -- /usr/bin/plannerctl preflight --public-url https://planner.example.test --json > "$work/default.json"; then
    echo 'Default preflight should report the foreign listener.' >&2
    exit 1
fi
runuser -u nobody -- /usr/bin/plannerctl preflight --public-url https://planner.example.test \
    --app-port 27530 --db-port 27531 --json > "$work/alternate.json"
python3 - "$work" <<'PY'
import json
from pathlib import Path
import sys
root = Path(sys.argv[1])
failed = json.loads((root / 'default.json').read_text())
assert not failed['ok'] and failed['failure'] == 'port' and failed['ports']['database']['state'] == 'busy', failed
passed = json.loads((root / 'alternate.json').read_text())
assert passed['ok'] and passed['installation'] == 'managed' and passed['ownership'] == 'valid', passed
assert passed['runtime'] == {'configuration': 'unconfigured', 'readiness': 'unavailable'}, passed
assert passed['ports']['application']['port'] == 27530 and passed['ports']['database']['port'] == 27531
print('Read-only CLI preflight classified the default collision and passed on alternate ports.')
PY

receipt=$(sha256sum /etc/planner/.native-installation /var/lib/planner/.native-installation)
users=$(getent passwd planner planner-mongodb)
runuser -u planner -- sh -c 'printf "%s\n" retained > /var/lib/planner/blobs/fixture'
install_planner
[ "$(sha256sum /etc/planner/.native-installation /var/lib/planner/.native-installation)" = "$receipt" ]
[ "$(getent passwd planner planner-mongodb)" = "$users" ]
[ "$(cat /var/lib/planner/blobs/fixture)" = retained ]
[ "$(systemctl show -p MainPID --value planner-test-foreign-mongo)" = "$sentinel_pid" ]
[ "$(awk '{print $22}' "/proc/$sentinel_pid/stat")" = "$sentinel_time" ]
[ "$(sha256sum "$work/sentinel.conf")" = "$sentinel_config" ]
[ "$(sentinel_data check)" = "$sentinel_id" ]
[ "$(systemctl show -p MainPID --value planner.service planner-mongodb.service | sort -u)" = 0 ]
echo 'NATIVE INSTALLATION ACCEPTANCE PASSED'
