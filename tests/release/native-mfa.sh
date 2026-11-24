#!/bin/bash
set -Eeuo pipefail
trap 'printf "Native MFA acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077

media=${1:?Pass the read-only qualification media mount point}
node=/opt/planner/current/runtime/node/bin/node
work=$(mktemp -d /var/tmp/planner-native-mfa.XXXXXX)
certificate=/etc/ssl/planner/fullchain.pem
key=/etc/planner/mfa-key.json
saved=/etc/planner/mfa-key.test-saved
trap 'if [ -e "$saved" ]; then mv -- "$saved" "$key"; fi; rm -rf "$work"' EXIT

bash "$media/native-auth.sh" "$media"
[ "$(stat -c '%U:%G:%a' "$key")" = 'root:planner:640' ]
if runuser -u nobody -- test -r "$key"; then exit 1; fi
certificate_key=$(openssl x509 -in "$certificate" -pubkey -noout | \
    openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)
runuser -u nobody -- env LD_LIBRARY_PATH="$media/browser-libs" "$node" "$media/native-mfa-browser.mjs" \
    "$media/chromium/chrome-headless-shell" "$certificate_key"

original_fingerprint=$(sha256sum "$key")
plannerctl stop --json > "$work/stopped.json"
mv -- "$key" "$saved"
if plannerctl start --json > "$work/missing.log" 2>&1; then exit 1; fi
grep -Fq 'previously bound Planner multifactor key' "$work/missing.log"
[ ! -e "$key" ]
jq --arg substitute "$(openssl rand -hex 32)" '.key = $substitute' "$saved" > "$key"
chown root:planner "$key"
chmod 0640 "$key"
if plannerctl start --json > "$work/mismatched.log" 2>&1; then exit 1; fi
grep -Fq 'previously bound Planner multifactor key' "$work/mismatched.log"
mv -- "$saved" "$key"
[ "$(sha256sum "$key")" = "$original_fingerprint" ]
plannerctl start --json > "$work/resumed.json"
for attempt in {1..60}; do
    if curl --noproxy '*' --silent --fail --cacert "$certificate" --resolve planner.example.test:443:127.0.0.1 \
        https://planner.example.test/health/ready >/dev/null; then break; fi
    sleep .2
done
curl --noproxy '*' --silent --fail --cacert "$certificate" --resolve planner.example.test:443:127.0.0.1 \
    https://planner.example.test/health/ready > /dev/null
printf 'NATIVE MFA ACCEPTANCE PASSED\n'
