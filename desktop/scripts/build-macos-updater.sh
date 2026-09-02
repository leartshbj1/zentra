#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Build refusé : le .app universel, le DMG et la notarisation doivent être produits sur macOS." >&2
  exit 1
fi

for name in ELYKO_UPDATER_PUBLIC_KEY ELYKO_UPDATER_ENDPOINT TAURI_SIGNING_PRIVATE_KEY APPLE_SIGNING_IDENTITY; do
  if [[ -z "${!name:-}" ]]; then
    echo "Build refusé : la variable $name est obligatoire." >&2
    exit 1
  fi
done

if [[ -z "${APPLE_API_ISSUER:-}" || -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_PATH:-}" ]]; then
  if [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
    echo "Build refusé : configurez la notarisation Apple par clé API ou par APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID." >&2
    exit 1
  fi
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_root="$(cd "$script_dir/.." && pwd)"
cd "$desktop_root"

rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm build:web
pnpm exec tauri build \
  --config src-tauri/tauri.macos.conf.json \
  --target universal-apple-darwin \
  --bundles app,dmg

bundle_root="src-tauri/target/universal-apple-darwin/release/bundle"
app_archive="$(find "$bundle_root/macos" -maxdepth 1 -type f -name 'Zentra.app.tar.gz' -print -quit)"
app_signature="${app_archive}.sig"
dmg="$(find "$bundle_root/dmg" -maxdepth 1 -type f -name '*.dmg' -print -quit)"

if [[ -z "$app_archive" || ! -s "$app_archive" || ! -s "$app_signature" || -z "$dmg" || ! -s "$dmg" ]]; then
  echo "Build incomplet : .dmg, .app.tar.gz ou signature Tauri manquante." >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$bundle_root/macos/Zentra.app"
spctl --assess --type execute --verbose=2 "$bundle_root/macos/Zentra.app"
xcrun stapler validate "$dmg"

echo "Build macOS universel validé : $dmg"
echo "Archive de mise à jour signée : $app_archive"
