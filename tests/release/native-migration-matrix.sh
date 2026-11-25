#!/bin/bash
# Qualify one synthetic matrix cell in a freshly installed, offline system.
set -Eeuo pipefail
trap 'printf "Native migration matrix failed at line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the read-only qualification media mount point}
release=${2:?Pass the source release}
scenario=${3:?Pass the matrix scenario}
case "$release/$scenario" in
    2.3.0/clean|2.3.1/inconsistent) backend=directory ;;
    2.3.0/inconsistent|2.3.1/clean) backend=object ;;
    *) exit 2 ;;
esac
[ "$(id -u)" = 0 ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'
[ "$(ls /sys/class/net)" = lo ]
[ -z "$(ip route show default)" ]
for path in /opt/planner /etc/planner /var/lib/planner; do [ ! -e "$path" ]; done

openssl pkeyutl -verify -rawin -pubin -inkey "$media/test-key.pub.pem" \
    -in "$media/manifest.json" -sigfile "$media/manifest.json.sig"
package=$(python3 - "$media" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
item = json.loads((root / 'manifest.json').read_text())['package']
assert item['name'] == 'planner-workspace' and item['architecture'] == 'amd64'
assert item['filename'] == 'planner-workspace_0.1.0_amd64.deb'
path = root / item['filename']
with path.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256']
assert path.stat().st_size == item['size']
print(path)
PY
)
(cd "$media/pillow" && sha256sum --check --quiet ../noble-media-closure.sha256)
(cd "$media" && sha256sum --check --quiet postgresql-runtime.sha256)
dpkg -i "$media"/pillow/*.deb
dpkg -i "$package"

work=$(mktemp -d /root/planner-migration-matrix.XXXXXX)
pgroot=/var/lib/planner-source-fixture
pgbin="$pgroot/runtime/usr/lib/postgresql/17/bin"
pglib="$pgroot/runtime/usr/lib/x86_64-linux-gnu"
socket="$pgroot/socket"
port=55432
node=/opt/planner/current/runtime/node/bin/node
oracle="$media/planka/matrix-oracle.mjs"
object_pid=
as_pg() { runuser -u planka-fixture -- env LD_LIBRARY_PATH="$pglib" "$@"; }
cleanup() {
    if [ -n "$object_pid" ]; then kill "$object_pid" 2>/dev/null || true; wait "$object_pid" 2>/dev/null || true; fi
    if [ -f "$pgroot/db/postmaster.pid" ]; then as_pg "$pgbin/pg_ctl" -D "$pgroot/db" -m fast stop >/dev/null; fi
}
trap cleanup EXIT
install -d -m 0711 "$pgroot"
install -d -m 0755 "$pgroot/runtime"
(umask 022; tar -xf "$media/postgresql-runtime.tar.gz" -C "$pgroot/runtime")
useradd --system --no-create-home --shell /usr/sbin/nologin planka-fixture
install -d -m 0700 -o planka-fixture -g planka-fixture "$socket" "$pgroot/db"
as_pg "$pgbin/initdb" -D "$pgroot/db" -U fixture_owner --auth-local=trust --auth-host=reject \
    --no-instructions --encoding=UTF8 --locale=C >"$work/initdb.log"
as_pg "$pgbin/pg_ctl" -D "$pgroot/db" -l "$pgroot/db/server.log" -w \
    -o "-c listen_addresses= -c unix_socket_directories=$socket -c unix_socket_permissions=0700 -p $port" start >"$work/pg-start.log"
pg() {
    local tool=$1
    shift
    env -u PGHOST -u PGUSER -u PGDATABASE -u PGPORT LD_LIBRARY_PATH="$pglib" \
        "$pgbin/$tool" -h "$socket" -p "$port" -U fixture_owner "$@"
}
sql() {
    local database=$1
    shift
    pg psql -d "$database" -XqAt -v ON_ERROR_STOP=1 "$@"
}
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
refuses() {
    local fault=$1
    shift
    if "$@" >"$work/unexpected.json" 2>"$work/refusal.json"; then
        printf 'Expected refusal %s.\n' "$fault" >&2
        exit 1
    fi
    [ "$(field "$work/refusal.json" fault)" = "$fault" ] || { cat "$work/refusal.json" >&2; return 1; }
}
cold() {
    [ "$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:27530/health/ready)" = 503 ]
    plannerctl storage verify --json | python3 -c 'import json,sys; assert not json.load(sys.stdin)["activeGeneration"]'
}
source_digest() {
    pg pg_dump --data-only --no-owner --no-acl --restrict-key=PlannerMatrix "$1" | sha256sum
}

sql postgres -c 'CREATE ROLE fixture_reader LOGIN NOINHERIT'
plannerctl setup --mode import --public-url https://planner.example.test --app-port 27530 --db-port 27531 --json >"$work/setup.json"
cold
mkdir "$work/processed"
image_key=$("$node" "$oracle" image-key)
text_key=$("$node" "$oracle" text-key)
archive=
archive_digest=
db=
before=
run_id=
qualify() {
    local variant=$1 asset_kind=$2 input="$work/input-$1" receipt="$work/$1"
    mkdir "$input" "$receipt"
    cp "$media/planka/$release/"{manifest.json,asset-manifest.json} "$input/"
    cp -R "$media/planka/$release/assets" "$input/"
    chmod -R go-rwx "$input"
    "$node" "$media/planka/snapshot.mjs" "$release" "$variant" >"$input/source.sql"
    local dump=source.sql
    if [ "$release" = 2.3.0 ]; then
        sql postgres -c 'CREATE DATABASE custom_seed'
        sql custom_seed <"$input/source.sql"
        pg pg_dump --format=custom --no-owner --no-acl --file="$input/source.dump" custom_seed
        sql postgres -c 'DROP DATABASE custom_seed'
        dump=source.dump
    fi
    "$node" "$oracle" update-dump-hash "$input" "$dump"
    local -a members=(manifest.json asset-manifest.json "$dump")
    if [ "$asset_kind" = object ]; then
        PLANNER_OBJECT_FIXTURE_PREPARE=1 "$node" "$media/native-migration-object.mjs" "$input" "$input/assets" "$receipt"
    else
        if [ "$variant" = inconsistent ]; then
            "$node" "$oracle" remove-directory-original "$input"
        fi
        members+=(assets)
    fi
    archive="$receipt/capture.tar.gz"
    tar --format=posix -C "$input" -czf "$archive" "${members[@]}"
    archive_digest=$(sha256sum "$archive")
    plannerctl migration prepare --archive "$archive" --work-dir "$work/processed" --json >"$receipt/prepare.json"
    local prepared
    prepared=$(field "$receipt/prepare.json" directory)
    [ "$(sha256sum "$archive")" = "$archive_digest" ]
    db="frozen_$variant"
    sql postgres -c "CREATE DATABASE $db"
    if [ "$dump" = source.dump ]; then
        pg pg_restore --exit-on-error --no-owner --no-acl -d "$db" "$prepared/$dump"
    else
        sql "$db" <"$prepared/$dump"
    fi
    sql "$db" -c "REVOKE TEMPORARY ON DATABASE $db FROM PUBLIC"
    "$node" --input-type=module - <<'JS' | sql "$db"
import { sourceColumns } from '/opt/planner/current/apps/backend/dist/application/migration/source-catalog.js';
for (const [table, columns] of Object.entries(sourceColumns)) {
  const grant = columns.map((column) => '"' + column + '"').join(',');
  console.log('GRANT SELECT (' + grant + ') ON TABLE public."' + table + '" TO fixture_reader;');
}
JS
    [ "$(sql "$db" -c "SELECT pg_catalog.has_column_privilege('fixture_reader','public.user_account','password','SELECT')")" = f ]
    [ "$(sql "$db" -c "SELECT pg_catalog.has_column_privilege('fixture_reader','public.session','access_token','SELECT')")" = f ]
    "$node" "$oracle" counts-sql "$variant" | sql "$db" >"$receipt/counts.json"
    sql "$db" -c 'SELECT name FROM public.migration ORDER BY id' >"$receipt/ledger"
    "$node" "$oracle" assert-source "$variant" "$receipt/counts.json" "$receipt/ledger" "$release"
    before=$(source_digest "$db")
    printf '[source-%s]\nisolated=true\nhost=%s\nport=%s\ndbname=%s\nuser=fixture_reader\n' \
        "$variant" "$socket" "$port" "$db" >>/etc/planner/migration-pg.services
    local assets="$receipt/assets" manifest="$prepared/manifest.json" absent_key=
    local -a asset_options
    if [ "$asset_kind" = object ]; then
        cp -R "$input/assets" "$assets"
        if [ "$variant" = inconsistent ]; then absent_key=$image_key; fi
        openssl req -x509 -newkey rsa:2048 -noenc -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 \
            -keyout "$receipt/certificate-key.pem" -out "$receipt/certificate.pem" >"$receipt/certificate.log" 2>&1
        local -a absent_options=()
        if [ -n "$absent_key" ]; then absent_options=("$absent_key"); fi
        printf 'mismatch\n' >"$receipt/version-mode"
        "$node" "$media/native-migration-object.mjs" "$prepared" "$assets" "$receipt" "${absent_options[@]}" >"$receipt/object.log" 2>&1 &
        object_pid=$!
        for _ in {1..100}; do if [ -s "$receipt/object-port" ]; then break; fi; sleep .1; done
        "$node" "$oracle" write-object-service "$receipt" "$manifest" >/etc/planner/migration-assets.json
        export NODE_EXTRA_CA_CERTS="$receipt/certificate.pem"
        asset_options=(--asset-service objects)
        refuses asset-integrity plannerctl migration preflight --manifest "$manifest" --source-service "source-$variant" "${asset_options[@]}" --json
        printf 'exact\n' >"$receipt/version-mode"
    else
        cp -R "$prepared/assets" "$assets"
        asset_options=(--assets-root "$assets")
        if [ "$variant" = clean ]; then
            printf 'Corrupt synthetic control.\n' >"$assets/$text_key"
            refuses asset-integrity plannerctl migration preflight --manifest "$manifest" --source-service "source-$variant" "${asset_options[@]}" --json
            cp "$media/planka/$release/assets/$text_key" "$assets/$text_key"
        fi
    fi

    plannerctl migration preflight --manifest "$manifest" --source-service "source-$variant" "${asset_options[@]}" --json >"$receipt/preflight.json"
    run_id=$(field "$receipt/preflight.json" runId)
    "$node" "$oracle" assert-preflight "$variant" "$receipt/preflight.json" "$release" "$manifest"
    plannerctl migration stage --run "$run_id" --format json >"$receipt/stage.json"
    [ "$(field "$receipt/stage.json" stageComplete)" = True ]
    if [ "$variant" = ambiguous ]; then
        local status=0
        plannerctl migration verify --run "$run_id" --format json >"$receipt/verify.json" || status=$?
        [ "$status" = 1 ]
    else
        plannerctl migration verify --run "$run_id" --format json >"$receipt/verify.json"
    fi
    plannerctl migration report --run "$run_id" --format json >"$receipt/report.json"
    cmp "$receipt/verify.json" "$receipt/report.json"
    local offset=0
    while [ "$offset" != None ]; do
        plannerctl migration report --run "$run_id" --format json --offset "$offset" --limit 2 >"$receipt/page-$offset.json"
        offset=$(field "$receipt/page-$offset.json" nextOffset)
    done
    "$node" "$oracle" assert-report "$variant" "$receipt"
    [ "$(sha256sum "$archive")" = "$archive_digest" ]
    [ "$(source_digest "$db")" = "$before" ]
    cold
    if [ "$variant" = ambiguous ]; then
        local manifest_hash
        manifest_hash=$(field "$receipt/preflight.json" manifestSha256)
        refuses verification-blocked plannerctl migration activate --run "$run_id" --expect-manifest "$manifest_hash" --format json
        local status=0
        plannerctl migration verify --run "$run_id" --format json >"$receipt/verify-retry.json" || status=$?
        [ "$status" = 1 ]
        cmp "$receipt/report.json" "$receipt/verify-retry.json"
        cold
    fi
    printf 'Matrix %s %s %s archive %s report %s\n' "$release" "$variant" "$asset_kind" "${archive_digest%% *}" "$(field "$receipt/report.json" reportSha256)"
}

if [ "$scenario" = clean ]; then qualify ambiguous directory; fi
qualify "$scenario" "$backend"
bash "$media/native-migration-admin.sh" "$media" "$run_id" matrix "$media/planka" "$release" "$scenario" "$work/$scenario"
[ "$(sha256sum "$archive")" = "$archive_digest" ]
[ "$(source_digest "$db")" = "$before" ]
printf 'NATIVE MIGRATION MATRIX ACCEPTANCE PASSED %s %s %s\n' "$release" "$scenario" "$backend"
