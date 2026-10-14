// Read-only contracts for the actual release selection. No child process,
// network, native execution, build, credential or generated receipt is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, statSync } from 'node:fs';

globalThis.fetch = async () => { throw Error('PURE_RELEASE_CONTRACT_NETWORK_REFUSED'); };
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const releaseSource = read('./cloud-release-windows.ps1');
// The separate build-only branch is checked below, never counted as a full release.
const pairStart = releaseSource.indexOf('    # AUTOPILOT_BUILD_PAIR_BEGIN:');
const pairEnd = releaseSource.indexOf('    # AUTOPILOT_BUILD_PAIR_END\n', pairStart);
assert.ok(pairStart > 0 && pairEnd > pairStart);
const release = releaseSource.slice(0, pairStart) + releaseSource.slice(pairEnd + '    # AUTOPILOT_BUILD_PAIR_END\n'.length);
const native = read('../src-tauri/src/account_cloud_quote_autopilot.rs');
const consumer = read('../src-tauri/src/account_cloud_action_engine.rs');
const account = read('../src-tauri/src/account_cloud.rs');
const tests = read('../src-tauri/src/account_cloud_quote_autopilot_tests.rs');
const existingSelection = read('./quote-autopilot-verification.ps1');
const frontend = Object.freeze(['src/autopilotSession.test.ts', 'src/autopilotReview.test.ts',
  'src/AutopilotPanel.test.tsx', 'src/autopilotBudget.test.ts', 'src/useAutopilot.test.tsx', 'src/confirmedQuoteDestination.test.ts']);
const namespace = 'account_cloud::action_engine::supervisor::tests::';
const calls = release.split('\n').filter(line => /^\s*Invoke-Checked /.test(line));
function argumentsOf(line, tool) {
  assert.match(line, new RegExp(`^\\s*Invoke-Checked ${tool.replace('.', '\\.')} @\\(.*\\)\\s*$`));
  const raw = line.slice(line.indexOf('@(') + 2, line.lastIndexOf(')'));
  assert.match(raw, /^'[^']*'(?:, '[^']*')*$/);
  return [...raw.matchAll(/'([^']*)'/g)].map(match => match[1]);
}

test('release selects the six existing product suites once, including the real hook, hourly budget and quote destination', () => {
  const selected = calls.filter(line => frontend.some(path => line.includes(`'${path}'`)));
  assert.equal(selected.length, 1);
  assert.deepEqual(argumentsOf(selected[0], 'pnpm.cmd'), ['--dir', 'desktop', 'exec', 'vitest', 'run', ...frontend]);
  for (const path of frontend) {
    const url = new URL(`../${path}`, import.meta.url);
    assert.ok(statSync(url).isFile());
    assert.match(readFileSync(url, 'utf8'), /(?:\bit|\btest|\bdescribe)\s*(?:\.each\([^]*?\))?\s*\(/);
    assert.equal(release.split(`'${path}'`).length - 1, 1);
  }
});

test('native target is the separate supervisor namespace, locked, serial and never ignored or live', () => {
  const selected = calls.filter(line => line.includes(`'${namespace}'`));
  assert.equal(selected.length, 1);
  assert.deepEqual(argumentsOf(selected[0], 'cargo'), ['test', '--manifest-path', 'desktop/src-tauri/Cargo.toml',
    '--locked', '--lib', namespace, '--', '--test-threads=1']);
  const names = [...tests.matchAll(/#\[test\]\s*fn\s+(\w+)\s*\(/g)].map(match => match[1]);
  assert.equal(names.length, 9);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.equal(existingSelection.split(`'${name}'`).length - 1, 1);
  assert.match(consumer, /#\[path = "account_cloud_quote_autopilot\.rs"\]\s*pub\(crate\) mod supervisor;/);
  assert.match(account, /#\[path = "account_cloud_action_engine\.rs"\]\s*pub\(crate\) mod action_engine;/);
  assert.match(native, /#\[cfg\(test\)\]\s*#\[path = "account_cloud_quote_autopilot_tests\.rs"\]\s*mod tests;/);
  assert.doesNotMatch(tests, /#\[ignore/);
});

test('contract and both product selections execute before build and packaging in the full path', () => {
  const command = "Invoke-Checked node @('--test', 'desktop/scripts/quote-autopilot-release.contracts.test.mjs')";
  assert.equal(release.split(command).length - 1, 1);
  const contract = release.indexOf(command), full = release.indexOf("Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/bexioImport.test.ts'");
  const front = release.indexOf(`'${frontend[0]}'`), rust = release.indexOf(`'${namespace}'`);
  const build = release.indexOf("Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'build:web')", full);
  const guard = release.indexOf("if ($env:ZENTRA_VERIFY_ONLY -eq 'true') { return }", full);
  const packageBuild = release.indexOf("Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'tauri', 'build'", full);
  assert.ok(full > 0 && full < contract && contract < front && front < rust && rust < build && build < guard && guard < packageBuild);
});

test('preflight uses the existing checked runner and adds no capability, session or success claim', () => {
  const start = release.indexOf('    # Autopilot product preflight:');
  const end = release.indexOf("    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/workNotes.test.ts'", start);
  assert.ok(start > 0 && end > start);
  const addition = release.slice(start, end);
  assert.equal(addition.split('\n').filter(line => /^\s*Invoke-Checked /.test(line)).length, 4);
  assert.doesNotMatch(addition, /(?:SetEnvironmentVariable|\$env:|PRODUCT_ENABLED\s*=|ZENTRA_RUN_|oai-sites|Bearer|--ignored|Proof|Passed\s*=|ConvertTo-Json|WriteAllText|Invoke-WebRequest)/i);
  assert.match(release, /Invoke-ZentraVerificationSuite \$script:releasePreflightHarness \$spec\.Filter \$spec\.TestArguments/);
  assert.match(read('./windows-verification-harness.ps1'), /\$names\.Count -eq 0/);
});

test('existing release contracts preserve the twenty-five historical calls and close only the single new appendix', () => {
  const contracts = read('./windows-release-preflight.contract-tests.ps1');
  assert.match(contracts, /\$calls\.Count -eq 27 -and \$historicalCalls\.Count -eq 25/);
  assert.match(contracts, /\$autopilotCalls\.Count -eq 1 -and \$onCalls\.Count -eq 1/);
  assert.ok(contracts.includes(`'test|--manifest-path|desktop/src-tauri/Cargo.toml|--locked|--lib|${namespace}|--|--test-threads=1'`));
  assert.match(contracts, /if \(\$_ -isnot \[System\.Management\.Automation\.Language\.StringConstantExpressionAst\]\)/);
  assert.match(contracts, /foreach \(\$call in \$calls\)[^]*?ConvertTo-ZentraReleaseTestInvocation 'cargo' \$arguments/);
});
