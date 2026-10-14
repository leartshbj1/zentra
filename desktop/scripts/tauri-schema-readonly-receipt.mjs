// Proposal: observe four tracked Tauri JSON schemas; never restore or edit them.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCHEMA_PATHS = Object.freeze([
  'desktop/src-tauri/gen/schemas/acl-manifests.json',
  'desktop/src-tauri/gen/schemas/capabilities.json',
  'desktop/src-tauri/gen/schemas/desktop-schema.json',
  'desktop/src-tauri/gen/schemas/windows-schema.json',
]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = 'desktop/scripts/tauri-schema-readonly-receipt.mjs';
const MAX = 2 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const SOURCE = /^[a-f0-9]{40}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error(code); };
const keys = (value, expected) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join('|') === [...expected].sort().join('|');

export function describeSchema(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX, 'schema_bytes_refused');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('schema_utf8_refused'); }
  need(!text.startsWith('\ufeff') && !text.includes('\0'), 'schema_utf8_refused');
  const lf = text.replaceAll('\r\n', '\n');
  need(!lf.includes('\r'), 'schema_line_endings_refused');
  const crlf = text.includes('\r\n');
  need(!crlf || !text.replaceAll('\r\n', '').includes('\n'), 'schema_line_endings_refused');
  try {
    const value = JSON.parse(text);
    need(value && typeof value === 'object' && !Array.isArray(value), 'schema_json_refused');
  } catch { throw new Error('schema_json_refused'); }
  return { bytes: bytes.length, sha256: hash(bytes), rawGitBlobSha1: blob(bytes),
    lfSha256: hash(Buffer.from(lf, 'utf8')), lineEndings: crlf ? 'crlf' : text.includes('\n') ? 'lf' : 'none' };
}

function state(source, ports) {
  need(typeof source === 'string' && SOURCE.test(source), 'schema_source_refused');
  need(ports.git(['rev-parse', '--verify', 'HEAD']).toString('utf8').trim() === source, 'schema_source_changed');
  need(ports.git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z', source, '--']).length === 0, 'schema_index_changed');
  const index = ports.git(['ls-files', '--stage', '-z']);
  need(Buffer.isBuffer(index) && index.length > 0 && index.length <= 16 * 1024 * 1024, 'schema_index_refused');
  const tree = ports.git(['ls-tree', '-z', source, '--', ...SCHEMA_PATHS]).toString('utf8');
  const records = tree.split('\0');
  need(records.pop() === '' && records.length === 4, 'schema_tree_refused');
  const rows = records.map(record => {
    const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    need(match && SCHEMA_PATHS.includes(match[2]), 'schema_tree_refused');
    return { path: match[2], gitBlobSha1: match[1] };
  }).sort((a, b) => a.path.localeCompare(b.path));
  need(rows.every((row, index) => row.path === SCHEMA_PATHS[index]), 'schema_tree_refused');
  const status = ports.git(['status', '--porcelain=v1', '-z', '--untracked-files=no']).toString('utf8');
  need(Buffer.byteLength(status) <= 65536 && (status === '' || status.endsWith('\0')), 'schema_status_refused');
  const changed = status === '' ? [] : status.slice(0, -1).split('\0').map(record => {
    need(record.startsWith(' M ') && SCHEMA_PATHS.includes(record.slice(3)), 'schema_status_refused');
    return record.slice(3);
  });
  need(new Set(changed).size === changed.length, 'schema_status_refused');
  return { indexSha256: hash(index), rows, changed: changed.sort() };
}

function observe(rows, ports) {
  return rows.map(row => {
    const gitBytes = ports.git(['cat-file', 'blob', row.gitBlobSha1]);
    const git = describeSchema(gitBytes);
    need(blob(gitBytes) === row.gitBlobSha1, 'schema_blob_refused');
    const raw = ports.read(row.path);
    const current = describeSchema(raw);
    need(current.lfSha256 === git.lfSha256, 'schema_content_changed');
    const byteMatch = current.sha256 === git.sha256 ? 'git-bytes'
      : git.lineEndings === 'lf' && current.lineEndings === 'crlf' ? 'git-LF-to-CRLF' : null;
    need(byteMatch !== null, 'schema_codec_refused');
    return { path: row.path, gitBlobSha1: row.gitBlobSha1, gitBytes: git.bytes,
      gitSha256: git.sha256, gitLineEndings: git.lineEndings, ...current, byteMatch, raw };
  });
}
const publicFile = ({ raw, ...file }) => file;

export function captureWithPorts(source, helperSha256, ports) {
  need(typeof helperSha256 === 'string' && SHA.test(helperSha256), 'schema_helper_refused');
  const first = state(source, ports);
  need(first.changed.length === 0, 'schema_before_dirty');
  const files = observe(first.rows, ports).map(publicFile);
  const last = state(source, ports);
  need(last.changed.length === 0 && last.indexSha256 === first.indexSha256, 'schema_capture_changed');
  need(files.every(file => describeSchema(ports.read(file.path)).sha256 === file.sha256), 'schema_capture_changed');
  return { format: 'zentra-tauri-schema-readonly-baseline-v1', source, helperSha256,
    indexSha256: first.indexSha256, files };
}

export function reconcileWithPorts(source, helperSha256, baseline, ports) {
  need(keys(baseline, ['format', 'source', 'helperSha256', 'indexSha256', 'files'])
    && baseline.format === 'zentra-tauri-schema-readonly-baseline-v1'
    && baseline.source === source && baseline.helperSha256 === helperSha256
    && typeof helperSha256 === 'string' && SHA.test(helperSha256)
    && typeof baseline.indexSha256 === 'string' && SHA.test(baseline.indexSha256)
    && Array.isArray(baseline.files) && baseline.files.length === 4, 'schema_baseline_refused');
  const fileKeys = ['path','gitBlobSha1','gitBytes','gitSha256','gitLineEndings','bytes','sha256','rawGitBlobSha1','lfSha256','lineEndings','byteMatch'];
  baseline.files.forEach((file, index) => {
    need(keys(file, fileKeys) && file.path === SCHEMA_PATHS[index]
      && typeof file.gitBlobSha1 === 'string' && SOURCE.test(file.gitBlobSha1)
      && typeof file.rawGitBlobSha1 === 'string' && SOURCE.test(file.rawGitBlobSha1)
      && ['sha256','gitSha256','lfSha256'].every(key => typeof file[key] === 'string' && SHA.test(file[key]))
      && ['bytes','gitBytes'].every(key => Number.isSafeInteger(file[key]) && file[key] > 0 && file[key] <= MAX)
      && ['lf','crlf','none'].includes(file.gitLineEndings) && ['lf','crlf','none'].includes(file.lineEndings)
      && ['git-bytes','git-LF-to-CRLF'].includes(file.byteMatch), 'schema_baseline_refused');
  });
  const first = state(source, ports);
  need(first.indexSha256 === baseline.indexSha256, 'schema_index_changed');
  const files = observe(first.rows, ports);
  files.forEach((file, index) => need(file.gitBlobSha1 === baseline.files[index].gitBlobSha1
    && file.gitSha256 === baseline.files[index].gitSha256, 'schema_source_changed'));
  const last = state(source, ports);
  need(last.indexSha256 === first.indexSha256 && JSON.stringify(last.changed) === JSON.stringify(first.changed), 'schema_capture_changed');
  need(files.every(file => describeSchema(ports.read(file.path)).sha256 === file.sha256), 'schema_capture_changed');
  return { receipt: { format: 'zentra-tauri-schema-readonly-receipt-v1', source, helperSha256,
    indexSha256: first.indexSha256, indexMatchesSourceBeforeAndAfter: true,
    trackedCleanBefore: true, trackedCleanAfter: last.changed.length === 0,
    observedModifiedPaths: last.changed,
    rawChangedPaths: files.filter((file, i) => file.sha256 !== baseline.files[i].sha256).map(file => file.path),
    files: files.map((file, index) => ({ ...publicFile(file), before: baseline.files[index] })),
    schemasRestored: false, schemasWritten: false, contentMatchesGit: true,
    packageVerified: false, nativeExecutedByObserver: false }, files: files.map(file => ({ path: file.path, bytes: file.raw })) };
}

function adapter(source) {
  need(process.env.CIRCLECI === 'true' && process.env.OS === 'Windows_NT'
    && process.env.CIRCLE_JOB === 'windows-autopilot-product'
    && process.env.CIRCLE_BRANCH === 'codex/action-engine-native-live-a41'
    && process.env.CIRCLE_SHA1 === source && process.env.ZENTRA_RELEASE_TEST_HARNESS === 'true', 'schema_ci_required');
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  const safeFile = relative => {
    let current = ROOT;
    for (const part of ['', ...relative.split('/')]) {
      if (part) current = path.join(current, part);
      const stat = fs.lstatSync(current);
      need(!stat.isSymbolicLink() && fs.realpathSync(current).toLowerCase() === current.toLowerCase(), 'schema_file_refused');
    }
    const stat = fs.statSync(current);
    need(stat.isFile() && stat.size > 0 && stat.size <= MAX, 'schema_file_refused');
    const bytes = fs.readFileSync(current);
    need(bytes.length === stat.size, 'schema_file_refused');
    return bytes;
  };
  return { read: safeFile, git(args) {
    try { return execFileSync('git', ['--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false',...args],
      { cwd: ROOT, env, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore','pipe','pipe'] }); }
    catch { throw new Error('schema_git_refused'); }
  } };
}

function main(args) {
  const [phase, source, baselinePath, baselineSha256] = args;
  need((phase === 'before' && args.length === 2) || (phase === 'after' && args.length === 4), 'schema_arguments_refused');
  need(typeof source === 'string' && SOURCE.test(source), 'schema_source_refused');
  const ports = adapter(source), helperBytes = ports.read(HELPER), helperSha256 = hash(helperBytes);
  const helperTree = ports.git(['ls-tree', '-z', source, '--', HELPER]).toString('utf8');
  const helperRow = /^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(helperTree);
  need(helperRow && helperRow[2] === HELPER, 'schema_helper_refused');
  const helperGit = ports.git(['cat-file', 'blob', helperRow[1]]);
  need(blob(helperGit) === helperRow[1]
    && (helperBytes.equals(helperGit) || (!helperGit.includes(13)
      && helperBytes.equals(Buffer.from(helperGit.toString('utf8').replaceAll('\n', '\r\n'))))), 'schema_helper_refused');
  if (phase === 'before') return process.stdout.write(JSON.stringify(captureWithPorts(source, helperSha256, ports)) + '\n');
  need(typeof baselineSha256 === 'string' && SHA.test(baselineSha256), 'schema_baseline_refused');
  const base = path.join(ROOT, 'desktop/artifacts/windows/tauri-schema-before.public.json');
  need(path.resolve(baselinePath) === base, 'schema_baseline_path_refused');
  const bytes = ports.read('desktop/artifacts/windows/tauri-schema-before.public.json');
  need(bytes.length <= 32768 && hash(bytes) === baselineSha256, 'schema_baseline_hash_refused');
  let baseline;
  try { baseline = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('schema_baseline_refused'); }
  const result = reconcileWithPorts(source, helperSha256, baseline, ports);
  const output = path.join(ROOT, 'desktop/artifacts/windows/tauri-schemas');
  // A new artifact folder only. The four source schemas are never written.
  need(!fs.existsSync(output), 'schema_artifacts_exist');
  fs.mkdirSync(output);
  for (const file of result.files) {
    const target = path.join(output, path.basename(file.path));
    fs.writeFileSync(target, file.bytes, { flag: 'wx' });
    need(fs.readFileSync(target).equals(file.bytes), 'schema_artifact_hash_refused');
  }
  fs.writeFileSync(path.join(output, 'receipt.public.json'), JSON.stringify(result.receipt, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ format: result.receipt.format, source, files: 4, passed: true }) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(/^schema_[a-z_]+$/.test(error?.message) ? error.message + '\n' : 'schema_observation_refused\n'); process.exitCode = 1; }
}
