#!/usr/bin/env bash
# CI control code only. The application checkout is always the exact release SHA.
set -euo pipefail

app_revision='c067f2e6bd0c6cbe2dae76162feb88e92f44156b'
release_version='1.90.14'
release_branch='codex/release-1.90.14-apple-20261006'
control_dir="$(cd "$(dirname "$0")" && pwd)"
verifier_root="$(git -C "$control_dir" rev-parse --show-toplevel)"
app_root="$verifier_root/.zentra-apple-source"
export PATH="$HOME/.zentra-ci-tools/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
export RUSTUP_TOOLCHAIN=stable LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

require_verifier() {
  [[ "$(uname -s)" == Darwin ]]
  [[ "${CIRCLECI:-}" == true ]]
  [[ "${CIRCLE_BRANCH:-}" == "$release_branch" ]]
  [[ "${ZENTRA_APPLE_SOURCE_REVISION:-}" == "$app_revision" ]]
  [[ "${CIRCLE_SHA1:-}" =~ ^[0-9a-f]{40}$ ]]
  local actual_revision changed_sources
  actual_revision="$(git -C "$verifier_root" rev-parse HEAD)"
  [[ "$actual_revision" == "$CIRCLE_SHA1" ]]
  changed_sources="$(git -C "$verifier_root" diff --name-only HEAD -- .circleci)"
  [[ -z "$changed_sources" ]]
  # A new verifier may only change CI controls relative to the application.
  git -C "$verifier_root" cat-file -e "$app_revision^{commit}" ||
    git -C "$verifier_root" fetch --depth 1 origin "$app_revision"
  changed_sources="$(git -C "$verifier_root" diff --name-only "$app_revision" "$CIRCLE_SHA1")"
  while IFS= read -r changed; do
    [[ -z "$changed" || "$changed" == .circleci/* ]] || {
      printf 'Verifier changes product source: %s\n' "$changed" >&2
      return 1
    }
  done <<< "$changed_sources"
}

require_application() {
  local actual_revision changed_sources
  actual_revision="$(git -C "$app_root" rev-parse HEAD)"
  [[ "$actual_revision" == "$app_revision" ]]
  changed_sources="$(git -C "$app_root" diff --name-only HEAD -- desktop)"
  [[ -z "$changed_sources" ]]
  python3 - "$app_root" "$release_version" <<'PY'
import json, re, sys
from pathlib import Path
root, version = Path(sys.argv[1]), sys.argv[2]
for relative in ('desktop/package.json', 'desktop/src-tauri/tauri.conf.json'):
    if json.loads((root / relative).read_text())['version'] != version:
        raise ValueError('Frozen Apple application version differs')
for relative, section in (('desktop/src-tauri/Cargo.toml', r'\[package\]'),
                          ('desktop/src-tauri/Cargo.lock', r'\[\[package\]\]')):
    matches = re.findall(section + r'\r?\nname = "helvichantier"\r?\nversion = "([^"]+)"', (root / relative).read_text())
    if matches != [version]:
        raise ValueError('Frozen Apple Rust package version differs')
PY
}

require_verifier
case "${1:-}" in
  prepare)
    [[ ! -e "$app_root" ]] || { printf 'Refusing an inherited application checkout\n' >&2; exit 1; }
    git init "$app_root"
    git -C "$app_root" remote add origin https://github.com/leartshbj1/zentra.git
    git -C "$app_root" fetch --depth 1 origin "$ZENTRA_APPLE_SOURCE_REVISION"
    git -C "$app_root" checkout --detach FETCH_HEAD
    require_application
    mkdir -p "$app_root/desktop/artifacts/validation/homebrew"
    bash "$control_dir/apple1914-homebrew.sh" "$app_root/desktop/artifacts/validation/homebrew"
    bash "$app_root/desktop/scripts/cloud-release-apple.sh" prepare
    require_application
    ;;
  native-preflight)
    require_application
    cd "$app_root"
    mkdir -p desktop/artifacts/validation
    cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib diagnostics::account_automation_diagnostics_tests::changed_session_or_company_during_transport_refuses_historical_response_without_logging_direct_strings -- --exact --test-threads=1 2>&1 | tee desktop/artifacts/validation/automation-session-change-macos.log
    require_application
    ;;
  test|macos|iphone)
    require_application
    case "$1" in
      test) bash "$app_root/desktop/scripts/cloud-release-apple.sh" test ;;
      macos) bash "$app_root/desktop/scripts/codemagic-apple.sh" macos ;;
      iphone) bash "$app_root/desktop/scripts/cloud-release-apple.sh" iphone ;;
    esac
    require_application
    ;;
  smoke)
    require_application
    python3 "$app_root/desktop/scripts/local-apple-package-smoke.py"
    require_application
    ;;
  record)
    require_application
    # Refuse final provenance until the new job's packaged Mac smoke exists.
    python3 - "$app_root" "$app_revision" "$release_version" <<'PY'
import json, os, sys
from pathlib import Path
root, source, version = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
proof = json.loads((root / 'desktop/artifacts/smoke/macos-smoke.json').read_text())
if not (proof['source'] == source and proof['version'] == version
        and proof['buildJob'] == int(os.environ['CIRCLE_BUILD_NUM'])
        and proof['startupAndRelaunchPassed'] is True and proof['isolatedProfile'] is True):
    raise ValueError('New Apple job packaged smoke is absent or inconsistent')
iphone = json.loads((root / 'desktop/artifacts/iphone/build-info.json').read_text())
if iphone['source_revision'] != source or iphone['version'] != version:
    raise ValueError('New iPhone package source/version differs')
PY
    printf '%s\n' "$CIRCLE_SHA1" > "$app_root/desktop/artifacts/VERIFIER-SOURCE.txt"
    printf 'Application %s; verifier %s; no publication performed\n' "$app_revision" "$CIRCLE_SHA1"
    ;;
  *) printf 'Expected prepare, native-preflight, test, macos, iphone, smoke or record\n' >&2; exit 2 ;;
esac
