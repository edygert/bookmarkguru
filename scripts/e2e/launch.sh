#!/bin/bash
# Launches a headless Chromium with the built extension loaded, on a throwaway profile.
#
#   ./scripts/e2e/launch.sh [port]
#
# Notes that cost real time to discover:
#   --password-store=basic  is REQUIRED. Without it the browser blocks forever on a
#                           system-keyring prompt that never appears headlessly.
#   Only Brave is installed in this environment; it is Chromium-based, so MV3
#   extensions behave the same.
#   Kill matching is on the resolved binary path so the pattern never matches this
#   script's own command line (which would kill the shell running it).
set -u

PORT=${1:-9500}
BIN=${BG_BROWSER:-/usr/bin/brave-browser}
REAL_BIN=/opt/brave.com/brave/brave
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="${TMPDIR:-/tmp}/bookmarkguru-e2e/p$PORT"

if [ ! -d "$ROOT/dist" ]; then
  echo "dist/ not found — run 'npm run build' first." >&2
  exit 1
fi

for pid in $(pgrep -f "^$REAL_BIN" 2>/dev/null); do kill "$pid" 2>/dev/null; done
sleep 2

rm -rf "$PROFILE" && mkdir -p "$PROFILE"

setsid "$BIN" --headless=new --disable-gpu --no-sandbox --no-first-run \
  --password-store=basic \
  --user-data-dir="$PROFILE" \
  --disable-extensions-except="$ROOT/dist" --load-extension="$ROOT/dist" \
  --remote-debugging-port="$PORT" about:blank \
  > "$PROFILE/browser.log" 2>&1 < /dev/null &
disown

for i in $(seq 1 20); do
  if curl -s --max-time 2 "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
    echo "devtools up on $PORT after ${i}s"
    sleep 2
    # A missing service_worker here means registration failed — usually an
    # undeclared chrome.* permission throwing during module evaluation.
    curl -s --max-time 5 "http://localhost:$PORT/json/list" | python3 -c "
import json,sys
types=[t['type'] for t in json.load(sys.stdin)]
print('service_worker:', 'RUNNING' if 'service_worker' in types else 'NOT RUNNING  <-- check npm run guard:permissions')
"
    exit 0
  fi
  sleep 1
done

echo "FAILED to start. Log tail:" >&2
tail -5 "$PROFILE/browser.log" >&2
exit 1
