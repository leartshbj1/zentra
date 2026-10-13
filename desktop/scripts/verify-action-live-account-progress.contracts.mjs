// Pure manual contracts: no native process, HTTP, Cargo or CI entrypoint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateNativeProgress, runLiveSessionRegressions, SESSION_REGRESSION_TESTS } from './verify-action-live-account-windows.mjs';

for (const name of ['ZENTRA_A41_SITES_SERVICE_TOKEN', 'ZENTRA_A41_BROWSER_COOKIE_QA']) {
  if (process.env[name]) throw new Error('private_environment_refused');
}
if (process.env.CIRCLECI === 'true') throw new Error('manual_contracts_only');
let checks = 0;
const ok = fn => { fn(); checks++; };
const no = fn => ok(() => assert.throws(fn));
const sequences = {
  enroll: [...[0, 1].flatMap(index => ['initialize_store', 'start_link', 'pending_poll', 'approved_poll'].map(step => ({ step, index }))),
    ...[0, 1].map(index => ({ step: 'verify_native_proof', index }))],
  reopen: [...[0, 1].flatMap(index => ['retained_store', 'initialize_store', 'verify_native_proof'].map(step => ({ step, index })))],
};
for (const [phase, sequence] of Object.entries(sequences)) {
  sequence.forEach(({ step, index }, position) => {
    const event = { event: 'progress', phase, step, index };
    ok(() => assert.equal(validateNativeProgress(event, phase, position), `native_${phase}_${step}_${index}`));
    for (const [field, value] of [['event', 'complete'], ['phase', 'other'], ['step', 'token-secret'], ['index', String(index)], ['index', 2]]) {
      no(() => validateNativeProgress({ ...event, [field]: value }, phase, position));
    }
    for (const field of Object.keys(event)) {
      const missing = { ...event }; delete missing[field];
      no(() => validateNativeProgress(missing, phase, position));
    }
    no(() => validateNativeProgress({ ...event, secret: 'not-allowed' }, phase, position));
    for (const wrong of [-1, NaN, Infinity, position + 0.5, sequence.length, '0']) no(() => validateNativeProgress(event, phase, wrong));
    const otherPosition = (position + 1) % sequence.length;
    no(() => validateNativeProgress(event, phase, otherPosition));
  });
  for (const malformed of [null, [], 'progress', {}, { event: 'progress' }]) no(() => validateNativeProgress(malformed, phase, 0));
}
for (const phase of ['other', '__proto__', 'constructor', '', null, undefined]) {
  no(() => validateNativeProgress({ event: 'progress', phase, step: 'initialize_store', index: 0 }, phase, 0));
}
const rust = fs.readFileSync(fileURLToPath(new URL('../src-tauri/src/account_cloud_live_a41_tests.rs', import.meta.url)), 'utf8');
for (const [phase, sequence] of Object.entries(sequences)) {
  for (const step of new Set(sequence.map(value => value.step))) {
    ok(() => assert(rust.includes(`pipe.progress("${phase}", "${step}", index)?;`)));
  }
}
const coordinator = fs.readFileSync(fileURLToPath(new URL('./verify-action-live-account-windows.mjs', import.meta.url)), 'utf8');
ok(() => assert(coordinator.includes('progressCount === NATIVE_PROGRESS[phase].length')));
ok(() => assert(coordinator.includes("['private_protocol_failed', 'private_protocol_timeout'].includes(error?.code)")));
ok(() => assert(!coordinator.includes('process.stdout.write(stderr)') && !coordinator.includes('process.stderr.write(stderr)')));
ok(() => assert.equal(SESSION_REGRESSION_TESTS.length, 3));
await assert.rejects(runLiveSessionRegressions, error => ['explicit_ci_admission_required', 'windows_ci_required'].includes(error?.code)); checks++;
console.log(JSON.stringify({ kind: 'a41-native-closed-progress-contracts', passed: true, checks,
  nativeExecuted: false, networkExecuted: false, ciExecuted: false }));
