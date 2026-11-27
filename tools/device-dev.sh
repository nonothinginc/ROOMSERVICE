#!/usr/bin/env bash
# Live development on the RG477V: the app on the device loads code from this Mac's Vite dev
# server through `adb reverse`, so every save hot-reloads on the device (no rebuild/reinstall).
#
#   npm run device:dev        # once: build + install the dev shell APK, then start the dev server
#   npm run device:serve      # later sessions: just (re)connect + serve
#   npm run apk && adb install ...   # go back to the standalone APK
#
# Requires Wireless debugging (or USB) already connected: `adb devices` shows the device.
set -euo pipefail
cd "$(dirname "$0")/.."
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
PORT=5175
MODE="${1:-full}"

TARGET="$($ADB devices | awk 'NR>1 && $2=="device" {print $1}' | grep -E '^[0-9.]+:[0-9]+$' | head -1 || true)"
if [ -z "$TARGET" ]; then
  T="$($ADB mdns services | awk '/_adb-tls-connect/ {print $3}' | tail -1)"
  [ -n "$T" ] && $ADB connect "$T" >/dev/null && TARGET="$T"
fi
[ -n "$TARGET" ] || { echo "No device. Turn on Wireless debugging on the RG477V."; exit 1; }
echo "device: $TARGET"

if [ "$MODE" = "full" ]; then
  export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  export PATH="$JAVA_HOME/bin:$PATH"
  export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:--Djava.net.preferIPv4Stack=true}"
  echo "sdk.dir=$ANDROID_HOME" > android/local.properties
  # Dev shell: WebView points at the Mac (localhost over adb reverse = secure context)
  cp capacitor.config.json /tmp/roomservice-cap.json
  node -e "const f='capacitor.config.json';const c=require('./'+f);c.server={url:'http://localhost:$PORT',cleartext:true};require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
  rm -rf dist && npx vite build --logLevel error
  npx cap sync android >/dev/null
  cp /tmp/roomservice-cap.json capacitor.config.json
  (cd android && ./gradlew --quiet assembleDebug)
  $ADB -s "$TARGET" install -r -g android/app/build/outputs/apk/debug/app-debug.apk | tail -1
  $ADB -s "$TARGET" shell pm grant com.nonothing.roomservice android.permission.WRITE_SECURE_SETTINGS || true
fi

$ADB -s "$TARGET" reverse tcp:$PORT tcp:$PORT >/dev/null
$ADB -s "$TARGET" shell am force-stop com.nonothing.roomservice
( sleep 3; $ADB -s "$TARGET" shell am start -n com.nonothing.roomservice/.MainActivity >/dev/null ) &
echo "serving http://localhost:$PORT -> device (edit code; it hot-reloads on the RG477V)"
exec npx vite --port $PORT --strictPort --host 127.0.0.1
