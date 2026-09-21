#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.zentra-ci-tools/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
export RUSTUP_TOOLCHAIN=stable LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
case "${1:-}" in
prepare)
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
    brew install node@22
    export PATH="$(brew --prefix node@22)/bin:$PATH"
    printf 'export PATH="%s/bin:$PATH"\n' "$(brew --prefix node@22)" >> "${BASH_ENV:?}"
  fi
  bash desktop/scripts/codemagic-apple.sh prepare
  ;;
test)
  mkdir -p desktop/artifacts/validation
  pnpm --dir desktop exec vitest run src/companyAccount.test.ts src/companyRealtime.test.ts src/projectSyncScheduler.test.ts src/automationCompanySession.test.ts src/appReleaseNotes.test.ts src/automationDailySummary.test.tsx src/automationHub.test.tsx src/supplierInboxReview.test.ts src/languageCatalogCoverage.test.ts src/projectReport.test.ts \
    2>&1 | tee desktop/artifacts/validation/ui-tests.log
  pnpm --dir desktop build:web
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib company_ -- --nocapture --test-threads=1 \
    2>&1 | tee desktop/artifacts/validation/company-tests-macos.log
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib account_cloud::tests -- --test-threads=1 \
    2>&1 | tee desktop/artifacts/validation/account-tests-macos.log
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib backup::tests -- --test-threads=1 \
    2>&1 | tee desktop/artifacts/validation/backup-tests-macos.log
  bash desktop/scripts/test-mobile-webkit.sh
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib supplier_inbox::tests -- --test-threads=1 \
    2>&1 | tee desktop/artifacts/validation/supplier-inbox-tests-macos.log
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib appointment_inbox::tests -- --test-threads=1 2>&1 | tee desktop/artifacts/validation/appointment-inbox-tests-macos.log
  cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib project_report::tests -- --test-threads=1 2>&1 | tee desktop/artifacts/validation/project-report-tests-macos.log
  ;;
iphone)
  bash desktop/scripts/codemagic-apple.sh iphone
  bash desktop/scripts/test-apple-navigation.sh
  ;;
*) echo 'Expected prepare, test or iphone' >&2; exit 2;;
esac
