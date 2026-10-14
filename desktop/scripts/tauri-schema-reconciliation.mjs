// Dedicated G4 CI only. Tauri may regenerate these tracked, non-executable
// schemas during compilation. Never reconcile Rust, index entries or any other
// path. The original postcompile clean-source and binary guards still apply.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertDedicatedAdmission, compileEnvironment } from './verify-action-live-account-ci-windows.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = 'desktop/scripts/tauri-schema-reconciliation.mjs';
export const TAURI_SCHEMA_PATHS = Object.freeze([
  'desktop/src-tauri/gen/schemas/acl-manifests.json',
  'desktop/src-tauri/gen/schemas/capabilities.json',
  'desktop/src-tauri/gen/schemas/desktop-schema.json',
  'desktop/src-tauri/gen/schemas/windows-schema.json',
]);
const SOURCE = /^[a-f0-9]{40}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const need = (ok, code) => { if (!ok) throw new Refusal(code); };
const safeRelative = value => typeof value === 'string' && value.length <= 240 && value.split('/').every(
  part => /^[A-Za-z0-9._-]{1,80}$/.test(part) && part !== '.' && part !== '..' && part !== '.git');

// Failure metadata only: omit unsafe/unknown names, never copy raw Git output.
// The production port corroborates each retained name in the captured source.
export function describeTauriSchemaRefusal(status, ports) {
  if (typeof status !== 'string' || Buffer.byteLength(status) > 65536) return { files: [], omitted: true };
  const records = status.split('\0').filter(Boolean), files = [], seen = new Set();
  let omitted = false;
  for (const record of records) {
    const relative = record.slice(3);
    if (files.length >= 16 || !/^[ MADRCUT?!]{2} /.test(record) || !safeRelative(relative) || seen.has(relative)) { omitted = true; continue; }
    seen.add(relative);
    try {
      if (!ports.trackedAtSource(relative)) { omitted = true; continue; }
      const value = ports.inspect(relative);
      need(value && ['file', 'directory', 'link', 'missing', 'other'].includes(value.kind), 'tauri_schema_file_refused');
      const bytes = Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? value.bytes : null;
      const sha256 = value.kind === 'file' && bytes !== null && bytes <= MAX_FILE_BYTES
        && typeof value.sha256 === 'string' && SHA.test(value.sha256) ? value.sha256 : null;
      files.push({ path: relative, change: record[0] !== ' ' ? 'indexed' : record[1] === 'M' ? 'modified'
        : record[1] === 'D' ? 'deleted' : record[1] === 'T' ? 'type_changed' : 'other', kind: value.kind, bytes, sha256 });
    } catch { omitted = true; }
  }
  return { files, omitted };
}

export function modifiedTauriSchemas(status) {
  need(typeof status === 'string' && Buffer.byteLength(status) <= 65536, 'tauri_schema_status_refused');
  if (status === '') return [];
  need(status.endsWith('\0'), 'tauri_schema_status_refused');
  const paths = status.slice(0, -1).split('\0').map(record => {
    // Only unstaged regular-file modifications. Index/deletion/rename/type
    // changes, unmerged entries and extra rename records cannot pass.
    need(record.startsWith(' M ') && TAURI_SCHEMA_PATHS.includes(record.slice(3)), 'tauri_schema_status_refused');
    return record.slice(3);
  });
  need(new Set(paths).size === paths.length, 'tauri_schema_status_refused');
  return paths.sort();
}

function trackedSchemas(text) {
  need(typeof text === 'string' && text.endsWith('\0') && Buffer.byteLength(text) <= 4096, 'tauri_schema_tracked_refused');
  const rows = text.slice(0, -1).split('\0').map(record => {
    const match = /^100644 ([a-f0-9]{40}) 0\t(.+)$/.exec(record);
    need(match && TAURI_SCHEMA_PATHS.includes(match[2]), 'tauri_schema_tracked_refused');
    return { path: match[2], gitBlobSha1: match[1] };
  }).sort((a, b) => a.path.localeCompare(b.path));
  need(rows.length === TAURI_SCHEMA_PATHS.length && rows.every((row, i) => row.path === TAURI_SCHEMA_PATHS[i]), 'tauri_schema_tracked_refused');
  return rows;
}

// Pure port composition for unit tests. The production adapter below fixes the
// repository, CI admission, environment and filesystem; no CLI or HTTP selector.
export function captureTauriSchemasWithPorts(source, helperSha256, ports) {
  need(typeof source === 'string' && SOURCE.test(source) && typeof helperSha256 === 'string' && SHA.test(helperSha256), 'tauri_schema_source_refused');
  const readState = () => {
    need(ports.git(['rev-parse', '--verify', 'HEAD']).trim() === source, 'tauri_schema_source_changed');
    need(ports.git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z', source, '--']) === '', 'tauri_schema_index_changed');
    return trackedSchemas(ports.git(['ls-files', '--stage', '-z', '--', ...TAURI_SCHEMA_PATHS]));
  };
  const snapshot = () => TAURI_SCHEMA_PATHS.map(relative => {
    const value = ports.snapshot(relative);
    need(value && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= MAX_FILE_BYTES
      && typeof value.sha256 === 'string' && SHA.test(value.sha256), 'tauri_schema_file_refused');
    return { path: relative, bytes: value.bytes, sha256: value.sha256 };
  });
  const trackedBefore = readState();
  need(ports.git(['status', '--porcelain=v1', '-z', '--untracked-files=no']) === '', 'tauri_schema_precompile_dirty');
  const before = snapshot();
  let consumed = false;
  return Object.freeze({
    reconcile() {
      need(!consumed, 'tauri_schema_baseline_consumed');
      consumed = true;
      let phase = 'postcompile_source';
      try {
      const trackedAfter = readState();
      need(JSON.stringify(trackedAfter) === JSON.stringify(trackedBefore), 'tauri_schema_index_changed');
      phase = 'postcompile_status';
      const statusPaths = modifiedTauriSchemas(ports.git(['status', '--porcelain=v1', '-z', '--untracked-files=no']));
      phase = 'postcompile_files';
      const postcompile = snapshot();
      // Include raw byte drift even when checkout line-ending normalization
      // makes it invisible to porcelain. Only the same four paths are eligible.
      const modifiedPaths = TAURI_SCHEMA_PATHS.filter((relative, index) => statusPaths.includes(relative)
        || before[index].sha256 !== postcompile[index].sha256 || before[index].bytes !== postcompile[index].bytes);
      phase = 'before_restore_source';
      readState();
      phase = 'restore';
      if (modifiedPaths.length) ports.git(['restore', `--source=${source}`, '--worktree', '--', ...modifiedPaths]);
      phase = 'postrestore_files';
      const restored = snapshot();
      need(restored.every((file, index) => file.sha256 === before[index].sha256 && file.bytes === before[index].bytes), 'tauri_schema_restore_hash_refused');
      phase = 'postrestore_source';
      need(JSON.stringify(readState()) === JSON.stringify(trackedBefore), 'tauri_schema_index_changed');
      phase = 'postrestore_status';
      need(ports.git(['status', '--porcelain=v1', '-z', '--untracked-files=no']) === '', 'tauri_schema_postcompile_dirty');
      return Object.freeze({
        format: 'zentra-a41-tauri-schema-reconciliation-v1', source, helperSha256,
        phases: ['precompile_clean', 'postcompile_observed', 'restored_clean'],
        trackedCleanBefore: true, indexMatchesSourceBeforeAndAfter: true, trackedCleanAfter: true,
        modifiedPaths, restoredPaths: [...modifiedPaths],
        files: before.map((file, index) => ({ path: file.path, gitBlobSha1: trackedBefore[index].gitBlobSha1,
          beforeSha256: file.sha256, postcompileSha256: postcompile[index].sha256, restoredSha256: restored[index].sha256,
          beforeBytes: file.bytes, postcompileBytes: postcompile[index].bytes, restoredBytes: restored[index].bytes })),
      });
      } catch (error) {
        const refusal = error instanceof Refusal ? error : new Refusal('tauri_schema_reconciliation_refused');
        refusal.phase = phase;
        throw refusal;
      }
    },
  });
}

export function captureTauriSchemaReconciliation(environment) {
  assertDedicatedAdmission(environment);
  // The dedicated G4 caller has already removed private variables. Git receives
  // only the existing public compiler allowlist, never the parent environment.
  const publicEnvironment = compileEnvironment(environment);
  const git = args => {
    try {
      return execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
        cwd: ROOT, env: publicEnvironment, encoding: 'utf8', windowsHide: true, timeout: 30000,
        maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { throw new Refusal('tauri_schema_git_refused'); }
  };
  const samePath = (a, b) => a.toLowerCase() === b.toLowerCase();
  const snapshot = relative => {
    try {
      const file = path.join(ROOT, relative);
      // Reject external parent links and a symlink/reparse leaf before content.
      let current = ROOT;
      need(samePath(fs.realpathSync(ROOT), ROOT), 'tauri_schema_file_refused');
      for (const part of relative.split('/').slice(0, -1)) {
        current = path.join(current, part);
        const stat = fs.lstatSync(current);
        need(stat.isDirectory() && !stat.isSymbolicLink() && samePath(fs.realpathSync(current), current), 'tauri_schema_file_refused');
      }
      const stat = fs.lstatSync(file);
      need(stat.isFile() && !stat.isSymbolicLink() && samePath(fs.realpathSync(file), file)
        && stat.size > 0 && stat.size <= MAX_FILE_BYTES, 'tauri_schema_file_refused');
      const bytes = fs.readFileSync(file);
      need(bytes.length === stat.size, 'tauri_schema_file_refused');
      return { bytes: bytes.length, sha256: hash(bytes) };
    } catch { throw new Refusal('tauri_schema_file_refused'); }
  };
  let helper;
  try { helper = fs.readFileSync(path.join(ROOT, HELPER)); }
  catch { throw new Refusal('tauri_schema_helper_refused'); }
  need(helper.length > 0 && helper.length <= 128 * 1024, 'tauri_schema_helper_refused');
  const source = environment.CIRCLE_SHA1, helperSha256 = hash(helper);
  const baseline = captureTauriSchemasWithPorts(source, helperSha256, { git, snapshot });
  let failureReceipt;
  return Object.freeze({
    reconcile() {
      try { return baseline.reconcile(); }
      catch (error) {
        let observed = { files: [], omitted: true };
        try {
          observed = describeTauriSchemaRefusal(git(['status', '--porcelain=v1', '-z', '--untracked-files=no']), {
            trackedAtSource(relative) {
              const row = git(['ls-tree', '-z', source, '--', relative]);
              return /^(?:100644|100755|120000) blob [a-f0-9]{40}\t/.test(row)
                && row.slice(row.indexOf('\t') + 1) === relative + '\0';
            },
            inspect(relative) {
              const file = path.join(ROOT, relative);
              let current = ROOT;
              if (fs.lstatSync(ROOT).isSymbolicLink() || !samePath(fs.realpathSync(ROOT), ROOT)) return { kind: 'link' };
              for (const part of relative.split('/').slice(0, -1)) {
                current = path.join(current, part);
                const parent = fs.lstatSync(current);
                if (parent.isSymbolicLink() || !samePath(fs.realpathSync(current), current)) return { kind: 'link' };
              }
              let stat;
              try { stat = fs.lstatSync(file); } catch (failure) {
                if (failure?.code === 'ENOENT') return { kind: 'missing' };
                return { kind: 'other' };
              }
              if (stat.isSymbolicLink() || !samePath(fs.realpathSync(file), file)) return { kind: 'link' };
              if (!stat.isFile()) return { kind: stat.isDirectory() ? 'directory' : 'other' };
              return { kind: 'file', bytes: stat.size, sha256: stat.size <= MAX_FILE_BYTES ? hash(fs.readFileSync(file)) : null };
            },
          });
        } catch { /* Closed failure metadata must never replace the refusal. */ }
        const refusal = error instanceof Refusal ? error : new Refusal('tauri_schema_reconciliation_refused');
        failureReceipt = { format: 'zentra-a41-tauri-schema-reconciliation-refusal-v1', source, helperSha256,
          passed: false, phase: refusal.phase ?? 'postcompile_source', code: refusal.code,
          observedFiles: observed.files, observationOmitted: observed.omitted };
        throw refusal;
      }
    },
    failureReceipt() { return failureReceipt; },
  });
}
