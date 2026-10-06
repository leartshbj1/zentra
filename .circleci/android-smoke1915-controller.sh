#!/usr/bin/env bash
set -euo pipefail
app_revision='0d2571a741883add178b485e8a1ad4d0222d4204'
build_pipeline='c5cd0c494b8d6b6110cd052fad3a75823d010196'
apk_sha='7cfc9225ee23b9eed11ec6dd92638134e7851ab024f3c904d087de0e0d498cec'
control_dir="$(cd "$(dirname "$0")" && pwd)"
verifier_root="$(git -C "$control_dir" rev-parse --show-toplevel)"
app_root="$verifier_root/.zentra-android-source"

# All exact environment pins are required before any network or emulator command.
[[ "$(uname -s)" == Linux && "${CIRCLECI:-}" == true ]]
[[ "${CIRCLE_BRANCH:-}" == codex/release-1.90.15-smoke-android-20261006 ]]
[[ "${CIRCLE_JOB:-}" == android-package-smoke-1915 && "${CIRCLE_BUILD_NUM:-}" =~ ^[1-9][0-9]*$ ]]
[[ "${CIRCLE_SHA1:-}" =~ ^[0-9a-f]{40}$ && "$CIRCLE_SHA1" != "$app_revision" && "$CIRCLE_SHA1" != "$build_pipeline" ]]
[[ "$(git -C "$verifier_root" rev-parse HEAD)" == "$CIRCLE_SHA1" ]]
[[ "${ZENTRA_SMOKE_JOB:-}" == 286 && "${ZENTRA_ANDROID_SMOKE_JOB:-}" == 286 ]]
[[ "${ZENTRA_SMOKE_SOURCE:-}" == "$app_revision" && "${ZENTRA_ANDROID_SMOKE_SOURCE:-}" == "$app_revision" ]]
[[ "${ZENTRA_SMOKE_PIPELINE_SOURCE:-}" == "$build_pipeline" && "${ZENTRA_ANDROID_SMOKE_PIPELINE_SOURCE:-}" == "$build_pipeline" ]]
[[ "${ZENTRA_SMOKE_VERSION:-}" == 1.90.15 && "${ZENTRA_ANDROID_SMOKE_SHA256:-}" == "$apk_sha" && "$apk_sha" =~ ^[0-9a-f]{64}$ ]]
dirty_controls="$(git -C "$verifier_root" status --porcelain --untracked-files=all -- .circleci)"
[[ -z "$dirty_controls" ]]
git -C "$verifier_root" cat-file -e "$app_revision^{commit}" || git -C "$verifier_root" fetch --depth 1 origin "$app_revision"
changed="$(git -C "$verifier_root" diff --name-only "$app_revision" "$CIRCLE_SHA1")"
expected=$'.circleci/android-smoke1915-controller.sh\n.circleci/android_smoke_contract.py\n.circleci/config.yml\n.circleci/smoke-android1915-recipe.py\n.circleci/smoke-android1915-recipe.sh\n.circleci/verify-1915-android-input.py'
[[ "$changed" == "$expected" ]]
[[ ! -e "$app_root" ]] || { printf 'Refusing inherited frozen application reference\n' >&2; exit 1; }
git init "$app_root"
git -C "$app_root" remote add origin https://github.com/leartshbj1/zentra.git
git -C "$app_root" fetch --depth 1 origin "$app_revision"
git -C "$app_root" checkout --detach FETCH_HEAD
export ZENTRA_ANDROID_SMOKE_APP_ROOT="$app_root"
export ZENTRA_ANDROID_SMOKE_VERIFIER_ROOT="$verifier_root"
cd "$verifier_root"
python3 "$control_dir/verify-1915-android-input.py"
# Preserve the entire original 18-minute emulator recipe budget after preflight.
timeout 18m bash "$control_dir/smoke-android1915-recipe.sh"
# The immutable app and verifier are rechecked after the original recipe too.
python3 - "$control_dir" <<'PY'
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import android_smoke_contract as contract
repo = Path(os.environ['ZENTRA_ANDROID_SMOKE_VERIFIER_ROOT'])
app = Path(os.environ['ZENTRA_ANDROID_SMOKE_APP_ROOT'])
contract.checkout(repo, app, contract.parameters(os.environ))
PY
