#!/bin/bash
# Run only in a disposable, offline Noble guest with signed qualification media.
set -Eeuo pipefail
trap 'printf "Native board event acceptance failed on line %s.\n" "$LINENO" >&2' ERR
umask 077
media=${1:?Pass the mount point of the read-only qualification media}
node=/opt/planner/current/runtime/node/bin/node
bash "$media/native-media.sh" "$media"
systemctl stop planner.service
runuser -u planner -- "$node" "$media/native-board-events.mjs" seed
systemctl start planner.service
missing=$(LD_LIBRARY_PATH="$media/browser-libs" ldd "$media/chromium/chrome-headless-shell" | awk '$2 == "=>" && $3 == "not" {print $1}')
[ -z "$missing" ]
LD_LIBRARY_PATH="$media/browser-libs" "$node" "$media/native-board-events.mjs" browser "$media/chromium/chrome-headless-shell"
echo 'NATIVE BOARD EVENT ACCEPTANCE PASSED'
