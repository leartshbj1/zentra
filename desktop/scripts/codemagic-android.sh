#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.zentra-ci-tools/bin:$HOME/.cargo/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?Android SDK required}}"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" 'ndk;27.2.12479018' 'platforms;android-36' 'build-tools;36.0.0'
rustup target add aarch64-linux-android
pnpm --dir desktop exec tauri android init --ci --skip-targets-install
node desktop/scripts/configure-mobile-project.mjs android
pnpm --dir desktop exec tauri android build --debug --apk --target aarch64 --ci
apk=$(find desktop/src-tauri/gen/android/app/build/outputs/apk -name '*debug.apk' -type f -print -quit)
test -s "$apk"
mkdir -p desktop/artifacts/android-build
cp "$apk" desktop/artifacts/android-build/Zentra-android-build-debug.apk
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" > desktop/artifacts/android-build/package.txt
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -c -P 16 -v 4 "$apk" > desktop/artifacts/android-build/alignment.txt
# Build-machine debug signing is temporary. Only the locally verified persistent
# preview certificate may be used for a public download.
git rev-parse HEAD > desktop/artifacts/android-build/SOURCE.txt
(cd desktop/artifacts/android-build && shasum -a 256 *.apk > SHA256SUMS.txt)
