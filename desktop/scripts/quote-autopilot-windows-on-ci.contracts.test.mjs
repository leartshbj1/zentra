// Public source contracts only: no child process, Cargo, HTTP or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

for (const name of ['ZENTRA_A41_SITES_SERVICE_TOKEN', 'ZENTRA_A41_BROWSER_COOKIE_QA']) {
  if (Object.hasOwn(process.env, name)) throw Error('PURE_ON_CONTRACT_PRIVATE_ENVIRONMENT_REFUSED');
}
globalThis.fetch = async () => { throw Error('PURE_ON_CONTRACT_NETWORK_REFUSED'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replaceAll('\r\n', '\n');
const sha = text => createHash('sha256').update(text).digest('hex');
const require = createRequire(import.meta.url);
let yaml;
try { yaml = require('js-yaml'); } catch {
  // The test may be read from a proposal tree; the installed dependency is public.
  const base = [root, process.cwd()].map(directory => path.join(directory, 'node_modules/.pnpm'))
    .find(directory => fs.existsSync(directory));
  assert.ok(base, 'The public pnpm dependency store must exist in the repository.');
  const name = fs.readdirSync(base).find(name => name.startsWith('js-yaml@4.'));
  assert.ok(name);
  yaml = require(path.join(base, name, 'node_modules/js-yaml/index.js'));
}
const text = read('.circleci/config.yml');
const config = yaml.load(text);
const spans = [
  ['  windows-autopilot-product-on:\n', '  verify-only:\n', '27296e8b38832a97890135f66bed3e7c6ee6e91641810e17e3fca2d1677728d6'],
  ['  windows-autopilot-product:\n', '  windows-action-live-account-tests:\n', '36b9e1ef9dd710742aefc19e269aa122b6d061b21b82aafda0968f8166918e8e'],
  ['  autopilot-windows-build-verification:\n', '  action-live-account-verification:\n', '603af1b9bef6ac5014d5092f05fb8bcec2f4bba9ec18d1e9b0337688741c6d39'],
];
function project(source) {
  for (const [start, end, expected] of spans) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a);
    assert.equal(sha(source.slice(a, b)), expected);
    source = source.slice(0, a) + source.slice(b);
  }
  const exclusion = '        - not: << pipeline.parameters.windows-autopilot-product-on >>\n';
  assert.equal(source.split(exclusion).length - 1, 8);
  return source.replaceAll(exclusion, '');
}
const historicalText = project(text), historical = yaml.load(historicalText);
const defaults = Object.fromEntries(Object.entries(config.parameters).map(([key, value]) => [key, value.default]));
function resolve(value, context) {
  if (typeof value !== 'string') return value;
  if (value === '<< pipeline.git.branch >>') return context.branch;
  if (value.startsWith('<< pipeline.parameters.')) return context.parameters[value.slice(23, -3)];
  return value;
}
function evaluate(value, context) {
  if (!value || typeof value !== 'object') return resolve(value, context);
  const entries = Object.entries(value); assert.equal(entries.length, 1);
  const [[op, args]] = entries;
  if (op === 'and') return args.every(value => evaluate(value, context));
  if (op === 'or') return args.some(value => evaluate(value, context));
  if (op === 'not') return !evaluate(args, context);
  if (op === 'equal') return resolve(args[0], context) === resolve(args[1], context);
  throw Error('UNKNOWN_CI_CONDITION');
}
const active = (cfg, context) => Object.entries(cfg.workflows).filter(([, value]) => evaluate(value.when, context)).map(([key]) => key).sort();
const release = read('desktop/scripts/cloud-release-windows.ps1');
const helper = read('desktop/scripts/windows-verification-harness.ps1');
const pair = release.slice(release.indexOf('    # AUTOPILOT_BUILD_PAIR_BEGIN:'), release.indexOf('    # AUTOPILOT_BUILD_PAIR_END'));

test('only closed public additions change the historical CI configuration', () => {
  assert.equal(sha(historicalText), 'ab29af8effb1e45b7bdb4076291d24d96af168e724a4d592164572a8aafb4cb2');
  assert.deepEqual(config.parameters['windows-autopilot-product-on'], { type: 'boolean', default: false });
  const projected = structuredClone(config);
  delete projected.parameters['windows-autopilot-product-on'];
  delete projected.jobs['windows-autopilot-product'];
  delete projected.workflows['autopilot-windows-build-verification'];
  delete projected.workflows['autopilot-windows-release-candidate'];
  for (const value of Object.values(projected.workflows)) {
    if (value.when?.and) value.when.and = value.when.and.filter(item => item?.not !== '<< pipeline.parameters.windows-autopilot-product-on >>');
  }
  assert.deepEqual(projected, historical);
  assert.throws(() => project(text.replace('parallelism: 1', 'parallelism: 2')));
});

test('one Windows node has no private context and uses only the two explicit entrypoints', () => {
  const job = config.jobs['windows-autopilot-product'];
  assert.equal(job.parallelism, 1);
  assert.equal(job.resource_class, 'windows.medium');
  assert.equal(job.machine.image, 'windows-server-2022-gui:2026.05.1');
  assert.deepEqual(job.parameters, { package: { type: 'boolean', default: false } });
  assert.deepEqual(job.environment, { RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc', CARGO_PROFILE_TEST_DEBUG: '0', ZENTRA_RELEASE_TEST_HARNESS: 'true', ZENTRA_VERIFY_ONLY: 'false' });
  assert.equal(job.steps[1].when.condition, '<< parameters.package >>');
  assert.equal(job.steps[1].when.steps[0].run.command, './desktop/scripts/cloud-release-windows.ps1 -WindowsAutopilotProductOn');
  assert.equal(job.steps[2].unless.condition, '<< parameters.package >>');
  assert.equal(job.steps[2].unless.steps[0].run.command, './desktop/scripts/cloud-release-windows.ps1 -AutopilotBuildVerificationOnly');
  assert.doesNotMatch(JSON.stringify(job), /context|ZENTRA_A41|ZENTRA_ACTION_NATIVE_TEST|ZENTRA_RUN_LIVE|RUSTFLAGS/);
  for (const name of ['autopilot-windows-build-verification', 'autopilot-windows-release-candidate']) {
    assert.equal(config.workflows[name].jobs.length, 1);
    assert.deepEqual(Object.keys(config.workflows[name].jobs[0]), ['windows-autopilot-product']);
    assert.equal(Object.hasOwn(config.workflows[name].jobs[0]['windows-autopilot-product'], 'context'), false);
  }
});

test('opt-in matrix excludes every private mode, other platform and mixed verification option', () => {
  for (const branch of ['codex/action-engine-native-live-a41', 'main', 'codex/action-engine-native'])
    for (let bits = 0; bits < 128; bits++) for (const platform of ['windows', 'apple', 'android', 'all'])
      for (const diagnostics of ['full', 'action-engine', 'native-mail-payroll']) {
        const parameters = { ...defaults, 'windows-autopilot-product-on': true, platform, 'diagnostics-native-set': diagnostics,
          'verify-only': !!(bits & 1), 'verify-native-profile-only': !!(bits & 2), 'verify-live-profile-only': !!(bits & 4),
          'verify-live-account-only': !!(bits & 8), release: !!(bits & 16), 'smoke-windows-job': bits & 32 ? 1 : 0, 'smoke-apple-job': bits & 64 ? 1 : 0 };
        const actual = active(config, { branch, parameters });
        const admitted = branch === 'codex/action-engine-native-live-a41' && platform === 'windows' && diagnostics === 'full' && (bits & ~16) === 0;
        const expected = admitted ? [parameters.release ? 'autopilot-windows-release-candidate' : 'autopilot-windows-build-verification'] : [];
        assert.deepEqual(actual.filter(name => name.startsWith('autopilot-windows-')), expected);
        assert.ok(!actual.some(name => ['action-live-account-verification', 'action-live-profile-verification', 'action-native-profile-verification'].includes(name)));
        if (branch === 'codex/action-engine-native-live-a41') assert.deepEqual(actual, expected);
        const off = { ...parameters, 'windows-autopilot-product-on': false };
        assert.deepEqual(active(config, { branch, parameters: off }), active(historical, { branch, parameters: off }));
      }
});

test('build-only branch runs OFF9 then ON8+2 and returns before packaging', () => {
  assert.ok(pair.includes('if ($AutopilotBuildVerificationOnly)'));
  assert.ok(pair.includes("Get-ZentraAutopilotProductPlan -TestNames $off.TestNames"));
  assert.ok(pair.includes('$offResult.passed -ne 9'));
  assert.ok(pair.indexOf('$off = Initialize-') < pair.indexOf('$on = Initialize-'));
  assert.match(pair, /\$on = Initialize-ZentraVerificationHarness[^\n]+-WindowsAutopilotProductOn/);
  assert.ok(pair.includes('Get-ZentraWindowsAutopilotProductReceipt $on'));
  assert.ok(pair.includes('$off.Source -cne $on.Source'));
  assert.ok(pair.includes('$off.ExpectedSha256 -ceq $on.ExpectedSha256'));
  assert.ok(pair.includes("autopilot-build/off") && pair.includes("autopilot-build/on"));
  assert.match(pair, /packageBuilt=\$false;serverActivated=\$false;privateProfileUsed=\$false;businessJourneyExecuted=\$false/);
  assert.match(pair, /\n        return\n    }\n$/);
  assert.doesNotMatch(pair, /'tauri'|'build:web'|ZENTRA_RUN_|--ignored|Invoke-WebRequest|paid_consent|reset/i);
  assert.ok(release.indexOf('Assert-ZentraWindowsAutopilotProductEnvironment') < release.indexOf('Invoke-WebRequest'));
});

test('initializer uses a literal feature only on explicit ON; hidden compiler/profile flags refuse', () => {
  assert.match(helper, /\[switch\]\$WindowsAutopilotProductOn/);
  assert.match(helper, /if \(\$WindowsAutopilotProductOn\) \{\n            \$compileArguments \+= @\('--features','quote-autopilot-product'\)/);
  assert.match(helper, /commonPassed=8;onPassed=2;jsonBoundary=\(Get-ZentraWindowsAutopilotJsonReceipt \$Harness 'on'\);offPolicyClaimed=\$false/);
  for (const name of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS', 'CARGO_TARGET_DIR', 'ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON', 'ZENTRA_A41_SITES_SERVICE_TOKEN']) assert.ok(helper.includes(`'${name}'`));
  assert.match(helper, /if \(\$Mode -cne 'release-preflight'/);
  assert.ok(helper.includes('$Harness.Proof.source -cne $Harness.Source'));
  assert.ok(helper.includes('$Harness.Proof.binarySha256After -cne $Harness.ExpectedSha256'));
  assert.ok(helper.includes('$actual.Count -ne $spec[2]'));
});

test('private JSON1 executes exactly once on each OFF/ON binary with separate receipts', () => {
  const name = 'account_cloud::action_engine::supervisor::live_frontdoor::webview_json_cannot_supply_a_native_test_grant';
  for (const build of ['off', 'on']) {
    assert.ok(pair.includes(`Invoke-ZentraVerificationSuite $${build} '${name}' @('--exact','--test-threads=1')`));
  }
  assert.ok(pair.includes("Get-ZentraWindowsAutopilotJsonReceipt $off 'off'"));
  assert.equal(pair.split('autopilot-json-boundary.public.json').length - 1, 2);
  assert.ok(pair.includes('jsonBoundary=$offJson'));
  assert.ok(helper.includes("$execution[0].nativeArguments -join '|') -cne ($name+'|--exact|--test-threads=1')"));
  const native = read('desktop/src-tauri/src/account_cloud_quote_autopilot_live_frontdoor.rs');
  assert.match(native, /fn webview_json_cannot_supply_a_native_test_grant\(\)/);
  assert.match(native, /assert!\(origin.test_frontdoor.is_none\(\)\)/);
  assert.match(native, /assert!\(serde_json::from_value::<Origin>\(invalid\).is_err\(\)\)/);
});

test('future packaging binds the same source/version/feature while retaining its separate app hash', () => {
  const begin = release.indexOf('    if ($script:windowsAutopilotProductOn) {\n        $onReceipt = Get-ZentraWindowsAutopilotProductReceipt');
  const end = release.indexOf('    $version = ', begin);
  const block = release.slice(begin, end > begin ? end : undefined);
  assert.ok(begin > 0);
  assert.match(block, /'tauri', 'build', '--target', 'x86_64-pc-windows-msvc', '--features', 'quote-autopilot-product'/);
  assert.ok(block.includes('$afterPackage = Get-ZentraWindowsAutopilotProductReceipt'));
  assert.ok(block.includes('$onReceipt | ConvertTo-Json'));
  assert.match(release, /\$source -cne \$onReceipt.source -or \$version -cne \$onReceipt.version/);
  assert.ok(release.includes("autopilot-windows-on.public.json"));
  assert.match(release, /files = @\(\$exe, \$setup \| ForEach-Object[^\n]+sha256 = \(Get-FileHash \$_ -Algorithm SHA256\)/);
});
