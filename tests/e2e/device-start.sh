#!/bin/sh
# Usage: device-start.sh <router-ip>
# A computer behind its home router: route through the router, start a virtual
# display with a ticking clock, then the real Lab show desktop app (Electron).
set -e
ip route replace default via "$1"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp > /tmp/xvfb.log 2>&1 &
sleep 1
export DISPLAY=:99
xclock -update 1 -geometry 260x260+960+480 > /dev/null 2>&1 &
# Chromium switches: answer screen/microphone prompts automatically and use the fake
# microphone (a beeping tone), so voices can be measured without sound hardware.
/app/node_modules/electron/dist/electron /app --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 \
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  > /tmp/electron.log 2>&1 &
echo device-ready
exec sleep infinity
