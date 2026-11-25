#!/bin/bash
# Continue native-migration.sh in the same disposable guest and verified synthetic run.
set -Eeuo pipefail
trap 'printf "Native migration administrator acceptance failed at line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the read-only qualification media mount point}
run_id=${2:?Pass the verified synthetic run ID}
cutover=${3:-}
node=/opt/planner/current/runtime/node/bin/node
work=$(mktemp -d /var/tmp/planner-migration-admin.XXXXXX)
cert=/etc/ssl/planner/fullchain.pem
trap 'rm -rf "$work"' EXIT
[ "$(id -u)" = 0 ]
[ "$(ls /sys/class/net)" = lo ]
[ "$(findmnt -no FSTYPE --target "$media")" = iso9660 ]
findmnt -no OPTIONS --target "$media" | grep -Eq '(^|,)ro(,|$)'

(
    cd "$media/nginx"
    sha256sum -c <<'HASHES'
4176112bca331776560304ced6f6e6ca36fee2818a834d6ccdf79c6c58ed5e28  nginx-common_1.24.0-2ubuntu7.21_all.deb
c125a2ad6bfd25b6fdf92e3534a3facbf35180e05a054dcb84f68b63fc38227e  nginx_1.24.0-2ubuntu7.21_amd64.deb
HASHES
)
dpkg -i "$media/nginx/"*.deb
openssl rand -hex 32 > /etc/planner/proxy-token
chown root:planner /etc/planner/proxy-token
chmod 0640 /etc/planner/proxy-token
awk '{ printf "proxy_set_header X-Planner-Proxy-Token %s;\n", $0 }' /etc/planner/proxy-token > /etc/nginx/planner-proxy-auth.conf
install -d -m 0755 /etc/ssl/planner
openssl req -x509 -newkey rsa:2048 -noenc -days 1 -subj /CN=planner.example.test -addext subjectAltName=DNS:planner.example.test \
    -out "$cert" -keyout /etc/ssl/planner/privkey.pem 2> "$work/keygen"
chmod 0644 "$cert"
install -m 0644 "$media/planner-nginx.conf" /etc/nginx/conf.d/planner.conf
nginx -t
systemctl restart nginx
systemctl restart planner.service

bootstrap() { plannerctl migration bootstrap-admin --run "$run_id" "$@" --json; }
for source_user in 103 105 99999999999999; do
    if bootstrap --source-user "$source_user" > "$work/refused.json" 2>&1; then exit 1; fi
    grep -q 'target-setup' "$work/refused.json"
done
if bootstrap --approve-fallback --fallback-name 'Unavailable synthetic fallback' --fallback-email 'fallback@planner-fixture.invalid' \
    > "$work/refused.json" 2>&1; then exit 1; fi
grep -q 'target-setup' "$work/refused.json"
systemctl disable planner.service
systemctl is-active --quiet planner.service
bootstrap --source-user 101 > "$work/issued.json"
systemctl is-active --quiet planner.service
[ "$(systemctl is-enabled planner.service || true)" = disabled ]
systemctl stop planner.service
bootstrap --source-user 101 > "$work/replay.json"
! systemctl is-active --quiet planner.service
python3 - "$work" <<'PY2'
import json, sys
from pathlib import Path
work = Path(sys.argv[1])
issued = json.loads((work/'issued.json').read_text())
replay = json.loads((work/'replay.json').read_text())
assert issued['status'] == 'issued'
assert replay == {'status': 'already-issued', 'userId': issued['userId'], 'expiresAt': issued['expiresAt']}
(work/'grant').write_text(issued['grant'] + '\n')
PY2
systemctl start planner.service
http_status=000
for _ in $(seq 1 40); do
    http_status=$(curl --silent --max-time 1 --cacert "$cert" --resolve planner.example.test:443:127.0.0.1 \
        --output /dev/null --write-out '%{http_code}' https://planner.example.test/account-recovery || true)
    [ "$http_status" != 200 ] || break
    sleep 0.25
done
printf 'Native account-recovery route returned HTTP %s.\n' "$http_status"
[ "$http_status" = 200 ]
certificate_key=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | \
    openssl dgst -sha256 -binary | openssl base64 -A)
chgrp nogroup "$work" "$work/grant"
chmod 0710 "$work"
chmod 0640 "$work/grant"
cutover_args=()
if [ -n "$cutover" ]; then
    install -o nobody -g nogroup -m 0600 /dev/null "$work/recovery-code"
    cutover_args=("$work/recovery-code")
fi
runuser -u nobody -- env -u NODE_EXTRA_CA_CERTS LD_LIBRARY_PATH="$media/browser-libs" "$node" "$media/native-mfa-browser.mjs" \
    "$media/chromium/chrome-headless-shell" "$certificate_key" "$work/grant" --migration-recovery "${cutover_args[@]}"
systemctl stop planner.service
"$node" --input-type=module - "$run_id" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readMigrationAdminActivationProof } from '/opt/planner/current/apps/backend/dist/application/auth/migration-admin.js';
import { connectVerifiedNativeMongo } from '/opt/planner/current/apps/backend/dist/native/mongo-readiness.js';
import { acquireNativeWriter } from '/opt/planner/current/apps/backend/dist/native/writer.js';
import { legacyPublicId } from '/opt/planner/current/apps/backend/dist/storage/identity.js';
const credential = JSON.parse(await readFile('/etc/planner/mongodb-app.json', 'utf8'));
const lease = acquireNativeWriter();
const client = await connectVerifiedNativeMongo(credential);
try {
  const db = client.db('planner');
  const run = await db.collection('importRuns').findOne({ id: process.argv[2], installationId: credential.installationId });
  const proof = await readMigrationAdminActivationProof(db, run);
  assert.equal(proof.userId, legacyPublicId(run.source.instanceId, 'user_account', '101'));
  assert.ok(proof.factorId);
  assert.equal((await db.collection('installation').findOne({ _id: 'installation' })).activeGenerationId, null);
  for (const name of ['sessions', 'trustedDevices', 'oauthArtifacts', 'oauthConnections']) {
    assert.equal(await db.collection(name).countDocuments({ generationId: run.generationId }), 0);
  }
  assert.equal(await db.collection('auditEntries').countDocuments({ generationId: run.generationId, action: 'migration.admin-password-recovered' }), 1);
} finally { await client.close(); lease.release(); }
JS
printf 'NATIVE MIGRATION ADMINISTRATOR RECOVERY ACCEPTANCE PASSED\n'

if [ -n "$cutover" ]; then
    "$node" "$media/native-migration-cutover.mjs" "$run_id" "$cert" "$work/recovery-code" "$cutover"
fi
