#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Build refusé : le paquet universel macOS doit être produit sur macOS." >&2
  exit 1
fi

for name in ELYKO_UPDATER_PUBLIC_KEY ELYKO_UPDATER_ENDPOINT TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  if [[ -z "${!name:-}" ]]; then
    echo "Build refusé : la variable $name est obligatoire." >&2
    exit 1
  fi
done

if [[ "$ELYKO_UPDATER_ENDPOINT" != https://* ]]; then
  echo "Build refusé : ELYKO_UPDATER_ENDPOINT doit utiliser HTTPS." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_root="$(cd "$script_dir/.." && pwd)"
cd "$desktop_root"

version="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
tauri_version="$(node -p "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')).version")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || "$version" != "$tauri_version" ]]; then
  echo "Build refusé : versions package/Tauri incohérentes ($version / $tauri_version)." >&2
  exit 1
fi

rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm build:web

generated_config="$desktop_root/src-tauri/tauri.macos.updater.generated-$$.conf.json"
cleanup_generated_config() {
  rm -f "$generated_config"
}
trap cleanup_generated_config EXIT
node - "$generated_config" <<'NODE'
const fs = require('fs');
const outputPath = process.argv[2];
const macConfig = JSON.parse(
  fs.readFileSync('src-tauri/tauri.macos.updater-preview.conf.json', 'utf8'),
);
const updaterConfig = JSON.parse(
  fs.readFileSync('src-tauri/tauri.updater.conf.json', 'utf8'),
);
const marker = 'INJECTED_BY_ELYKO_UPDATER_PUBLIC_KEY_AT_BUILD_TIME';
if (updaterConfig?.plugins?.updater?.pubkey !== marker) {
  throw new Error('Le modèle updater ne contient pas le marqueur attendu.');
}
updaterConfig.plugins.updater.pubkey = process.env.ELYKO_UPDATER_PUBLIC_KEY.trim();
macConfig.plugins = {
  ...(macConfig.plugins ?? {}),
  updater: updaterConfig.plugins.updater,
};
fs.writeFileSync(outputPath, `${JSON.stringify(macConfig, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
NODE
pnpm exec tauri build \
  --config "$generated_config" \
  --target universal-apple-darwin \
  --bundles app,dmg

bundle_root="src-tauri/target/universal-apple-darwin/release/bundle"
app_bundle="$bundle_root/macos/Zentra.app"
app_archive=""
for candidate in "$bundle_root/macos/"*.app.tar.gz; do
  if [[ -f "$candidate" ]]; then
    app_archive="$candidate"
    break
  fi
done
app_signature="${app_archive}.sig"
dmg=""
for candidate in "$bundle_root/dmg/"*.dmg; do
  if [[ -f "$candidate" ]]; then
    dmg="$candidate"
    break
  fi
done

if [[ ! -d "$app_bundle" || -z "$app_archive" || ! -s "$app_archive" || ! -s "$app_signature" || -z "$dmg" || ! -s "$dmg" ]]; then
  echo "Build incomplet : Zentra.app, DMG, archive updater ou signature manquante." >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$app_bundle"
cargo run --quiet --locked --manifest-path src-tauri/Cargo.toml \
  --example verify_updater_artifact -- "$app_archive" "$app_signature"

artifact_parent="$desktop_root/artifacts"
artifact_root="$artifact_parent/macos-updater-$version"
mkdir -p "$artifact_parent"
if [[ -e "$artifact_root" ]]; then
  echo "Publication refusée : le lot existe déjà et ne sera pas écrasé ($artifact_root)." >&2
  exit 1
fi
mkdir "$artifact_root"

archive_name="Zentra_${version}_macos-universal.app.tar.gz"
dmg_name="Zentra_${version}_macos-universal.dmg"
cp "$app_archive" "$artifact_root/$archive_name"
cp "$app_signature" "$artifact_root/$archive_name.sig"
cp "$dmg" "$artifact_root/$dmg_name"
cp "$desktop_root/MACOS_UPDATER_PREVIEW.md" "$artifact_root/LISEZ-MOI-macOS.md"

(
  cd "$artifact_root"
  shasum -a 256 "$archive_name" "$dmg_name" > SHA256SUMS.txt
)

echo "Lot macOS updater ad hoc validé : $artifact_root"
echo "Une signature Tauri protège la mise à jour. Sans certificat Apple, Gatekeeper peut encore demander une autorisation lors de la première installation manuelle."
