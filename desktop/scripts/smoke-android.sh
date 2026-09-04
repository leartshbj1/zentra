#!/usr/bin/env bash
set -euo pipefail
mkdir -p desktop/artifacts/android
adb wait-for-device
timeout 180 bash -c 'until [ "$(adb shell getprop sys.boot_completed | tr -d "\r")" = "1" ]; do sleep 2; done'
apk="$(find desktop/src-tauri/gen/android/app/build/outputs/apk -name '*x86_64*.apk' -print -quit)"
test -n "$apk"
adb install "$apk"
adb logcat -c
adb shell am start -W -n ch.zentra.mobile/.MainActivity
sleep 8
adb shell pidof ch.zentra.mobile
profile_files="$(adb shell run-as ch.zentra.mobile find files -type f)"
grep -q 'helvichantier.sqlite3' <<< "$profile_files"
grep -q 'installation-identity.protected' <<< "$profile_files"
adb exec-out screencap -p > desktop/artifacts/android/startup.png
adb logcat -d -s AndroidRuntime:E > desktop/artifacts/android/runtime.log
if grep -q 'FATAL EXCEPTION' desktop/artifacts/android/runtime.log; then
  cat desktop/artifacts/android/runtime.log
  exit 1
fi
echo 'Android startup, SQLite and Keystore initialization verified.'
