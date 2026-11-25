#!/bin/bash
# Run in a disposable Ubuntu guest with verified candidate and synthetic inputs mounted read-only.
set -Eeuo pipefail
trap 'printf "Native migration acceptance failed at line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the read-only qualification media mount point}
administrator_recovery=${2:-}
[ -z "$administrator_recovery" ] || [ "$administrator_recovery" = --administrator-recovery ] || [ "$administrator_recovery" = --cutover ]
[ "$(id -u)" = 0 ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
[ "$(ls -1 /sys/class/net)" = lo ]
[ -z "$(ip route show default)" ]
for path in /opt/planner /etc/planner /var/lib/planner; do [ ! -e "$path" ]; done

openssl pkeyutl -verify -rawin -pubin -inkey "$media/test-key.pub.pem" \
    -in "$media/manifest.json" -sigfile "$media/manifest.json.sig" >&2
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
(cd "$media/pillow" && sha256sum --check --quiet ../noble-media-closure.sha256)
(cd "$media" && sha256sum --check --quiet postgresql-runtime.sha256)
dpkg -i "$media"/pillow/*.deb
dpkg -i "$package"

work=$(mktemp -d /root/planner-migration-qualification.XXXXXX)
pgroot=/var/lib/planner-source-fixture
pgbin="$pgroot/runtime/usr/lib/postgresql/17/bin"
pglib="$pgroot/runtime/usr/lib/x86_64-linux-gnu"
socket="$pgroot/socket"
port=55432
node=/opt/planner/current/runtime/node/bin/node
object_pid=
mounted=0
cleanup() {
    if [ "$mounted" = 1 ]; then umount /var/lib/planner/staging; fi
    if [ -n "$object_pid" ]; then kill "$object_pid" 2>/dev/null || true; wait "$object_pid" 2>/dev/null || true; fi
    if [ -x "$pgbin/pg_ctl" ] && [ -f "$pgroot/db/postmaster.pid" ]; then
        runuser -u planka-fixture -- env LD_LIBRARY_PATH="$pglib" "$pgbin/pg_ctl" -D "$pgroot/db" -m fast stop >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT
install -d -m 0711 "$pgroot"
install -d -m 0755 "$pgroot/runtime"
(umask 022; tar -xf "$media/postgresql-runtime.tar.gz" -C "$pgroot/runtime")
useradd --system --no-create-home --shell /usr/sbin/nologin planka-fixture
install -d -m 0700 -o planka-fixture -g planka-fixture "$socket" "$pgroot/db"
as_postgres() { runuser -u planka-fixture -- env LD_LIBRARY_PATH="$pglib" "$@"; }
if ! as_postgres "$pgbin/initdb" -D "$pgroot/db" -U fixture_owner --auth-local=trust --auth-host=reject \
    --no-instructions --encoding=UTF8 --locale=C >"$work/initdb.log" 2>&1; then
    cat "$work/initdb.log" >&2
    exit 1
fi
if ! as_postgres "$pgbin/pg_ctl" -D "$pgroot/db" -l "$pgroot/db/server.log" -w \
    -o "-c listen_addresses= -c unix_socket_directories=$socket -c unix_socket_permissions=0700 -p $port" start >"$work/pg-start.log" 2>&1; then
    cat "$work/pg-start.log" "$pgroot/db/server.log" >&2
    exit 1
fi
sql() {
    local db=$1
    shift
    env -u PGHOST -u PGUSER -u PGDATABASE -u PGPORT LD_LIBRARY_PATH="$pglib" \
        "$pgbin/psql" -XqAt -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U fixture_owner -d "$db" "$@"
}
sql postgres -c 'CREATE ROLE fixture_reader LOGIN NOINHERIT'
plannerctl setup --mode import --public-url https://planner.example.test --app-port 27530 --db-port 27531 --json >"$work/setup.json"
[ "$(curl -fsS http://127.0.0.1:27530/health/live | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" = live ]
test_readiness() {
    [ "$(curl --noproxy '*' -sS -o "$work/ready.json" -w '%{http_code}' http://127.0.0.1:27530/health/ready)" = 503 ]
    plannerctl storage verify --json | python3 -c 'import json,sys; assert not json.load(sys.stdin)["activeGeneration"]'
}
test_readiness
mkdir "$work/processed"

preflight_directory() {
    plannerctl migration preflight --manifest "$1/manifest.json" --source-service "$2" --assets-root "$1/assets" --json
}
refuses() {
    local fault=$1
    shift
    if "$@" >"$work/unexpected.json" 2>"$work/refusal.json"; then
        printf 'Unexpectedly accepted a fixture expected to fail with %s.\n' "$fault" >&2
        exit 1
    fi
    python3 - "$work/refusal.json" "$fault" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    result = json.load(stream)
assert result['fault'] == sys.argv[2], result
PY
}
check_receipt() {
    python3 - "$1" "$2" <<'PY'
import json, sys
from pathlib import Path
result = json.loads(Path(sys.argv[1]).read_text())
assert result['sourceRelease'] == sys.argv[2]
assert result['sourceEdition'] == 'community'
assert result['capturePostgresVersion'] == '17.12'
assert result['restoredPostgresVersion'].startswith('17.')
assert len(result['rows']) == 34 and result['rows']['migration'] == '23'
assert result['assets'] == {'present': 9, 'missingOriginals': 0, 'missingDerivatives': 0}
assert result['eligibleUnderDefaultPolicy'] and result['state'] == 'preflighted'
receipt = Path('/var/lib/planner/migration') / (result['runId'] + '.json')
assert receipt.stat().st_mode & 0o777 == 0o600
saved = json.loads(receipt.read_text())
assert saved['manifestSha256'] == result['manifestSha256'] and saved['assets'] == result['assets']
assert 'password' not in receipt.read_text()
assert len(result['fingerprintSha256']) == 64 and result['fingerprintSha256'] == saved['fingerprint']['sha256']
assert saved['fingerprint']['version'] == 1
assert set(saved['fingerprint']['components']) == {'manifest', 'catalog', 'ledger', 'rows', 'assets'}
assert len(saved['checkpointKey']) == 43 and 'checkpointKey' not in result
PY
    local run_id fingerprint
    read -r run_id fingerprint < <(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v["runId"], v["fingerprintSha256"])' "$1")
    runuser -u planner -- "$node" --input-type=module - "$run_id" "$fingerprint" <<'JS'
import assert from 'node:assert/strict';
const { connectConfiguredNativeMongo } = await import('file:///opt/planner/current/apps/backend/dist/native/mongo-readiness.js');
const { databaseName } = await import('file:///opt/planner/current/apps/backend/dist/native/mongo-identity.js');
const client = await connectConfiguredNativeMongo();
try {
    const db = client.db(databaseName);
    const run = await db.collection('importRuns').findOne({ id: process.argv[2] });
    assert.ok(run);
    assert.equal(run.state, 'preflighted');
    assert.equal(run.checkpoint, null);
    assert.equal(run._id, run.generationId + '/' + run.id);
    assert.equal(run.fingerprint.sha256, process.argv[3]);
    assert.equal(Object.hasOwn(run, 'checkpointKey'), false);
    assert.equal(Object.hasOwn(run, 'inputs'), false);
    assert.equal((await db.collection('installation').findOne({ _id: 'installation' })).activeGenerationId, null);
} finally { await client.close(); }
JS
}

kill_staging_with_application_stopped() {
    local run_id=$1 blocker held operator
    sql "$db" -c 'BEGIN; LOCK TABLE public.user_account IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(30); ROLLBACK' >"$work/stage-lock.log" 2>&1 &
    blocker=$!
    for _ in {1..100}; do
        held=$(sql "$db" -c "SELECT pid FROM pg_locks WHERE relation='public.user_account'::regclass AND mode='AccessExclusiveLock' AND granted")
        if [ -n "$held" ]; then break; fi
        sleep .02
    done
    [[ "$held" =~ ^[0-9]+$ ]]
    setsid plannerctl migration stage --run "$run_id" --format json >"$work/killed-stage.json" 2>&1 &
    operator=$!
    for _ in {1..250}; do
        if [ -s /var/lib/planner/migration/application-resume.json ] && ! systemctl is-active --quiet planner.service; then
            kill -KILL -- "-$operator"
            break
        fi
        kill -0 "$operator"
        sleep .02
    done
    if wait "$operator"; then
        echo 'Staging completed before its application-recovery interruption.' >&2
        exit 1
    fi
    sql "$db" -c "SELECT pg_terminate_backend($held)" >/dev/null
    wait "$blocker" || true
    [ -s /var/lib/planner/migration/application-resume.json ]
    ! systemctl is-active --quiet planner.service
    plannerctl migration status --run "$run_id" --format json >"$work/after-kill-status.json"
    ! systemctl is-active --quiet planner.service
    [ -s /var/lib/planner/migration/application-resume.json ]
}

check_stage() {
    local receipt=$1 post=$2 run_id
    run_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runId"])' "$receipt")
    plannerctl migration status --run "$run_id" --format json >"$work/staging-before-$post.json"
    python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["state"]=="preflighted" and v["checkpoint"] is None and not v["stageComplete"]' "$work/staging-before-$post.json"
    if [ "$post" = 230 ]; then
        kill_staging_with_application_stopped "$run_id"
        plannerctl migration resume --run "$run_id" --format json >"$work/staged-$post.json"
        [ ! -e /var/lib/planner/migration/application-resume.json ]
        systemctl is-active --quiet planner.service
        [ "$(systemctl is-enabled planner.service)" = disabled ]
        printf 'Killed stage resumed and restored the disabled-but-running application.\n'
    else
        plannerctl migration stage --run "$run_id" --format json >"$work/staged-$post.json"
    fi
    plannerctl migration resume --run "$run_id" --format json >"$work/resumed-$post.json"
    plannerctl migration status --run "$run_id" --format json >"$work/staging-after-$post.json"
    cmp "$work/staged-$post.json" "$work/resumed-$post.json"
    cmp "$work/staged-$post.json" "$work/staging-after-$post.json"
    python3 - "$work/staged-$post.json" "$receipt" <<'PY2'
import json, sys
with open(sys.argv[1]) as f: stage = json.load(f)
with open(sys.argv[2]) as f: receipt = json.load(f)
assert stage['stageComplete'] and stage['state'] == 'staging'
assert stage['checkpoint'] == {'pass': 'media', 'table': 'user_account', 'lastSourceId': '105'}
assert all(stage[field] == receipt[field] for field in ('runId', 'manifestSha256', 'fingerprintSha256'))
assert 'token' not in stage['checkpoint'] and 'checkpointKey' not in stage
PY2
    test_readiness
}

for release in 2.3.0 2.3.1; do
    suffix=${release//./}
    db="planka_frozen_$suffix"
    stage="$work/input-$suffix"
    mkdir "$stage"
    cp "$media/planka/$release/"{manifest.json,asset-manifest.json} "$stage/"
    cp -R "$media/planka/$release/assets" "$stage/"
    chmod -R go-rwx "$stage"
    "$node" "$media/planka/snapshot.mjs" "$release" >"$stage/source.sql"
    dump_name=source.sql
    if [ "$release" = 2.3.0 ]; then
        sql postgres -c 'CREATE DATABASE planka_custom_seed'
        sql planka_custom_seed <"$stage/source.sql"
        env LD_LIBRARY_PATH="$pglib" "$pgbin/pg_dump" -h "$socket" -p "$port" -U fixture_owner \
            --format=custom --no-owner --no-acl --file="$stage/source.dump" planka_custom_seed
        dump_name=source.dump
        python3 - "$stage" <<'PY2'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
manifest = root / 'manifest.json'
capture = json.loads(manifest.read_text())
with (root / 'source.dump').open('rb') as stream:
    capture['source']['dumpSha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
manifest.write_text(json.dumps(capture))
PY2
    fi
    tar --format=posix -C "$stage" -czf "$work/capture-$suffix.tar.gz" manifest.json asset-manifest.json "$dump_name" assets
    old_archive=$(sha256sum "$work/capture-$suffix.tar.gz")
    plannerctl migration prepare --archive "$work/capture-$suffix.tar.gz" --work-dir "$work/processed" --json >"$work/prepared-$suffix.json"
    [ "$(sha256sum "$work/capture-$suffix.tar.gz")" = "$old_archive" ]
    prepared=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["directory"])' "$work/prepared-$suffix.json")
    sql postgres -c "CREATE DATABASE $db"
    if [ "$dump_name" = source.dump ]; then
        env LD_LIBRARY_PATH="$pglib" "$pgbin/pg_restore" -h "$socket" -p "$port" -U fixture_owner \
            --exit-on-error --no-owner --no-acl -d "$db" "$prepared/source.dump"
    else
        sql "$db" <"$prepared/source.sql"
    fi
    sql "$db" -c "REVOKE TEMPORARY ON DATABASE $db FROM PUBLIC"
    if [ "$release" = 2.3.0 ]; then
        "$node" --input-type=module - <<'JS' | sql "$db"
import { sourceColumns } from '/opt/planner/current/apps/backend/dist/application/migration/source-catalog.js';
for (const [table, columns] of Object.entries(sourceColumns)) {
  const grant = columns.map((column) => '"' + column + '"').join(',');
  console.log('GRANT SELECT (' + grant + ') ON TABLE public."' + table + '" TO fixture_reader;');
}
JS
        [ "$(sql "$db" -c "SELECT pg_catalog.has_column_privilege('fixture_reader','public.user_account','password','SELECT')")" = f ]
        [ "$(sql "$db" -c "SELECT pg_catalog.has_column_privilege('fixture_reader','public.session','access_token','SELECT')")" = f ]
    else
        sql "$db" -c 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO fixture_reader'
    fi
    printf '[source-%s]\nisolated=true\nhost=%s\nport=%s\ndbname=%s\nuser=fixture_reader\n' \
        "$suffix" "$socket" "$port" "$db" >>/etc/planner/migration-pg.services
    if [ "$release" = 2.3.0 ]; then
        systemctl disable planner.service
        systemctl is-active --quiet planner.service
        [ "$(systemctl is-enabled planner.service)" = disabled ]
        systemctl is-enabled --quiet planner-mongodb.service
    fi
    PGHOST=/unused PGSERVICE=ignored PGDATABASE=postgres PGUSER=ignored PGOPTIONS='-c transaction_read_only=off' \
        preflight_directory "$prepared" "source-$suffix" >"$work/accepted-$suffix.json"
    check_receipt "$work/accepted-$suffix.json" "$release"
    if [ "$release" = 2.3.1 ]; then
        preflight_directory "$prepared" "source-$suffix" >"$work/replayed-$suffix.json"
        cmp "$work/accepted-$suffix.json" "$work/replayed-$suffix.json"
    fi
    [ "$(sql "$db" -c 'SELECT count(*) FROM public.card')" = 6 ]
    test_readiness
    check_stage "$work/accepted-$suffix.json" "$suffix"
    if [ "$release" = 2.3.0 ]; then
        systemctl is-active --quiet planner.service
        [ "$(systemctl is-enabled planner.service)" = disabled ]
        systemctl is-enabled --quiet planner-mongodb.service
        systemctl stop planner.service
        run_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runId"])' "$work/accepted-$suffix.json")
        plannerctl migration resume --run "$run_id" --format json >"$work/deliberately-stopped.json"
        ! systemctl is-active --quiet planner.service
        [ ! -e /var/lib/planner/migration/application-resume.json ]
        systemctl start planner.service
        systemctl enable planner.service
        printf 'Disabled-but-running application retained its service enablement.\n'
    fi
    printf 'Packaged Community %s preflight and inactive staging verified.\n' "$release"
done

source_service=source-231
sql "$db" -c 'GRANT UPDATE(name) ON public.board TO fixture_reader'
refuses source-role preflight_directory "$prepared" "$source_service"
sql "$db" -c 'REVOKE UPDATE(name) ON public.board FROM fixture_reader'
sql "$db" -c 'REVOKE SELECT ON public.card FROM fixture_reader; GRANT SELECT(id) ON public.card TO fixture_reader'
refuses source-role preflight_directory "$prepared" "$source_service"
sql "$db" -c 'REVOKE SELECT(id) ON public.card FROM fixture_reader; GRANT SELECT ON public.card TO fixture_reader'
sql "$db" -c 'ALTER TABLE public.board ADD COLUMN unsupported text'
refuses source-catalog preflight_directory "$prepared" "$source_service"
sql "$db" -c 'ALTER TABLE public.board DROP COLUMN unsupported'

cp "$prepared/manifest.json" "$work/supported.json"
python3 - "$prepared/manifest.json" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
value = json.loads(path.read_text())
value['source']['edition'] = 'business'
path.write_text(json.dumps(value))
PY
refuses source-edition preflight_directory "$prepared" "$source_service"
cp "$work/supported.json" "$prepared/manifest.json"

key='private/attachments/9007199254741221/Fixture Deck.txt'
cp "$prepared/assets/$key" "$work/original"
printf 'corrupt synthetic content\n' >"$prepared/assets/$key"
refuses asset-integrity preflight_directory "$prepared" "$source_service"
rm "$prepared/assets/$key"
preflight_directory "$prepared" "$source_service" >"$work/missing.json"
python3 -c 'import json,sys; x=json.load(open(sys.argv[1])); assert not x["eligibleUnderDefaultPolicy"] and x["assets"]["missingOriginals"]==1' "$work/missing.json"
cp "$work/original" "$prepared/assets/$key"

mount -t tmpfs -o "size=8m,uid=$(id -u planner),gid=$(id -g planner),mode=0700" tmpfs /var/lib/planner/staging
mounted=1
refuses target-capacity preflight_directory "$prepared" "$source_service"
umount /var/lib/planner/staging
mounted=0

python3 - "$work/traversal.tar" <<'PY'
import io, sys, tarfile
with tarfile.open(sys.argv[1], 'w', format=tarfile.PAX_FORMAT) as archive:
    member=tarfile.TarInfo('assets/../escape')
    member.size=1
    archive.addfile(member, io.BytesIO(b'x'))
PY
refuses asset-key plannerctl migration prepare --archive "$work/traversal.tar" --work-dir "$work/processed" --json
[ ! -e "$work/escape" ]

python3 - "$work/aliases.tar" <<'PY2'
import io, sys, tarfile
with tarfile.open(sys.argv[1], 'w', format=tarfile.PAX_FORMAT) as archive:
    for name in ('Exact.txt', 'exact.txt'):
        member=tarfile.TarInfo('assets/private/attachments/1/' + name)
        member.size=1
        archive.addfile(member, io.BytesIO(b'x'))
PY2
refuses asset-key plannerctl migration prepare --archive "$work/aliases.tar" --work-dir "$work/processed" --json

mkdir "$work/interrupt-input"
cp -R "$prepared/." "$work/interrupt-input/"
python3 - "$work/interrupt-input" <<'PY2'
import hashlib, json, sys
from pathlib import Path
data = Path(sys.argv[1])
with (data / 'source.sql').open('wb') as stream:
    for _ in range(64):
        stream.write(b'a' * 1024 * 1024)
capture = json.loads((data / 'manifest.json').read_text())
with (data / 'source.sql').open('rb') as stream:
    capture['source']['dumpSha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
(data / 'manifest.json').write_text(json.dumps(capture))
PY2
tar --format=posix -C "$work/interrupt-input" -cf "$work/interrupted.tar" manifest.json asset-manifest.json source.sql assets
published_before=$(find "$work/processed" -maxdepth 1 -name 'capture-*' | wc -l)
setsid plannerctl migration prepare --archive "$work/interrupted.tar" --work-dir "$work/processed" --json >"$work/interrupted.json" 2>&1 &
prepare_pid=$!
captured_stage=0
for attempt in {1..1000}; do
    if compgen -G "$work/processed/.capture-*" >/dev/null; then
        captured_stage=1
        kill -TERM -- "-$prepare_pid"
        break
    fi
    if ! kill -0 "$prepare_pid" 2>/dev/null; then break; fi
    sleep .005
done
if wait "$prepare_pid"; then
    echo 'Preparation unexpectedly finished before cancellation.' >&2
    exit 1
fi
[ "$captured_stage" = 1 ]
for attempt in {1..200}; do
    if ! compgen -G "$work/processed/.capture-*" >/dev/null; then break; fi
    sleep .01
done
! compgen -G "$work/processed/.capture-*" >/dev/null
[ "$(find "$work/processed" -maxdepth 1 -name 'capture-*' | wc -l)" = "$published_before" ]

mkdir "$work/object"
cp "$prepared/"{manifest.json,asset-manifest.json,source.sql} "$work/object/"
PLANNER_OBJECT_FIXTURE_PREPARE=1 "$node" "$media/native-migration-object.mjs" "$work/object" "$prepared/assets" "$work"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 \
    -keyout "$work/certificate-key.pem" -out "$work/certificate.pem" >"$work/cert.log" 2>&1
printf 'exact\n' >"$work/version-mode"
"$node" "$media/native-migration-object.mjs" "$work/object" "$prepared/assets" "$work" >"$work/snapshot-server.log" 2>&1 &
object_pid=$!
for count in {1..100}; do if [ -s "$work/object-port" ]; then break; fi; sleep .1; done
python3 - "$work" >/etc/planner/migration-assets.json <<'PY'
import json, sys
from pathlib import Path
work=Path(sys.argv[1])
capture=json.loads((work/'object/manifest.json').read_text())
print(json.dumps({'objects':{'base':'https://127.0.0.1:'+ (work/'object-port').read_text() + '/frozen/', 'snapshotId':capture['asset']['snapshotId']}}))
PY
preflight_objects() {
    NODE_EXTRA_CA_CERTS="$work/certificate.pem" plannerctl migration preflight --manifest "$work/object/manifest.json" \
        --source-service "$source_service" --asset-service objects --json
}
preflight_objects >"$work/object.json"
check_receipt "$work/object.json" 2.3.1
printf 'mismatch\n' >"$work/version-mode"
refuses asset-integrity preflight_objects
printf 'exact\n' >"$work/version-mode"
export NODE_EXTRA_CA_CERTS="$work/certificate.pem"
check_stage "$work/object.json" objects
run_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runId"])' "$work/object.json")
cp "$work/object/manifest.json" "$work/object-manifest-exact.json"
printf '\n' >>"$work/object/manifest.json"
refuses source-changed plannerctl migration resume --run "$run_id" --format json
plannerctl migration status --run "$run_id" --format json >"$work/staging-after-drift.json"
cmp "$work/staged-objects.json" "$work/staging-after-drift.json"
cp "$work/object-manifest-exact.json" "$work/object/manifest.json"
systemctl disable planner.service
systemctl is-active --quiet planner.service
plannerctl migration verify --run "$run_id" --format json >"$work/verified-objects.json"
systemctl is-active --quiet planner.service
[ "$(systemctl is-enabled planner.service)" = disabled ]
systemctl is-enabled --quiet planner-mongodb.service
systemctl enable planner.service
python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["outcome"]=="verified" and v["eligibleUnderDefaultPolicy"]' "$work/verified-objects.json"
! runuser -u planner -- test -r "$prepared/manifest.json"
while read -r blob; do
    [ "$(stat -c '%U:%G:%a' "$blob")" = planner:planner:400 ]
done < <(find /var/lib/planner/blobs -maxdepth 1 -type f)
[ -n "$(find /var/lib/planner/blobs -maxdepth 1 -type f -print -quit)" ]
test_readiness
[ "$(sql "$db" -c 'SELECT count(*) FROM public.card')" = 6 ]
printf 'NATIVE MIGRATION PREFLIGHT ACCEPTANCE PASSED\n'
printf 'NATIVE MIGRATION STAGING ACCEPTANCE PASSED\n'
if [ "$administrator_recovery" = --administrator-recovery ]; then
    bash "$media/native-migration-admin.sh" "$media" "$run_id"
fi

if [ "$administrator_recovery" = --cutover ]; then
    bash "$media/native-migration-admin.sh" "$media" "$run_id" rollback
    second_run=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runId"])' "$work/accepted-231.json")
    plannerctl migration verify --run "$second_run" --format json > "$work/verified-local-cutover.json"
    bash "$media/native-migration-admin.sh" "$media" "$second_run" writable

    export_root=/root/planner-cutover-restore
    restore_sha=$(cat "$export_root/manifest.sha256")
    plannerctl stop >"$work/stopped-before-replacement"
    mkdir "$work/pre-restore"
    mv /etc/planner "$work/pre-restore/config"
    mv /var/lib/planner "$work/pre-restore/state"
    install -d -m 0711 /etc/planner /var/lib/planner
    install -m 0644 "$work/pre-restore/config/.native-installation" /etc/planner/.native-installation
    install -m 0644 "$work/pre-restore/state/.native-installation" /var/lib/planner/.native-installation
    dpkg -i "$package"
    [ ! -e /var/lib/planner/migration ]
    plannerctl backup restore --archive "$export_root/snapshot" --expect-manifest "$restore_sha" \
        --public-url https://planner.example.test --app-port 27530 --db-port 27531 --json >"$work/restore-staged.json"
    plannerctl backup activate --expect-manifest "$restore_sha" --yes --json >"$work/restore-active.json"
    [ ! -e /var/lib/planner/migration ]
    plannerctl migration enable-writes --run "$second_run" --format json >"$work/restore-writable.json"
    [ "$(stat -c '%U:%G:%a' /var/lib/planner/migration)" = root:root:700 ]
    [ ! -e /var/lib/planner/migration/application-resume.json ]
    plannerctl migration enable-writes --run "$second_run" --format json >"$work/restore-writable-retry.json"
    cmp "$work/restore-writable.json" "$work/restore-writable-retry.json"
    python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["state"]=="writable" and not v["firstWriteFenced"]' "$work/restore-writable.json"
    previous_generation=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["generationId"])' "$work/restore-active.json")
    refuses target-setup plannerctl migration rollback --expect-generation "$previous_generation" --format json
    printf 'NATIVE MIGRATION CLEAN BACKUP RESTORE ENABLE-WRITES PASSED\n'
    printf 'NATIVE MIGRATION CUTOVER ACCEPTANCE PASSED\n'
fi
