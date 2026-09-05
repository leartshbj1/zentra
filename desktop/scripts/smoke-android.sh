#!/usr/bin/env bash
set -euo pipefail
mkdir -p desktop/artifacts/android
capture_diagnostics() {
  status=$?
  if [[ -f /tmp/zentra-emulator.log ]]; then
    cp /tmp/zentra-emulator.log desktop/artifacts/android/emulator.log
  fi
  timeout 10 adb logcat -d > desktop/artifacts/android/startup.log 2>&1 || true
  timeout 10 adb logcat -b crash -d > desktop/artifacts/android/crash.log 2>&1 || true
  timeout 10 adb exec-out screencap -p > desktop/artifacts/android/startup.png || true
  timeout 10 adb shell run-as ch.zentra.mobile find . -type f > desktop/artifacts/android/profile-files.txt 2>&1 || true
  if [[ "$status" -ne 0 ]]; then
    timeout 75 node desktop/scripts/diagnose-android-startup.mjs || true
    tail -n 60 desktop/artifacts/android/emulator.log 2>/dev/null || true
    tail -n 60 desktop/artifacts/android/startup.log || true
    cat desktop/artifacts/android/crash.log || true
    cat desktop/artifacts/android/profile-files.txt || true
  fi
  exit "$status"
}
trap capture_diagnostics EXIT

wait_for_welcome() {
  local phase="$1"
  # Database/identity files are created before React finishes opening the profile.
  # Prove a usable first launch before testing recovery from a normal restart.
  for attempt in $(seq 1 20); do
    adb shell pidof ch.zentra.mobile >/dev/null
    timeout 15 adb shell uiautomator dump --compressed /sdcard/zentra-startup.xml >/dev/null 2>&1 || true
    adb exec-out cat /sdcard/zentra-startup.xml > desktop/artifacts/android/startup-ui.xml 2>/dev/null || true
    if grep -q 'Restaurer une sauvegarde' desktop/artifacts/android/startup-ui.xml; then
      echo "Android welcome interface verified: $phase"
      return 0
    fi
    sleep 3
  done
  echo "Android welcome interface missing: $phase" >&2
  return 1
}

timeout 120 adb wait-for-device
timeout 180 bash -c 'until [ "$(adb shell getprop sys.boot_completed | tr -d "\r")" = "1" ]; do sleep 2; done'
apk="${1:-$(find desktop/src-tauri/gen/android/app/build/outputs/apk -name '*x86_64*.apk' -print -quit)}"
test -n "$apk"
adb install "$apk"
adb logcat -c
adb shell am start -W -n ch.zentra.mobile/.MainActivity
for attempt in $(seq 1 30); do
  profile_files="$(adb shell run-as ch.zentra.mobile find . -type f)"
  if grep -q 'helvichantier.sqlite3' <<< "$profile_files" && grep -q 'installation-identity.protected' <<< "$profile_files"; then break; fi
  sleep 2
done
adb shell pidof ch.zentra.mobile
grep -q 'helvichantier.sqlite3' <<< "$profile_files"
grep -q 'installation-identity.protected' <<< "$profile_files"
wait_for_welcome 'first launch'
identity_path="$(grep 'installation-identity.protected' <<< "$profile_files" | head -n 1 | tr -d '\r')"
identity_before="$(adb shell run-as ch.zentra.mobile sha256sum "$identity_path")"
adb shell am force-stop ch.zentra.mobile
adb shell am start -W -n ch.zentra.mobile/.MainActivity
sleep 5
adb shell pidof ch.zentra.mobile
identity_after="$(adb shell run-as ch.zentra.mobile sha256sum "$identity_path")"
test "$identity_before" = "$identity_after"
wait_for_welcome 'after restart'
adb exec-out screencap -p > desktop/artifacts/android/startup.png
adb logcat -d -s AndroidRuntime:E > desktop/artifacts/android/runtime.log
if grep -q 'FATAL EXCEPTION' desktop/artifacts/android/runtime.log; then
  cat desktop/artifacts/android/runtime.log
  exit 1
fi
echo 'Android welcome interface, SQLite, Keystore and identity recovery after restart verified.'
