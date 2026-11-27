#!/usr/bin/env bash
# Build the ROOMSERVICE APK for the RG477V (debug-signed, sideload with adb or a file copy).
#   npm run apk            -> android/app/build/outputs/apk/debug/ROOMSERVICE.apk
# Packs in ./packs (from `npm run packs`) are bundled into this APK only.
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$PATH"
# Java can stall on IPv6 on some home networks (sdkmanager did): force IPv4 for Gradle downloads
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:--Djava.net.preferIPv4Stack=true}"
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

[ -f packs/index.json ] || node tools/build-packs.mjs
rm -rf dist
INCLUDE_PACKS=1 npx vite build --logLevel warn
npx cap sync android
(cd android && ./gradlew --quiet assembleDebug)
OUT=android/app/build/outputs/apk/debug
cp "$OUT/app-debug.apk" "$OUT/ROOMSERVICE.apk"
ls -lh "$OUT/ROOMSERVICE.apk"
