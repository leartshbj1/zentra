import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Reproduce the local mixed-deployment proof without copying old production
// code into the application. The baseline is immutable Git source, not a mock.
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = '534d61da0a85a9c335f04f5035aea63d3a52ff29';
const path = 'lib/business-sync-transaction-review.ts';
const old = execFileSync('git', ['show', `${baseline}:${path}`], { cwd: root, encoding: 'utf8' });
const current = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
for (const source of [old, current]) {
  if (!/APPLY_CHANGES = 12;/.test(source) || !/TRANSACTION_REVIEW_VERSION = 4;/.test(source))
    throw new Error('This proof requires the unchanged V4/12 contract ceiling.');
}
if (!/const EXECUTION_APPLY_CHANGES = 8;/.test(current))
  throw new Error('The current execution bound must be eight for this proof.');
const directory = new URL('../.qa/us-workspace-admission/review-v4-runtime/', import.meta.url);
mkdirSync(directory, { recursive: true });
const imports = source => source.replace(/from '\.\/([^']+)'/g, "from '@/lib/$1'")
  .replace(/from '\.\.\/desktop\//g, "from '@/desktop/");
const sources = { 'head12.ts': imports(old), 'runtime8.ts': imports(current) };
for (const [name, source] of Object.entries(sources))
  writeFileSync(new URL(name, directory), source);
const digest = source => createHash('sha256').update(source).digest('hex');
writeFileSync(new URL('source-manifest.json', directory), JSON.stringify({
  baseline, path, baselineSha256: digest(old), currentSha256: digest(current),
  scope: 'Disposable local CH fixtures; no US admission or native physical-device evidence.',
  files: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, digest(source)])),
}, null, 2));
console.log('Created pinned V4/12 and current V4/runtime8 fixtures for ZENTRA_V4_RUNTIME_PROOF=1.');
