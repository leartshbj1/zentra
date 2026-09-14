#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.zentra-ci-tools/bin:$PATH"
qa=$(mktemp -d)
# The CI machine is discarded after this job. Keep diagnostics until then.
npm install --prefix "$qa" playwright@1.62.1 --no-audit --no-fund
"$qa/node_modules/.bin/playwright" install webkit
export ZENTRA_PLAYWRIGHT_MODULE="$qa/node_modules/playwright" ZENTRA_QA_BROWSER=webkit ZENTRA_QA_ORIGIN=http://127.0.0.1:5271
pnpm --dir desktop dev --port 5271 > "$qa/preview.log" 2>&1 & preview_pid=$!
trap 'kill "$preview_pid" 2>/dev/null || true' EXIT
for attempt in $(seq 1 60); do
  if curl -fsS "$ZENTRA_QA_ORIGIN/tests/touch-team-harness.html" >/dev/null; then break; fi
  sleep 1
done
node desktop/tests/touch-team-journey.mjs
mkdir -p desktop/artifacts/macos
cp .qa/mobile-team-webkit/report.json desktop/artifacts/macos/mobile-webkit-report.json
