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
phase='verifier-admission'
trap 'status=$?; if (( status != 0 )); then printf "Android CI phase=%s exit=%s\n" "$phase" "$status" >&2; fi' EXIT

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
  [[ "$changed_sources" == $'.circleci/android1915-controller.sh\n.circleci/android1915-freeze.py\n.circleci/config.yml' ]]
}

require_application() {
  python3 "$control_dir/android1915-freeze.py" "$app_root" "$app_revision" "$release_version" "$CIRCLE_SHA1" "$phase" "$@"
}

require_verifier
case "${1:-}" in
  prepare)
    phase='prepare-checkout'
    [[ ! -e "$app_root" ]] || { printf 'Refusing an inherited application checkout\n' >&2; exit 1; }
    git init "$app_root"
    git -C "$app_root" remote add origin https://github.com/leartshbj1/zentra.git
    git -C "$app_root" fetch --depth 1 origin "$app_revision"
    git -C "$app_root" checkout --detach FETCH_HEAD
    phase='prepare-admission'
    require_application
    cd "$app_root"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/zentra-rustup.sh
    sh /tmp/zentra-rustup.sh -y --profile minimal --default-toolchain stable
    npm install --global --prefix "$HOME/.zentra-ci-tools" pnpm@11.19.0
    pnpm install --frozen-lockfile
    phase='prepare-complete'
    require_application
    ;;
  build)
    phase='build-admission'
    require_application
    phase='original-android-release-build'
    bash "$app_root/desktop/scripts/codemagic-android.sh"
    phase='build-complete'
    require_application --allow-generated --receipt "$app_root/desktop/artifacts/android-build/source-freeze-proof.json"
    phase='completed-verifier-admission'
    require_verifier
    current_app_revision="$(git -C "$app_root" rev-parse HEAD)"
    current_verifier_revision="$(git -C "$verifier_root" rev-parse HEAD)"
    [[ "$current_app_revision" == "$app_revision" && "$current_verifier_revision" == "$CIRCLE_SHA1" ]]
    phase='write-provenance-receipts'
    python3 - "$app_root" "$current_app_revision" "$release_version" "$current_verifier_revision" <<'PY'
import hashlib, json, os, sys
from pathlib import Path
root, source, version, verifier = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
output = root / 'desktop/artifacts/android-build'
proof = json.loads((output / 'release-candidate-proof.json').read_text())
freeze_bytes = (output / 'source-freeze-proof.json').read_bytes()
freeze = json.loads(freeze_bytes)
if not (freeze['source'] == source and freeze['pipelineSource'] == verifier and freeze['version'] == version
        and freeze['phase'] == 'build-complete' and freeze['authoredFilesUnchanged'] is True
        and freeze['generatedCapabilitiesMatchFrozenAuthors'] is True and freeze['allowedGeneratedChanges'] is True):
    raise ValueError('Frozen authored source audit differs')
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
           'sourceFreezeProof': {'name': 'source-freeze-proof.json', 'sha256': hashlib.sha256(freeze_bytes).hexdigest(), 'bytes': len(freeze_bytes)},
           'signatureVerified': False, 'emulatorTested': False, 'physicalDeviceTested': False, 'published': False}
with (output / 'android-ci-proof.json').open('x', encoding='utf-8', newline='\n') as receipt_file:
    receipt_file.write(json.dumps(receipt, indent=2) + '\n')
PY
    ;;
  *) printf 'Expected prepare or build\n' >&2; exit 2 ;;
esac
