#!/bin/bash
# Run in the disposable offline Noble guest with signed release and browser fixture media.
set -Eeuo pipefail
trap 'printf "Native browser authentication acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the read-only qualification media mount point}
origin=https://planner.example.test
node=/opt/planner/current/runtime/node/bin/node
work=$(mktemp -d /var/tmp/planner-native-auth.XXXXXX)
trap 'rm -rf "$work"' EXIT

bash "$media/native-http.sh" "$media"
plannerctl setup --mode fresh --public-url "$origin" --json > "$work/setup.json"
curl_tls() {
    curl --noproxy '*' --silent --show-error --max-time 10 --cacert /etc/ssl/planner/fullchain.pem \
        --resolve planner.example.test:443:127.0.0.1 "$@"
}
status() { curl_tls -o /dev/null -w '%{http_code}' "$@"; }
[ "$(status "$origin/health/ready")" = 503 ]
[ "$(status "$origin/recover")" = 200 ]
[ "$(status "$origin/workspace")" = 503 ]

certificate_key=$(openssl x509 -in /etc/ssl/planner/fullchain.pem -pubkey -noout | \
    openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)
missing=$(LD_LIBRARY_PATH="$media/browser-libs" ldd "$media/chromium/chrome-headless-shell" | awk '$2 == "=>" && $3 == "not" {print $1}')
if [ -n "$missing" ]; then
    printf 'Missing Chromium libraries: %s\n' "$missing" >&2
    exit 1
fi
test_user=nobody
chown "$test_user":nogroup "$work" "$work/setup.json"
runuser -u "$test_user" -- env LD_LIBRARY_PATH="$media/browser-libs" "$node" "$media/native-auth-browser.mjs" \
    "$work/setup.json" "$media/chromium/chrome-headless-shell" "$certificate_key"

[ "$(status "$origin/health/ready")" = 200 ]
[ "$(status -X POST -H 'Origin: https://unrelated.invalid' "$origin/api/v1/session/login")" = 403 ]
[ "$(status -X POST -H 'Content-Type: application/json' -H "Origin: $origin" \
    --data '{"identifier":"unknown@example.test","password":"wrong synthetic password"}' \
    "$origin/api/v1/session/login")" = 401 ]
[ "$(status --head "$origin/files/synthetic")" = 401 ]
for path in /api/v1/session /api/v1/boards/synthetic/events /mcp /oauth/consent; do
    [ "$(status "$origin$path")" = 401 ]
done

plannerctl status --json > "$work/status.json"
plannerctl setup --mode fresh --public-url "$origin" --json > "$work/confirmed.json"
systemctl stop planner.service
plannerctl status --json > "$work/db-only.json"
plannerctl stop --json > "$work/stopped.json"
plannerctl status --json > "$work/offline.json"
plannerctl start --json > "$work/started.json"
for attempt in {1..60}; do
    if [ "$(status "$origin/health/ready" 2>/dev/null)" = 200 ]; then break; fi
    sleep .2
done
[ "$(status "$origin/health/ready")" = 200 ]
plannerctl status --json > "$work/resumed.json"
python3 - "$work" <<'PY'
import json
from pathlib import Path
import sys
root = Path(sys.argv[1])
for name in ['status', 'confirmed', 'resumed']:
    state = json.loads((root / (name + '.json')).read_text())
    assert state['readiness'] == 'ready' and state['pendingAction'] == 'complete'
    assert 'firstAdminGrant' not in state
db_only = json.loads((root / 'db-only.json').read_text())
assert db_only['readiness'] == 'unavailable' and db_only['pendingAction'] == 'complete'
assert 'firstAdminGrant' not in db_only
for name in ['stopped', 'offline']:
    state = json.loads((root / (name + '.json')).read_text())
    assert state['readiness'] == 'unavailable' and state['pendingAction'] == 'unknown'
    assert 'firstAdminGrant' not in state
PY
printf 'NATIVE AUTH ACCEPTANCE PASSED\n'
