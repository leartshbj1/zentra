#!/usr/bin/env bash
# CI control only. The product script builds an isolated, exact application SHA.
set -euo pipefail

app_revision='0d2571a741883add178b485e8a1ad4d0222d4204'
release_version='1.90.15'
release_branch='codex/release-1.90.15-android-20261006'
control_dir="$(cd "$(dirname "$0")" && pwd)"
verifier_root="$(git -C "$control_dir" rev-parse --show-toplevel)"
app_root="$verifier_root/.zentra-android-source"
export PATH="$HOME/.cargo/bin:$HOME/.zentra-ci-tools/bin:$PATH"

require_verifier() {
  [[ "$(uname -s)" == Linux ]]
  [[ "${CIRCLECI:-}" == true ]]
  [[ "${CIRCLE_BRANCH:-}" == "$release_branch" ]]
  [[ "${CIRCLE_JOB:-}" == android-release-1915-frozen ]]
  [[ "${CIRCLE_BUILD_NUM:-}" =~ ^[1-9][0-9]*$ ]]
  [[ "${ZENTRA_ANDROID_SOURCE_REVISION:-}" == "$app_revision" ]]
  [[ "${ZENTRA_ANDROID_BUILD_MODE:-}" == release ]]
  [[ "${CIRCLE_SHA1:-}" =~ ^[0-9a-f]{40}$ && "$CIRCLE_SHA1" != "$app_revision" ]]
  [[ "$(git -C "$verifier_root" rev-parse HEAD)" == "$CIRCLE_SHA1" ]]
  local dirty_controls
  dirty_controls="$(git -C "$verifier_root" status --porcelain --untracked-files=all -- .circleci)"
  [[ -z "$dirty_controls" ]]
  git -C "$verifier_root" cat-file -e "$app_revision^{commit}" || git -C "$verifier_root" fetch --depth 1 origin "$app_revision"
  local changed_sources
  changed_sources="$(git -C "$verifier_root" diff --name-only "$app_revision" "$CIRCLE_SHA1")"
  [[ "$changed_sources" == $'.circleci/android1915-controller.sh\n.circleci/config.yml' ]]
}

require_application() {
  [[ "$(git -C "$app_root" rev-parse HEAD)" == "$app_revision" ]]
  # Detached HEAD is expected, not a silently selected branch.
  if git -C "$app_root" symbolic-ref --quiet HEAD >/dev/null; then return 1; else [[ "$?" == 1 ]]; fi
  local dirty_application
  dirty_application="$(git -C "$app_root" diff --name-only HEAD)"
  [[ -z "$dirty_application" ]]
  python3 - "$app_root" "$release_version" <<'PY'
import json, re, sys
from pathlib import Path
root, version = Path(sys.argv[1]), sys.argv[2]
for relative in ('desktop/package.json', 'desktop/src-tauri/tauri.conf.json'):
    if json.loads((root / relative).read_text())['version'] != version:
        raise ValueError('Frozen Android JSON version differs')
for relative, section in (('desktop/src-tauri/Cargo.toml', r'\[package\]'), ('desktop/src-tauri/Cargo.lock', r'\[\[package\]\]')):
    if re.findall(section + r'\r?\nname = "helvichantier"\r?\nversion = "([^"]+)"', (root / relative).read_text()) != [version]:
        raise ValueError('Frozen Android Rust version differs')
PY
}

require_verifier
case "${1:-}" in
  prepare)
    [[ ! -e "$app_root" ]] || { printf 'Refusing an inherited application checkout\n' >&2; exit 1; }
    git init "$app_root"
    git -C "$app_root" remote add origin https://github.com/leartshbj1/zentra.git
    git -C "$app_root" fetch --depth 1 origin "$app_revision"
    git -C "$app_root" checkout --detach FETCH_HEAD
    require_application
    cd "$app_root"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/zentra-rustup.sh
    sh /tmp/zentra-rustup.sh -y --profile minimal --default-toolchain stable
    npm install --global --prefix "$HOME/.zentra-ci-tools" pnpm@11.19.0
    pnpm install --frozen-lockfile
    require_application
    ;;
  build)
    require_application
    bash "$app_root/desktop/scripts/codemagic-android.sh"
    require_application
    require_verifier
    current_app_revision="$(git -C "$app_root" rev-parse HEAD)"
    current_verifier_revision="$(git -C "$verifier_root" rev-parse HEAD)"
    [[ "$current_app_revision" == "$app_revision" && "$current_verifier_revision" == "$CIRCLE_SHA1" ]]
    python3 - "$app_root" "$current_app_revision" "$release_version" "$current_verifier_revision" <<'PY'
import hashlib, json, os, sys
from pathlib import Path
root, source, version, verifier = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
output = root / 'desktop/artifacts/android-build'
proof = json.loads((output / 'release-candidate-proof.json').read_text())
apk = output / 'Zentra-android-build-release.apk'
if sorted(path.name for path in output.glob('*.apk')) != [apk.name]:
    raise ValueError('Expected one fresh release APK')
if not (proof['source'] == source and proof['version'] == version and proof['package'] == 'ch.zentra.mobile'
        and proof['debuggable'] is False and proof['testOnly'] is False and proof['signatureVerified'] is False
        and proof['published'] is False and proof['nativeLibraries'] and proof['bytes'] == apk.stat().st_size
        and proof['sha256'] == hashlib.sha256(apk.read_bytes()).hexdigest()):
    raise ValueError('Android candidate proof differs from the exact new APK')
if verifier != os.environ['CIRCLE_SHA1'] or (output / 'SOURCE.txt').read_text().strip() != source:
    raise ValueError('Android application source receipt differs')
(output / 'SOURCE.txt').write_text(source + '\n')
(output / 'VERIFIER-SOURCE.txt').write_text(verifier + '\n')
receipt = {'source': source, 'pipelineSource': verifier, 'version': version,
           'buildJob': int(os.environ['CIRCLE_BUILD_NUM']), 'applicationCheckoutDetached': True,
           'originalReleaseCommand': 'desktop/scripts/codemagic-android.sh', 'releaseBuildCompleted': True,
           'payload': {'name': apk.name, 'sha256': proof['sha256'], 'bytes': proof['bytes']},
           'signatureVerified': False, 'emulatorTested': False, 'physicalDeviceTested': False, 'published': False}
(output / 'android-ci-proof.json').write_text(json.dumps(receipt, indent=2) + '\n')
PY
    ;;
  *) printf 'Expected prepare or build\n' >&2; exit 2 ;;
esac
