/** Local form recovery only: no backend calls, queued mutations or credentials. */
import { recordDiagnostic } from './diagnostics';
export const FORM_DRAFT_VERSION = 1;
export const FORM_DRAFT_PREFIX = 'zentra.forms.drafts.v1.';
export const FORM_DRAFT_COMPLETED_PREFIX = 'zentra.forms.completed.v1.';
export const FORM_DRAFT_MAX_ENTRIES = 40;
export const FORM_DRAFT_MAX_BYTES = 2_000_000;
export const FORM_DRAFT_MAX_ENTRY_BYTES = 256_000;
export const FORM_DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export type FormDraftScope = { companyId: string; organizationId?: string; memberId?: string; type: string; recordId?: string; context?: string };
export type FormDraftRecord<T> = { version: number; scope: string; fingerprint: string; savedAt: number; value: T };
export type FormDraftSnapshot<T> = { value: T; pending: FormDraftRecord<T> | null; dirty: boolean; conflict: boolean; storageError: boolean; invalid: boolean; completedResidual: boolean; completionProtected: boolean; savedAt: number | null };
export type FormDraftOptions<T> = { scope: FormDraftScope | null; initial: T; fingerprint: string; validate: (value: unknown) => value is T; storage?: () => DraftStorage; now?: () => number };

export function formDraftKey(scope: FormDraftScope): string {
  return FORM_DRAFT_PREFIX + encodeURIComponent(JSON.stringify([scope.companyId, scope.organizationId || '', scope.memberId || 'local', scope.type, scope.recordId || 'new', scope.context || '']));
}
export function formDraftFingerprint(value: unknown): string {
  const canonical = (v: unknown): string => v && typeof v === 'object'
    ? Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${canonical((v as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(v) ?? 'null';
  const text = canonical(value); let a = 2166136261, b = 5381;
  for (let index = 0; index < text.length; index++) { a = Math.imul(a ^ text.charCodeAt(index), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(index); }
  return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${text.length}`;
}
export function draftObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function draftStrings(value: unknown, fields: readonly string[], maxLength = 10_000): value is Record<string, string> {
  return draftObject(value) && fields.every(field => typeof value[field] === 'string' && (value[field] as string).length <= maxLength);
}
function safeData(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every(row => safeData(row, depth + 1));
  return draftObject(value) && Object.keys(value).length <= 2_000 && Object.entries(value).every(([key, row]) =>
    !/(?:password|passwd|secret|token|api.?key|private.?key|credential|__proto__|constructor|prototype)/i.test(key) && safeData(row, depth + 1));
}
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const completedRecords = new Map<string, string>();
const completedKey = (key: string) => key.replace(FORM_DRAFT_PREFIX, FORM_DRAFT_COMPLETED_PREFIX);
const log = (operation: string, phase: 'success' | 'failure' | 'info', storage = false) => recordDiagnostic({ area: 'draft', operation: `form.${operation}`, phase, ...(storage ? { errorCode: 'STORAGE' } : {}) });

/** Synchronous capture is intentional: even the final keystroke survives immediate dismissal. */
export class FormDraftSession<T> {
  private options: FormDraftOptions<T>;
  private key: string | null;
  private originalFingerprint: string;
  private loggedConflict = false;
  private snapshot: FormDraftSnapshot<T>;
  constructor(options: FormDraftOptions<T>) {
    this.options = options; this.key = options.scope ? formDraftKey(options.scope) : null;
    this.originalFingerprint = options.fingerprint;
    this.snapshot = { value: copy(options.initial), pending: null, dirty: false, conflict: false, storageError: !this.key, invalid: false, completedResidual: false, completionProtected: true, savedAt: null };
    if (!this.key) return;
    try {
      const raw = this.storage().getItem(this.key);
      if (!raw) return;
      const hash = formDraftFingerprint(raw);
      const marker = this.storage().getItem(completedKey(this.key));
      let acknowledged = completedRecords.get(this.key) === hash;
      if (marker) try { const data: unknown = JSON.parse(marker); acknowledged ||= draftObject(data) && data.version === FORM_DRAFT_VERSION && data.recordFingerprint === hash; } catch { /* Invalid marker is never treated as acknowledgement. */ }
      if (acknowledged) { this.snapshot.completedResidual = true; log('completed_residual', 'info'); return; }
      if (raw.length * 2 > FORM_DRAFT_MAX_ENTRY_BYTES) { this.snapshot.invalid = true; log('invalid_size', 'failure', true); return; }
      let record: unknown;
      try { record = JSON.parse(raw); }
      catch { this.snapshot.invalid = true; log('invalid_format', 'failure'); return; }
      if (draftObject(record) && record.version === FORM_DRAFT_VERSION && record.scope === this.key && record.acknowledged === true) {
        this.snapshot.completedResidual = true; log('completed_residual', 'info'); return;
      }
      if (!draftObject(record) || record.version !== FORM_DRAFT_VERSION || record.scope !== this.key ||
        typeof record.fingerprint !== 'string' || record.fingerprint.length > 120 || typeof record.savedAt !== 'number' ||
        !Number.isFinite(record.savedAt) || record.savedAt > this.now() + 60_000 || this.now() - record.savedAt > FORM_DRAFT_MAX_AGE ||
        !safeData(record.value) || !options.validate(record.value)) { this.snapshot.invalid = true; log('invalid_record', 'failure'); return; }
      this.snapshot.pending = record as FormDraftRecord<T>;
      this.snapshot.conflict = record.fingerprint !== options.fingerprint;
      log('available', 'info');
      if (this.snapshot.conflict) { this.loggedConflict = true; log('conflict', 'info'); }
    } catch { this.snapshot.storageError = true; log('local_read', 'failure', true); }
  }
  private storage() { return this.options.storage ? this.options.storage() : localStorage; }
  private now() { return this.options.now?.() ?? Date.now(); }
  getSnapshot = () => this.snapshot;
  updateOptions(options: FormDraftOptions<T>) {
    this.options = options;
    if (this.hasConflict() && !this.loggedConflict) { this.loggedConflict = true; log('conflict', 'info'); }
  }
  capture(value: T) {
    if (!this.snapshot.dirty) log('edited', 'info');
    this.snapshot = { ...this.snapshot, value, dirty: true };
    if (this.snapshot.pending) return; // Require an explicit choice before replacing an older local draft.
    this.persist();
  }
  private persist() {
    const wasFailed = this.snapshot.storageError, wasSaved = this.snapshot.savedAt !== null;
    if (!this.key || !safeData(this.snapshot.value) || !this.options.validate(this.snapshot.value)) {
      this.snapshot = { ...this.snapshot, storageError: true }; if (!wasFailed) log('local_save', 'failure', true); return;
    }
    try {
      const storage = this.storage(), now = this.now();
      const record: FormDraftRecord<T> = { version: FORM_DRAFT_VERSION, scope: this.key, fingerprint: this.originalFingerprint, savedAt: now, value: this.snapshot.value };
      const raw = JSON.stringify(record);
      if (raw.length * 2 > FORM_DRAFT_MAX_ENTRY_BYTES) throw Error('Draft too large');
      let count = 0, bytes = raw.length * 2;
      const expired: string[] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index); if (!key?.startsWith(FORM_DRAFT_PREFIX) || key === this.key) continue;
        const other = storage.getItem(key) || '';
        try { const row: unknown = JSON.parse(other); if (draftObject(row) && typeof row.savedAt === 'number' && now - row.savedAt > FORM_DRAFT_MAX_AGE) { expired.push(key); continue; } } catch { /* Keep unknown entries; never erase another active form. */ }
        count++; bytes += (key.length + other.length) * 2;
      }
      if (count >= FORM_DRAFT_MAX_ENTRIES || bytes > FORM_DRAFT_MAX_BYTES) throw Error('Draft capacity reached');
      storage.setItem(this.key, raw);
      if (storage.getItem(this.key) !== raw) throw Error('Draft storage did not retain data');
      completedRecords.delete(this.key);
      try { storage.removeItem(completedKey(this.key)); } catch { /* A marker matches only its exact old record. */ }
      for (const key of expired) storage.removeItem(key);
      this.snapshot = { ...this.snapshot, savedAt: now, storageError: false, invalid: false, completedResidual: false, conflict: this.originalFingerprint !== this.options.fingerprint };
      if (!wasSaved || wasFailed) log('local_save', 'success');
    } catch { this.snapshot = { ...this.snapshot, storageError: true }; if (!wasFailed) log('local_save', 'failure', true); }
  }
  restore() {
    const record = this.snapshot.pending; if (!record) return;
    this.originalFingerprint = record.fingerprint;
    this.snapshot = { ...this.snapshot, value: copy(record.value), pending: null, dirty: true, savedAt: record.savedAt, conflict: record.fingerprint !== this.options.fingerprint };
    log('resumed', 'info');
  }
  /** Called only after an explicit user choice to keep the displayed local values. */
  keepLocal() { this.originalFingerprint = this.options.fingerprint; this.loggedConflict = false; this.snapshot = { ...this.snapshot, conflict: false, dirty: true }; log('kept_local', 'info'); this.persist(); }
  reset() {
    if (!this.remove()) { log('discarded', 'failure', true); return; }
    this.originalFingerprint = this.options.fingerprint;
    this.loggedConflict = false;
    this.snapshot = { ...this.snapshot, value: copy(this.options.initial), pending: null, dirty: false, conflict: false, invalid: false, completedResidual: false, savedAt: null }; log('discarded', 'success');
  }
  private remove() {
    if (!this.key) return true;
    try { const storage = this.storage(); storage.removeItem(this.key); if (storage.getItem(this.key) !== null) throw Error('Draft was not removed'); try { storage.removeItem(completedKey(this.key)); } catch { /* A marker without its draft cannot resume anything. */ } completedRecords.delete(this.key); return true; }
    catch { this.snapshot = { ...this.snapshot, storageError: true }; return false; }
  }
  complete(saved: boolean) {
    if (saved !== true) { log('submitted', 'failure'); return; }
    log('submitted', 'success');
    let protectedCompletion = false;
    if (this.key) try {
      const storage = this.storage(), raw = storage.getItem(this.key);
      if (raw) {
        const recordFingerprint = formDraftFingerprint(raw); completedRecords.set(this.key, recordFingerprint);
        if (completedRecords.size > FORM_DRAFT_MAX_ENTRIES) completedRecords.delete(completedRecords.keys().next().value!);
        let markerCount = 0;
        for (let index = 0; index < storage.length; index++) if (storage.key(index)?.startsWith(FORM_DRAFT_COMPLETED_PREFIX)) markerCount++;
        if (markerCount >= FORM_DRAFT_MAX_ENTRIES && !storage.getItem(completedKey(this.key))) throw Error('Acknowledgement capacity reached');
        const marker = JSON.stringify({ version: FORM_DRAFT_VERSION, savedAt: this.now(), recordFingerprint });
        storage.setItem(completedKey(this.key), marker);
        protectedCompletion = storage.getItem(completedKey(this.key)) === marker;
      }
    } catch { /* Deletion may still succeed; an in-memory marker also prevents reusing the old draft in this process. */ }
    const removed = this.remove();
    // Replacing a large old draft with a tiny acknowledgement can still work at quota.
    if (!removed && !protectedCompletion && this.key) try {
      const storage = this.storage(), marker = JSON.stringify({ version: FORM_DRAFT_VERSION, scope: this.key, acknowledged: true, savedAt: this.now() });
      storage.setItem(this.key, marker); protectedCompletion = storage.getItem(this.key) === marker;
    } catch { /* Report the inability to retain the acknowledgement instead of promising protection after restart. */ }
    this.snapshot = { ...this.snapshot, dirty: false, pending: null, conflict: false, completedResidual: !removed, completionProtected: removed || protectedCompletion, savedAt: null };
    log('completed', removed ? 'success' : 'failure', !removed);
  }
  retryStorage() { if (this.snapshot.dirty) this.persist(); }
  needsCloseConfirmation() { return this.snapshot.dirty && this.snapshot.storageError; }
  hasConflict() { return this.snapshot.conflict || this.originalFingerprint !== this.options.fingerprint; }
}
