#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
build_mode="${ZENTRA_ANDROID_BUILD_MODE:-debug}"
case "$build_mode" in
  debug|release) ;;
  *) echo 'ZENTRA_ANDROID_BUILD_MODE must be debug or release' >&2; exit 2 ;;
esac
export PATH="$HOME/.zentra-ci-tools/bin:$HOME/.cargo/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?Android SDK required}}"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" 'ndk;27.2.12479018' 'platforms;android-36' 'build-tools;36.0.0'
rustup target add aarch64-linux-android
pnpm --dir desktop exec tauri android init --ci --skip-targets-install
node desktop/scripts/configure-mobile-project.mjs android
build_flags=(--apk --target aarch64 --ci)
if [[ "$build_mode" == debug ]]; then build_flags+=(--debug); fi
pnpm --dir desktop exec tauri android build "${build_flags[@]}"
mapfile -t packages < <(find desktop/src-tauri/gen/android/app/build/outputs/apk -path "*/$build_mode/*" -name '*.apk' -type f)
if [[ "${#packages[@]}" -ne 1 ]]; then echo 'Expected exactly one arm64 APK for the requested build mode' >&2; exit 1; fi
apk="${packages[0]}"
test -s "$apk"
mkdir -p desktop/artifacts/android-build
cp "$apk" "desktop/artifacts/android-build/Zentra-android-build-$build_mode.apk"
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" > desktop/artifacts/android-build/package.txt
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -c -P 16 -v 4 "$apk" > desktop/artifacts/android-build/alignment.txt
# Release builds are candidates only: no signing key is exposed to this job.
# The existing debug distribution still requires its pinned preview identity.
if [[ "$build_mode" == release ]]; then
  python3 desktop/scripts/check-android-release.py "$apk" \
    --aapt "$ANDROID_HOME/build-tools/36.0.0/aapt" \
    --version "$(node -p 'JSON.parse(require("fs").readFileSync("desktop/package.json", "utf8")).version')" \
    --source "$(git rev-parse HEAD)" \
    --output desktop/artifacts/android-build/release-candidate-proof.json
fi
git rev-parse HEAD > desktop/artifacts/android-build/SOURCE.txt
(cd desktop/artifacts/android-build && shasum -a 256 *.apk > SHA256SUMS.txt)
