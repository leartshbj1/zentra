#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Build refusé : l'application macOS doit être produite sur un Mac ou un runner GitHub macOS." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_root="$(cd "$script_dir/.." && pwd)"
cd "$desktop_root"

# Le pseudo-certificat « - » produit une signature ad hoc : il ne demande ni
# abonnement Apple Developer ni secret, mais macOS affichera encore Gatekeeper.
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm exec tauri build \
  --config src-tauri/tauri.macos.preview.conf.json \
  --target universal-apple-darwin \
  --bundles app,dmg

bundle_root="src-tauri/target/universal-apple-darwin/release/bundle"
app_bundle="$bundle_root/macos/Zentra.app"
dmg=""
for candidate in "$bundle_root/dmg/"*.dmg; do
  if [[ -f "$candidate" ]]; then
    dmg="$candidate"
    break
  fi
done

if [[ ! -d "$app_bundle" || -z "$dmg" || ! -s "$dmg" ]]; then
  echo "Build incomplet : Zentra.app ou DMG manquant." >&2
  exit 1
fi

# Une signature ad hoc doit être présente sur Apple Silicon. Elle ne prouve pas
# l'identité de l'éditeur et n'est donc jamais présentée comme une release.
codesign --verify --deep --strict --verbose=2 "$app_bundle"

artifact_root="$desktop_root/artifacts/macos-preview"
rm -rf "$artifact_root"
mkdir -p "$artifact_root"
ditto -c -k --keepParent --sequesterRsrc "$app_bundle" "$artifact_root/Zentra_macos_universal_preview.app.zip"
cp "$dmg" "$artifact_root/Zentra_macos_universal_preview.dmg"
cp "$desktop_root/MACOS_PREVIEW.md" "$artifact_root/LISEZ-MOI-macOS.md"

(
  cd "$artifact_root"
  shasum -a 256 ./* > SHA256SUMS.txt
)

echo "Aperçu macOS ad hoc prêt dans $artifact_root"
echo "Ce lot est destiné aux tests privés. Une diffusion publique exige Developer ID et notarisation Apple."
