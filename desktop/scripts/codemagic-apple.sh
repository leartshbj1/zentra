#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export RUSTUP_TOOLCHAIN=stable LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export PATH="$HOME/.zentra-ci-tools/bin:$HOME/.cargo/bin:$PATH"
case "${1:-}" in
prepare)
  [[ "$(uname -s)" == Darwin ]]
  xcodebuild -version
  npm install --global --prefix "$HOME/.zentra-ci-tools" pnpm@11.19.0
  if ! command -v rustup >/dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/zentra-rustup.sh
    sh /tmp/zentra-rustup.sh -y --profile minimal --default-toolchain stable
  fi
  rustup toolchain install stable --profile minimal
  printf '[toolchain]\nchannel = "stable"\n' > desktop/src-tauri/rust-toolchain.toml
  pnpm install --frozen-lockfile
  ;;
macos)
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  export ELYKO_UPDATER_PUBLIC_KEY="$(cat desktop/src-tauri/updater-public-key.txt)"
  export ELYKO_UPDATER_ENDPOINT='https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases/latest-macos.json'
  node desktop/scripts/prepare-cloud-macos.mjs
  pnpm --dir desktop exec tauri build --config src-tauri/tauri.cloud-macos.generated.conf.json --target universal-apple-darwin --bundles app,dmg
  root=desktop/src-tauri/target/universal-apple-darwin/release/bundle
  app="$root/macos/Zentra.app"
  codesign --verify --deep --strict --verbose=2 "$app"
  lipo -verify_arch arm64 x86_64 "$app/Contents/MacOS/Zentra"
  version=$(node -p "require('./desktop/package.json').version")
  mkdir -p desktop/artifacts/macos
  tar -czf "desktop/artifacts/macos/Zentra_${version}_macos-universal.app.tar.gz" -C "$root/macos" Zentra.app
  dmg=$(find "$root/dmg" -name '*.dmg' -type f -print -quit)
  test -s "$dmg"
  cp "$dmg" "desktop/artifacts/macos/Zentra_${version}_macos-universal.dmg"
  (cd desktop/artifacts/macos && shasum -a 256 ./* > SHA256SUMS.txt)
  git rev-parse HEAD > desktop/artifacts/macos/SOURCE.txt
  ;;
iphone)
  sdk=$(xcrun --sdk iphoneos --show-sdk-version)
  [[ "${sdk%%.*}" -ge 26 ]]
  rustup target add aarch64-apple-ios
  pnpm --dir desktop exec tauri ios init --ci --skip-targets-install
  pnpm --dir desktop mobile:ios:ipa
  python3 desktop/scripts/verify-ios-ipa.py desktop/src-tauri/gen/apple/build/arm64/Zentra.ipa --output-dir desktop/artifacts/iphone --source-revision "$(git rev-parse HEAD)"
  cp docs/INSTALL-IPHONE.md desktop/artifacts/iphone/INSTALL-IPHONE.md
  ;;
iphone-personal)
  test -n "${ZENTRA_PERSONAL_IPHONE_TOKEN:-}"
  umask 077
  printf '%s' "$ZENTRA_PERSONAL_IPHONE_TOKEN" > desktop/src-tauri/.personal-iphone-license
  unset ZENTRA_PERSONAL_IPHONE_TOKEN
  trap 'rm -f desktop/src-tauri/.personal-iphone-license' EXIT
  sdk=$(xcrun --sdk iphoneos --show-sdk-version)
  [[ "${sdk%%.*}" -ge 26 ]]
  rustup target add aarch64-apple-ios
  pnpm --dir desktop exec tauri ios init --ci --skip-targets-install
  pnpm --dir desktop exec tauri ios build --target aarch64 --no-sign --ci --features personal-iphone
  python3 desktop/scripts/verify-ios-ipa.py desktop/src-tauri/gen/apple/build/arm64/Zentra.ipa --output-dir desktop/artifacts/iphone-personal --source-revision "$(git rev-parse HEAD)"
  version=$(node -p "require('./desktop/package.json').version")
  mv "desktop/artifacts/iphone-personal/Zentra-${version}-iPhone-unsigned.ipa" "desktop/artifacts/iphone-personal/Zentra-${version}-iPhone-PERSONNEL.ipa"
  cp docs/INSTALL-IPHONE-PERSONNEL.md desktop/artifacts/iphone-personal/LISEZ-MOI.md
  ;;
*) echo 'Expected prepare, macos or iphone' >&2; exit 2;;
esac
