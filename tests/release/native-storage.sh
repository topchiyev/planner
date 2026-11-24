#!/bin/bash
# Run as root in a disposable Ubuntu guest with verified candidate media attached read-only.
set -Eeuo pipefail
trap 'printf "Native storage acceptance failed on line %s.\n" "$LINENO" >&2' ERR
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
previous=$(verify_package "$media/previous")
work=$(mktemp -d /var/tmp/planner-native-storage.XXXXXX)
release=/opt/planner/current
dpkg -i "$previous"
/usr/bin/plannerctl setup --mode fresh --public-url https://planner.example.test --app-port 27530 --db-port 27531 \
    --json > "$work/setup.json"

database_fixture() {
    "$release/runtime/node/bin/node" --input-type=module - "$release" "$work" "$1" <<'JS'
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [, , release, work, action] = process.argv;
const { MongoClient, Long } = await import(pathToFileURL(`${release}/node_modules/mongodb/lib/index.js`));
const credentials = JSON.parse(await readFile('/etc/planner/mongodb-app.json', 'utf8'));
const client = new MongoClient(`mongodb://${encodeURIComponent('/run/planner-mongodb/mongod.sock')}/?directConnection=true`, {
  auth: { username: 'planner-app', password: credentials.password }, authSource: 'planner',
});
const id = 'c8fbb819-a78a-4a09-8f91-8ad08c730e7c';
const generationId = '2e91e11b-8a3d-4134-a569-6139cf555708';
const key = { _id: 'installation' };
const writeConcern = { w: 1, j: true };
try {
  const database = client.db('planner');
  const installation = database.collection('installation');
  const grants = database.collection('recoveryGrants');
  const projects = database.collection('projects');
  const expectedProject = { _id: `${generationId}/${id}`, id, generationId, revision: 3,
    name: 'Existing storage fixture', rank: Long.fromString('-9007199254740993'),
    createdAt: new Date('2026-03-19T13:13:59.719Z'), updatedAt: null };
  if (action === 'seed') {
    const stored = await installation.findOne(key);
    assert.equal(stored.schemaVersion, 0);
    const grant = await grants.findOne({ installationId: credentials.installationId });
    assert.match(grant._id, /^[0-9a-f-]{36}$/u);
    assert.equal(grant.id, undefined);
    await projects.insertOne(expectedProject, { writeConcern });
    await installation.updateOne(key, { $set: { activeGenerationId: generationId } }, { writeConcern });
    await writeFile(`${work}/legacy-grant.json`, JSON.stringify(grant), { mode: 0o600 });
  } else if (action === 'verify') {
    const stored = await installation.findOne(key);
    assert.equal(stored.activeGenerationId, generationId);
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.schemaMigration, undefined);
    assert.equal(stored.setup.pendingAction, 'first-admin-enrollment');
    assert.deepEqual(await projects.findOne({ _id: expectedProject._id }, { promoteLongs: false }), expectedProject);
    const previous = JSON.parse(await readFile(`${work}/legacy-grant.json`, 'utf8'));
    const [grant, extra] = await grants.find({}).toArray();
    assert.ok(!extra);
    assert.deepEqual(JSON.parse(JSON.stringify(grant)),
      { ...previous, id: previous._id, _id: `${previous.generationId}/${previous._id}` });
  } else if (action === 'foreign-version') {
    await installation.updateOne(key, { $set: { schemaVersion: 99 } }, { writeConcern });
  } else if (action === 'verify-foreign-version') {
    assert.equal((await installation.findOne(key)).schemaVersion, 99);
    await installation.updateOne(key, { $set: { schemaVersion: 1 } }, { writeConcern });
  } else if (action === 'enrollment-state') {
    await installation.updateOne(key, { $set: { activeGenerationId: null } }, { writeConcern });
  }
} finally { await client.close(); }
JS
}

database_fixture seed
/usr/bin/plannerctl stop
dpkg -i "$candidate"
/usr/bin/plannerctl start
/usr/bin/plannerctl storage verify --json > "$work/schema.json"
python3 - "$work/schema.json" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    assert json.load(stream) == {'schemaVersion': 1, 'activeGeneration': True}
PY
database_fixture verify

database_fixture foreign-version
if /usr/bin/plannerctl storage verify > "$work/refused" 2>&1; then
    echo 'Storage verification unexpectedly accepted a newer version.' >&2
    exit 1
fi
grep -F 'The workspace storage schema is unavailable.' "$work/refused"
status=$(curl -sS --noproxy '*' -o "$work/ready.json" -w '%{http_code}' http://127.0.0.1:27530/health/ready)
[ "$status" = 503 ]
python3 - "$work/ready.json" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    report = json.load(stream)
assert report['status'] == 'unavailable'
assert set(report) == {'status', 'version', 'requestId'}
PY
database_fixture verify-foreign-version
/usr/bin/plannerctl storage verify
database_fixture verify

database_fixture enrollment-state
/usr/bin/plannerctl setup --mode fresh --public-url https://planner.example.test --app-port 27530 --db-port 27531 \
    --json > "$work/replay.json"
curl -fsS --noproxy '*' --unix-socket /run/planner/admin.sock http://localhost/status > "$work/access.json"
python3 - "$work" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
initial = json.loads((path / 'setup.json').read_text())
replay = json.loads((path / 'replay.json').read_text())
assert initial['firstAdminGrant'] == replay['firstAdminGrant']
assert json.loads((path / 'access.json').read_text())['access'] == {'kind': 'enrollment', 'step': 'recovery'}
PY
echo 'NATIVE STORAGE UPGRADE ACCEPTANCE PASSED'
