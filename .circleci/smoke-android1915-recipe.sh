#!/usr/bin/env bash
set -euo pipefail
cd "$ZENTRA_ANDROID_SMOKE_APP_ROOT"
out="$ZENTRA_ANDROID_SMOKE_VERIFIER_ROOT/desktop/artifacts/android-release-smoke"
mkdir -p "$out"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?Android SDK required}}"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
image='system-images;android-35;google_apis;x86_64'
sdkmanager 'emulator' 'platform-tools' 'build-tools;36.0.0' "$image" > "$out/sdk-install.log"
printf 'no\n' | avdmanager create avd -n zentra_release_smoke -k "$image" --force
emulator -avd zentra_release_smoke -port 5554 -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect -memory 2048 > "$out/emulator.log" 2>&1 &
emulator_pid=$!
cleanup() {
  adb -s emulator-5554 emu kill >/dev/null 2>&1 || true
  wait "$emulator_pid" || true
}
trap cleanup EXIT
timeout 120 adb -s emulator-5554 wait-for-device
timeout 240 bash -c 'until [ "$(adb -s emulator-5554 shell getprop sys.boot_completed | tr -d "\r")" = 1 ]; do sleep 2; done'
adb -s emulator-5554 shell input keyevent 82
python3 "$ZENTRA_ANDROID_SMOKE_VERIFIER_ROOT/.circleci/smoke-android1915-recipe.py"
