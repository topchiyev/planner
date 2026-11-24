#!/bin/bash
# Run as root inside a disposable Ubuntu guest with verified candidate media attached read-only.
set -euo pipefail

media=${1:?Pass the mount point of the read-only candidate ISO}
[ "$(id -u)" = 0 ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
for path in /opt/planner /etc/planner /var/lib/planner /run/planner; do [ ! -e "$path" ]; done
[ -z "$(getent passwd planner planner-mongodb || :)" ]

verify_package() {
    openssl pkeyutl -verify -rawin -pubin -inkey "$1/test-key.pub.pem" \
        -in "$1/manifest.json" -sigfile "$1/manifest.json.sig" >&2
    python3 - "$1" <<'PY'
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
}
package=$(verify_package "$media")
previous=$(verify_package "$media/previous")

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

for conflict in /etc/systemd/system/planner.service.d /run/systemd/system/planner-mongodb.service.d; do
    mkdir "$conflict"
    printf '[Service]\nEnvironment=PLANNER_TEST_FOREIGN=1\n' > "$conflict/test.conf"
    reject_install drop-in 'A local drop-in directory already occupies'
    unlink "$conflict/test.conf"
    rmdir "$conflict"
done

for base in /etc/tmpfiles.d /run/tmpfiles.d /usr/local/lib/tmpfiles.d; do
    mkdir -p "$base"
    conflict=$base/planner-workspace.conf
    ln -s /dev/null "$conflict"
    reject_install tmpfiles-mask "A local runtime directory override occupies $conflict."
    [ "$(readlink "$conflict")" = /dev/null ]
    unlink "$conflict"
done

install_planner() { PLANNER_INSTALL_APP_PORT=27530 PLANNER_INSTALL_DB_PORT=27531 dpkg -i "$package"; }
assert_units() {
    systemd-analyze verify planner.service planner-mongodb.service
    for unit in planner.service planner-mongodb.service; do
        [ "$(systemctl is-enabled "$unit" || true)" = disabled ]
        [ "$(systemctl show -p FragmentPath --value "$unit")" = "/usr/lib/systemd/system/$unit" ]
        [ "$(systemctl show -p MainPID --value "$unit")" = 0 ]
    done
    [ "$(/usr/bin/plannerctl --version)" = 0.1.0 ]
}

dpkg -i "$previous"
old_launcher=$(sha256sum /usr/bin/plannerctl)
for conflict in /usr/lib/systemd/system/planner.service /usr/lib/tmpfiles.d/planner-workspace.conf; do
    printf '# owned by the guest fixture, outside the Planner package\n' > "$conflict"
    chmod 0644 "$conflict"
    foreign=$(sha256sum "$conflict")
    if dpkg -i "$package" > "$work/refused" 2>&1; then
        echo "Upgrade unexpectedly replaced $conflict" >&2
        exit 1
    fi
    grep -F "The path $conflict is occupied outside the Planner package." "$work/refused"
    [ "$(sha256sum "$conflict")" = "$foreign" ]
    [ "$(sha256sum /usr/bin/plannerctl)" = "$old_launcher" ]
    [ ! -e /opt/planner/current/lib/native-preflight ]
    [ ! -e /etc/planner ]
    [ ! -e /var/lib/planner ]
    [ -z "$(getent passwd planner planner-mongodb || :)" ]
    unlink "$conflict"
done
install_planner
assert_units
[ -x /opt/planner/current/lib/native-preflight ]
[ -f /etc/planner/.native-installation ]
cmp /etc/planner/.native-installation /var/lib/planner/.native-installation
printf '%s\n' 'The signed prior package upgraded directly to the new units and CLI.'

# This guest started empty and only the candidate created these test identities and paths.
# Reset its synthetic installation to exercise first install independently in the same boot.
dpkg -r planner-workspace
[ ! -e /opt/planner ]
unlink /etc/planner/.native-installation
unlink /var/lib/planner/.native-installation
rmdir /etc/planner /var/lib/planner/{mongodb,blobs,staging,backups} /var/lib/planner /run/planner
for account in planner planner-mongodb; do
    userdel "$account"
    if getent group "$account" >/dev/null; then groupdel "$account"; fi
done

systemd-run --unit=planner-test-port --uid=nobody /usr/bin/python3 -m http.server 27431 --bind 127.0.0.1
for attempt in {1..50}; do
    if ss -H -ltn | grep -q ':27431 '; then break; fi
    sleep .1
done
reject_install collision 'Planner database port 27431 is occupied.'
[ ! -e /etc/planner ]
[ ! -e /var/lib/planner ]

install_planner
assert_units
systemctl start planner.service planner-mongodb.service
for unit in planner.service planner-mongodb.service; do
    [ "$(systemctl show -p MainPID --value "$unit")" = 0 ]
    [ "$(systemctl show -p ConditionResult --value "$unit")" = no ]
done

for config_file in planner.json mongod.conf; do
    case "$config_file" in planner.json) group=planner ;; mongod.conf) group=planner-mongodb ;; esac
    install -o root -g "$group" -m 0640 /dev/null "/etc/planner/$config_file"
    systemctl start planner.service
    [ "$(systemctl show -p ConditionResult --value planner.service)" = no ]
    [ "$(systemctl show -p MainPID --value planner.service planner-mongodb.service | sort -u)" = 0 ]
    unlink "/etc/planner/$config_file"
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

runuser -u nobody -- /usr/bin/plannerctl preflight --public-url https://planner.example.test \
    --app-port 27530 --db-port 27531 > "$work/human.txt"
grep -F 'passed on Ubuntu 24.04 amd64' "$work/human.txt"
grep -F 'KiB available' "$work/human.txt"
grep -F 'Ownership is valid' "$work/human.txt"
grep -F 'Readiness is unavailable' "$work/human.txt"

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
assert_units
echo 'NATIVE INSTALLATION ACCEPTANCE PASSED'
