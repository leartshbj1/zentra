import { describe, expect, it, vi } from 'vitest';
import { FORM_DRAFT_COMPLETED_PREFIX, FORM_DRAFT_MAX_AGE, FORM_DRAFT_MAX_ENTRIES, FORM_DRAFT_PREFIX, FORM_DRAFT_VERSION, FormDraftSession, draftStrings, formDraftFingerprint, formDraftKey, type DraftStorage, type FormDraftScope } from './formDrafts';
import { recentDiagnosticEvents } from './diagnostics';
import { initialDocumentFormDraft, validDocumentFormDraft } from './documentFormDraft';
import { initialOnboardingSettings } from './onboardingDraft';

class MemoryStorage implements DraftStorage {
  rows = new Map<string, string>(); failRead = false; failWrite = false; failRemove = false; silentWrite = false;
  get length() { return this.rows.size; }
  key(index: number) { return [...this.rows.keys()][index] ?? null; }
  getItem(key: string) { if (this.failRead) throw Error('blocked'); return this.rows.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrite) throw Error('quota'); if (!this.silentWrite) this.rows.set(key, value); }
  removeItem(key: string) { if (this.failRemove) throw Error('blocked'); this.rows.delete(key); }
}
const scope: FormDraftScope = { companyId: 'company-a', memberId: 'member-a', type: 'client', recordId: 'row-a' };
const initial = { name: 'Serveur', note: '' };
const validate = (value: unknown): value is typeof initial => draftStrings(value, ['name', 'note']) && Object.keys(value).length === 2;
const now = 1_790_000_000_000;
function options(storage: MemoryStorage, overrides = {}) { return { scope, initial, fingerprint: formDraftFingerprint(initial), validate, storage: () => storage, now: () => now, ...overrides }; }

describe('local form recovery', () => {
  it('retains the final keystroke before immediate close and requires explicit resume after restart', () => {
    const storage = new MemoryStorage(), first = new FormDraftSession(options(storage));
    first.capture({ name: 'Dernière frappe é', note: 'Sans délai' });
    expect(first.needsCloseConfirmation()).toBe(false);
    const restarted = new FormDraftSession(options(storage));
    expect(restarted.getSnapshot().value).toEqual(initial);
    expect(restarted.getSnapshot().pending?.value.name).toBe('Dernière frappe é');
    restarted.restore();
    expect(restarted.getSnapshot().value).toEqual({ name: 'Dernière frappe é', note: 'Sans délai' });
    expect(restarted.getSnapshot().dirty).toBe(true);
  });
  it('clears only a confirmed success and retains false/uncertain failures', () => {
    const storage = new MemoryStorage(), session = new FormDraftSession(options(storage));
    session.capture({ name: 'Modifié', note: 'À conserver' });
    session.complete(false);
    expect(new FormDraftSession(options(storage)).getSnapshot().pending?.value.note).toBe('À conserver');
    session.complete(true);
    expect(storage.getItem(formDraftKey(scope))).toBeNull();
    expect(new FormDraftSession(options(storage)).getSnapshot().pending).toBeNull();
  });
  it('separates companies, organizations, members, forms, records and creation contexts', () => {
    const storage = new MemoryStorage();
    new FormDraftSession(options(storage)).capture({ name: 'Privé', note: 'Entreprise A' });
    for (const different of [{ companyId: 'company-b' }, { organizationId: 'organization-b' }, { memberId: 'member-b' }, { type: 'project' }, { recordId: 'row-b' }, { context: 'from-project' }]) {
      expect(new FormDraftSession(options(storage, { scope: { ...scope, ...different } })).getSnapshot().pending).toBeNull();
    }
    expect(formDraftKey({ ...scope, companyId: 'a.b', memberId: 'c' })).not.toBe(formDraftKey({ ...scope, companyId: 'a', memberId: 'b.c' }));
  });
  it('keeps drafts and success acknowledgement isolated when the same local workspace and member link another organization', () => {
    const storage = new MemoryStorage(), organizationA = { ...scope, organizationId: 'organization-a' }, organizationB = { ...scope, organizationId: 'organization-b' };
    const first = new FormDraftSession(options(storage, { scope: organizationA }));
    first.capture({ name: 'Entreprise A', note: 'Travail privé A' });
    const linkedElsewhere = new FormDraftSession(options(storage, { scope: organizationB }));
    expect(linkedElsewhere.getSnapshot().pending).toBeNull();
    linkedElsewhere.capture({ name: 'Entreprise B', note: 'Travail privé B' });
    storage.failRemove = true; first.complete(true);
    expect(new FormDraftSession(options(storage, { scope: organizationA })).getSnapshot().completedResidual).toBe(true);
    expect(new FormDraftSession(options(storage, { scope: organizationB })).getSnapshot().pending?.value.note).toBe('Travail privé B');
    expect(new FormDraftSession(options(storage)).getSnapshot().pending).toBeNull();
  });
  it('leaves current server values untouched until resume and requires another explicit choice on a changed server baseline', () => {
    const storage = new MemoryStorage();
    new FormDraftSession(options(storage)).capture({ name: 'Local', note: 'Travail interrompu' });
    const updated = { name: 'Nouvelle version', note: 'Ajout collègue' };
    const session = new FormDraftSession(options(storage, { initial: updated, fingerprint: formDraftFingerprint(updated) }));
    expect(session.getSnapshot().value).toEqual(updated);
    expect(session.hasConflict()).toBe(true);
    session.restore();
    expect(session.getSnapshot().value.name).toBe('Local');
    expect(session.hasConflict()).toBe(true);
    session.keepLocal();
    expect(session.hasConflict()).toBe(false);
    const openedAgain = new FormDraftSession(options(storage, { initial: updated, fingerprint: formDraftFingerprint(updated) }));
    expect(openedAgain.hasConflict()).toBe(false);
  });
  it('detects server changes while an editor remains mounted', () => {
    const storage = new MemoryStorage(), session = new FormDraftSession(options(storage));
    session.capture({ name: 'Local', note: '' });
    session.updateOptions(options(storage, { fingerprint: 'server-version-2' }));
    expect(session.hasConflict()).toBe(true);
    session.reset();
    expect(session.hasConflict()).toBe(false);
  });
  it.each(['old-format', 'expired', 'invalid-shape', 'oversized', 'credentials'])('rejects %s without restoring or erasing the server data', reason => {
    const storage = new MemoryStorage(), key = formDraftKey(scope);
    const record = { version: FORM_DRAFT_VERSION, scope: key, fingerprint: 'server', savedAt: now, value: initial };
    if (reason === 'old-format') record.version = 0;
    if (reason === 'expired') record.savedAt = now - FORM_DRAFT_MAX_AGE - 1;
    if (reason === 'invalid-shape') record.value = { name: 42 } as unknown as typeof initial;
    if (reason === 'oversized') record.value = { ...initial, note: 'x'.repeat(200_000) };
    if (reason === 'credentials') record.value = { ...initial, accessToken: 'never-restore' } as typeof initial;
    storage.setItem(key, JSON.stringify(record));
    const session = new FormDraftSession(options(storage));
    expect(session.getSnapshot().pending).toBeNull();
    expect(session.getSnapshot().invalid).toBe(true);
    expect(session.getSnapshot().value).toEqual(initial);
  });
  it.each(['read', 'quota', 'silent'])('warns and protects dismissal when storage fails (%s), then retries the newest values', reason => {
    const storage = new MemoryStorage(); storage.failRead = reason === 'read'; storage.failWrite = reason === 'quota'; storage.silentWrite = reason === 'silent';
    const session = new FormDraftSession(options(storage));
    session.capture({ name: 'Gardée en mémoire', note: 'Dernier caractère' });
    expect(session.getSnapshot().storageError).toBe(true);
    expect(session.needsCloseConfirmation()).toBe(true);
    storage.failRead = storage.failWrite = storage.silentWrite = false;
    session.retryStorage();
    expect(session.needsCloseConfirmation()).toBe(false);
    expect(new FormDraftSession(options(storage)).getSnapshot().pending?.value.note).toBe('Dernier caractère');
  });
  it('shows a damaged draft as unrecoverable without pretending that storage is unavailable or recording its content', () => {
    const storage = new MemoryStorage(), key = formDraftKey(scope), damaged = '{"note":"private-damaged-content"';
    storage.setItem(key, damaged);
    const session = new FormDraftSession(options(storage));
    expect(session.getSnapshot().invalid).toBe(true);
    expect(session.getSnapshot().storageError).toBe(false);
    expect(session.getSnapshot().pending).toBeNull();
    expect(session.getSnapshot().value).toEqual(initial);
    expect(storage.getItem(key)).toBe(damaged);
    const event = recentDiagnosticEvents().at(-1);
    expect(event).toMatchObject({ area: 'draft', operation: 'form.invalid_format', phase: 'failure' });
    expect(JSON.stringify(event)).not.toMatch(/private-damaged-content|company-a|member-a|row-a/);
  });
  it('refuses storage without a verified company scope', () => {
    const storage = new MemoryStorage(), session = new FormDraftSession(options(storage, { scope: null }));
    session.capture({ name: 'Local', note: '' });
    expect(storage.length).toBe(0); expect(session.needsCloseConfirmation()).toBe(true);
  });
  it('never evicts another active draft at capacity', () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < FORM_DRAFT_MAX_ENTRIES; index++) storage.setItem(FORM_DRAFT_PREFIX + index, JSON.stringify({ savedAt: now, value: initial }));
    const session = new FormDraftSession(options(storage)); session.capture({ name: 'Nouveau', note: '' });
    expect(session.needsCloseConfirmation()).toBe(true); expect(storage.length).toBe(FORM_DRAFT_MAX_ENTRIES);
  });
  it('discards explicitly, and reports failure instead of pretending a blocked removal succeeded', () => {
    const storage = new MemoryStorage(), session = new FormDraftSession(options(storage));
    session.capture({ name: 'À abandonner', note: '' });
    storage.failRemove = true; session.reset();
    expect(session.getSnapshot().value.name).toBe('À abandonner'); expect(session.needsCloseConfirmation()).toBe(true);
    storage.failRemove = false; session.reset();
    expect(session.getSnapshot().value).toEqual(initial); expect(storage.length).toBe(0);
  });
  it('rejects credential keys even if a caller supplies an overly permissive validator', () => {
    const storage = new MemoryStorage(), session = new FormDraftSession({ ...options(storage), validate: (value: unknown): value is typeof initial => !!value });
    session.capture({ ...initial, password: 'must-not-be-stored' } as typeof initial);
    expect(storage.length).toBe(0); expect(session.needsCloseConfirmation()).toBe(true);
  });
  it('retains a durable acknowledgement marker when deletion fails, so a saved creation is never offered again after restart', async () => {
    const storage = new MemoryStorage(), session = new FormDraftSession(options(storage));
    session.capture({ name: 'Création confirmée', note: 'Déjà enregistrée' });
    storage.failRemove = true; session.complete(true);
    expect(session.getSnapshot().completedResidual).toBe(true);
    expect(session.getSnapshot().storageError).toBe(true);
    expect([...storage.rows.keys()].some(key => key.startsWith(FORM_DRAFT_COMPLETED_PREFIX))).toBe(true);
    vi.resetModules();
    const reloaded = await import('./formDrafts');
    const restarted = new reloaded.FormDraftSession(options(storage));
    expect(restarted.getSnapshot().pending).toBeNull();
    expect(restarted.getSnapshot().completedResidual).toBe(true);
    storage.failRemove = false;
    restarted.capture({ name: 'Une nouvelle création', note: '' });
    expect(new reloaded.FormDraftSession(options(storage)).getSnapshot().pending?.value.name).toBe('Une nouvelle création');
  });
  it('logs lifecycle transitions without business contents, scopes or one event per keystroke', () => {
    const before = recentDiagnosticEvents().length, storage = new MemoryStorage(), session = new FormDraftSession(options(storage));
    for (let index = 0; index < 20; index++) session.capture({ name: `Client privé ${index}`, note: 'secret métier' });
    const events = recentDiagnosticEvents().slice(before).filter(event => event.area === 'draft');
    expect(events.map(event => event.operation)).toEqual(['form.edited', 'form.local_save']);
    expect(JSON.stringify(events)).not.toMatch(/Client privé|secret métier|company-a|member-a|row-a/);
  });
  it('reports that a confirmed success cannot be protected after restart when all local writes and removals are denied', () => {
    const storage = new MemoryStorage(), session = new FormDraftSession(options(storage));
    session.capture({ name: 'Confirmé', note: '' });
    storage.failWrite = storage.failRemove = true; session.complete(true);
    expect(session.getSnapshot().completedResidual).toBe(true);
    expect(session.getSnapshot().completionProtected).toBe(false);
    expect(new FormDraftSession(options(storage)).getSnapshot().pending).toBeNull(); // This process still retains its acknowledgement.
  });
});

describe('document form recovery', () => {
  it('keeps raw incomplete decimal input, lines, client, dates, footer and current step across restart', () => {
    const storage = new MemoryStorage(), initial = initialDocumentFormDraft('quotes', initialOnboardingSettings, 'line-id');
    const config = { scope: { ...scope, type: 'quotes' }, initial, fingerprint: 'new', validate: validDocumentFormDraft, storage: () => storage, now: () => now };
    const edited = { ...initial, documentTitle: 'Cuisine', selectedClientId: 'client-1', step: 1, footerText: '30 jours', numberInputs: { 'line-id-price': '95,' }, lines: [{ ...initial.lines[0], description: 'Pose', unitPriceCents: 9500 }] };
    const session = new FormDraftSession(config); session.capture(edited);
    expect(session.getSnapshot().storageError).toBe(false);
    const restart = new FormDraftSession(config); restart.restore();
    expect(restart.getSnapshot().value).toEqual(edited);
  });
  it('validates line identities and rejects forged fields without normalizing the user’s text', () => {
    const draft = initialDocumentFormDraft('quotes', initialOnboardingSettings, 'line-id');
    expect(validDocumentFormDraft(draft)).toBe(true);
    expect(validDocumentFormDraft({ ...draft, step: 4 })).toBe(false);
    expect(validDocumentFormDraft({ ...draft, lines: [draft.lines[0], draft.lines[0]] })).toBe(false);
    expect(validDocumentFormDraft({ ...draft, lines: [{ ...draft.lines[0], secret: 'bad' }] })).toBe(false);
  });
});
