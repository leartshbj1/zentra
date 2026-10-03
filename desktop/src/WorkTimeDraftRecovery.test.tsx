// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
/**
 * Regression coverage for durable manual time entry drafts.
 * Run with the desktop Vite configuration and the jsdom dev dependency.
 *
 * Real React DOM, TimeForm/TimerForm, useFormDraft/FormDraftSession, diagnostics,
 * bridge and createWorkspaceEntity execute here. Native invoke is mocked;
 * Storage is an injected browser boundary with explicit retirement failures.
 * The four language cases additionally replace only fetch for packaged language
 * asset URLs, serving the actual authored packs through the real JSON loader.
 * They do not mock language.ts, setAppLanguage or useAppLanguage.
 * actBelow only awaits the action and forwards errors. It does not reproduce
 * WorkspaceApp's recovery, workspace publication, modal closing or lifecycle
 * guards. Those remain a separate integration requirement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Root } from 'react-dom/client';
import type { TimeEntry, Workspace } from './types';
import type { TimeEntryDraft } from './timeEntryForm';

const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: nativeInvoke }));

const companyId = 'candidate-time-company';
const memberId = 'candidate-time-member';
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const legacyValue: TimeEntryDraft = {
  projectId: 'project-1', taskId: '', employeeId: 'employee-1', date: '2026-10-03',
  hours: '2', minutes: '15', breakMinutes: '0', billable: 'yes', billingRate: '110.00',
  costRate: '45.00', status: 'approved', note: 'Travail vérifié avant saisie',
};
const recoveryCopies = [
  {
    language: 'fr', title: 'Enregistrement des heures à vérifier',
    message: 'La création de ces heures n’a pas été confirmée. Votre brouillon est conservé.',
    instruction: 'Vérifiez l’historique des heures avant toute nouvelle saisie. Si ces heures sont déjà enregistrées, ouvrez leur fiche pour les contrôler ou les modifier.',
    validationTitle: 'Informations à corriger',
  },
  {
    language: 'de', title: 'Zeiterfassung prüfen',
    message: 'Die Erstellung dieses Zeiteintrags wurde nicht bestätigt. Ihr Entwurf bleibt gespeichert.',
    instruction: 'Prüfen Sie die erfassten Zeiten vor einem neuen Eintrag. Wenn diese Stunden bereits gespeichert sind, öffnen Sie den Eintrag, um ihn zu prüfen oder zu bearbeiten.',
    validationTitle: 'Angaben korrigieren',
  },
  {
    language: 'it', title: 'Verifica la registrazione delle ore',
    message: 'La creazione di queste ore non è stata confermata. La bozza è conservata.',
    instruction: 'Controlla lo storico delle ore prima di una nuova registrazione. Se queste ore sono già registrate, apri la loro scheda per verificarle o modificarle.',
    validationTitle: 'Correggi le informazioni',
  },
  {
    language: 'en', title: 'Check the time entry',
    message: 'The creation of this time entry has not been confirmed. Your draft is retained.',
    instruction: 'Check the time entry history before creating another entry. If these hours are already recorded, open their entry to review or edit them.',
    validationTitle: 'Correct the information',
  },
] as const;

class FaultStorage implements Storage {
  readonly data = new Map<string, string>();
  retireKey: string | null = null;
  captureFailureKey: string | null = null;
  readonly failedRetirements: Array<'marker' | 'remove' | 'tombstone'> = [];
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (key === this.captureFailureKey) throw new DOMException('Draft capture refused', 'QuotaExceededError');
    if (this.retireKey && key === this.retireKey.replace('.drafts.', '.completed.')) {
      this.failedRetirements.push('marker');
      throw new DOMException('Completion marker refused', 'QuotaExceededError');
    }
    if (this.retireKey === key && JSON.parse(value).acknowledged === true) {
      this.failedRetirements.push('tombstone');
      throw new DOMException('Acknowledgement refused', 'QuotaExceededError');
    }
    this.data.set(key, value);
  }
  removeItem(key: string) {
    if (key === this.retireKey) {
      this.failedRetirements.push('remove');
      throw new DOMException('Draft removal refused', 'SecurityError');
    }
    this.data.delete(key);
  }
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type Mounted = { root: Root; host: HTMLDivElement; runtime: Runtime };
type FormProps = ComponentProps<typeof import('./WorkTimeForms').TimeForm>;
let mounted: Mounted[] = [];
let storage: FaultStorage;
let runtime: Runtime;
let nativeRows: Map<string, Record<string, unknown>>;
let rejectCreation: boolean;
let creationFailure: Error;
let arrivingOldRow: Record<string, unknown> | undefined;
let rejectRead: boolean;
let scrollDescriptor: PropertyDescriptor | undefined;

// All runtime imports are reacquired after resetModules. In particular, the
// real formDrafts.ts completedRecords map is new, just as after a process exit.
// No test-only map-clear export or hook replacement is used.
async function loadRuntime() {
  const react = await import('react');
  const dom = await import('react-dom/client');
  const forms = await import('./WorkTimeForms');
  const { FormDraftIdentityProvider } = await import('./useFormDraft');
  const drafts = await import('./formDrafts');
  const { desktopApi } = await import('./bridge');
  const creation = await import('./workspaceCreation');
  const userErrors = await import('./userErrors');
  const language = await import('./language');
  return { react, dom, forms, FormDraftIdentityProvider, drafts, desktopApi, creation, userErrors, language };
}

function rawWorkspace() {
  return {
    work_notes_scope: companyId,
    projects: [{ id: 'project-1', name: 'Projet témoin', status: 'en_cours' }],
    employees: [{ id: 'employee-1', name: 'Collaborateur témoin', status: 'actif', hourly_rate_cents: 4500 }],
    time_entries: [...nativeRows.values()],
  };
}

function callsFor(command: string) {
  return nativeInvoke.mock.calls.filter(([name]) => name === command);
}
function writes() {
  return nativeInvoke.mock.calls.filter(([name]) => ['create_record', 'update_record', 'start_timer'].includes(name));
}
function scopeKey(type = 'time', recordId?: string) {
  return runtime.drafts.formDraftKey({ companyId, memberId, type, recordId });
}
function storedDraft(key = scopeKey()) {
  const raw = storage.getItem(key);
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as { value: TimeEntryDraft & { creationId?: string }; fingerprint: string };
}
function seedLegacy(type = 'time', recordId?: string, fingerprint = 'new', value = legacyValue) {
  const key = scopeKey(type, recordId);
  storage.setItem(key, JSON.stringify({
    version: runtime.drafts.FORM_DRAFT_VERSION, scope: key, fingerprint, savedAt: Date.now(), value,
  }));
  return key;
}

// Deliberately small prop boundary. The actual bridge action runs without a
// bridge mock and without resending/reconciling any failure in this executor.
function actBelow() {
  const outcomes: boolean[] = [];
  const failures: unknown[] = [];
  let pending: Promise<boolean> | undefined;
  const act: FormProps['act'] = (action, _message, _close, onError) => {
    pending = (async () => {
      try { await action(); outcomes.push(true); return true; }
      catch (reason) { failures.push(reason); onError?.(reason); outcomes.push(false); return false; }
    })();
    return pending;
  };
  return { act, outcomes, failures, latest: () => pending, clearPending: () => { pending = undefined; } };
}

async function mountForm(workspace: Workspace, harness: ReturnType<typeof actBelow>, item?: TimeEntry, timer = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = runtime.dom.createRoot(host);
  const form = timer ? runtime.forms.TimerForm : runtime.forms.TimeForm;
  await runtime.react.act(async () => root.render(runtime.react.createElement(
    runtime.FormDraftIdentityProvider, { memberId, ready: true,
      children: runtime.react.createElement(form, { workspace, item, busy: false, close: () => {}, act: harness.act }),
    },
  )));
  const result = { root, host, runtime };
  mounted.push(result);
  return result;
}
async function unmountForm(form: Mounted) {
  await form.runtime.react.act(async () => form.root.unmount());
  form.host.remove();
  mounted = mounted.filter(row => row !== form);
}
function formElement() {
  const form = document.querySelector<HTMLFormElement>('[role="dialog"] form');
  if (!form) throw new Error('Actual WorkTimeForm was not mounted');
  return form;
}
function expectVisibleRecovery(copy: { title: string; message: string; instruction: string; validationTitle: string }) {
  const alert = formElement().querySelector<HTMLElement>('[data-time-creation-recovery]');
  expect(alert).not.toBeNull();
  expect(alert!.getAttribute('role')).toBe('alert');
  const title = alert!.querySelector<HTMLElement>('strong');
  const paragraphs = [...alert!.querySelectorAll<HTMLElement>('p')];
  expect(title?.textContent).toBe(copy.title);
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs[0].textContent).toBe(copy.message);
  expect(paragraphs[1].textContent).toBe(copy.instruction);
  expect(paragraphs[1].classList.contains('error-guidance__recovery')).toBe(true);
  // Text in a closed details element can satisfy textContent while remaining
  // unavailable to the user. Require copy in the alert itself, outside hidden
  // ancestors. jsdom does not provide layout rects or full visual browser QA.
  for (const node of [alert!, title!, ...paragraphs]) {
    expect(node.closest('details, [hidden], [aria-hidden="true"]')).toBeNull();
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      expect(style.display).not.toBe('none');
      expect(['hidden', 'collapse']).not.toContain(style.visibility);
    }
  }
  expect(alert!.textContent).not.toContain(copy.validationTitle);
  expect(alert!.textContent).not.toMatch(/Certaines informations ne sont pas acceptées|Vérifiez les champs indiqués/);
  expect(alert!.querySelector('details, .error-guidance__support')).toBeNull();
  const support = formElement().querySelector('.error-guidance__support');
  expect(support).not.toBeNull();
  expect(alert!.contains(support)).toBe(false);
}
function field(name: keyof TimeEntryDraft) {
  const control = formElement().elements.namedItem(name);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing actual form field: ${name}`);
  }
  return control;
}
async function change(name: keyof TimeEntryDraft, value: string) {
  const control = field(name);
  expect(control.matches(':disabled')).toBe(false);
  const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await runtime.react.act(async () => {
    // The browser setter bypasses React's value tracker; native events trigger
    // the real component onChange rather than reaching into its hook state.
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(field(name).value).toBe(value);
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find(row => row.textContent?.trim() === label);
  if (!found) throw new Error(`Missing actual form button: ${label}`);
  return found;
}
async function click(label: string) {
  const target = button(label);
  expect(target.disabled).toBe(false);
  await runtime.react.act(async () => target.click());
}
async function submit(harness: ReturnType<typeof actBelow>, expectedAction = true) {
  harness.clearPending();
  await runtime.react.act(async () => {
    // A forced submit also checks the handler guard when the button is disabled.
    formElement().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    if (expectedAction) { expect(harness.latest()).toBeDefined(); await harness.latest(); }
    else expect(harness.latest()).toBeUndefined();
  });
}
async function fillManual() {
  for (const name of ['projectId', 'employeeId', 'date', 'hours', 'minutes', 'breakMinutes', 'billable', 'billingRate', 'costRate', 'status', 'note'] as const) {
    await change(name, legacyValue[name]);
  }
}

beforeEach(async () => {
  vi.resetModules();
  nativeInvoke.mockReset();
  storage = new FaultStorage();
  nativeRows = new Map();
  rejectCreation = false;
  creationFailure = new Error('Native creation refused before persistence');
  arrivingOldRow = undefined;
  rejectRead = false;
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  // jsdom has no layout/scroll engine; this is a DOM capability adapter only.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  nativeInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'get_app_state') {
      if (rejectRead) throw new Error('Native workspace unavailable');
      return { onboarding_completed: true, data_dir: 'candidate-only', database_path: 'candidate-only', app_version: 'candidate' };
    }
    if (command === 'get_workspace') return structuredClone(rawWorkspace());
    if (command === 'create_record') {
      expect(args?.entity).toBe('time_entries');
      const data = args?.data as Record<string, unknown>;
      if (arrivingOldRow) {
        // Fixture for an older native invocation committing after the current
        // preflight read, before the corrected invocation hits the primary key.
        nativeRows.set(String(arrivingOldRow.id), structuredClone(arrivingOldRow));
        arrivingOldRow = undefined;
        throw new Error('UNIQUE constraint failed: time_entries.id');
      }
      if (rejectCreation) throw creationFailure;
      expect(nativeRows.has(String(data.id))).toBe(false);
      nativeRows.set(String(data.id), structuredClone(data));
      return structuredClone(data);
    }
    if (command === 'update_record') {
      expect(args?.entity).toBe('time_entries');
      const id = String(args?.id);
      expect(nativeRows.has(id)).toBe(true);
      nativeRows.set(id, { ...nativeRows.get(id), ...structuredClone(args?.data as Record<string, unknown>) });
      return null;
    }
    if (command === 'start_timer') return null;
    throw new Error(`Unexpected native command: ${command}`);
  });
  runtime = await loadRuntime();
});
afterEach(async () => {
  for (const form of [...mounted]) await unmountForm(form);
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  vi.unstubAllGlobals();
});

describe('candidate: recovered manual time creation keeps its creation identity', () => {
  it('blocks a second native create after all three retirements fail and a real module restart', async () => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    nativeInvoke.mockClear();
    const first = actBelow();
    let view = await mountForm(workspace, first);
    await fillManual();
    const key = scopeKey();
    const before = storage.getItem(key)!;
    const id = storedDraft(key).value.creationId;
    expect(id).toMatch(uuid);
    expect(Object.keys(storedDraft(key).value)).toHaveLength(Object.keys(legacyValue).length + 1);
    storage.retireKey = key;

    await submit(first);
    expect(first.outcomes).toEqual([true]);
    expect(storage.failedRetirements).toEqual(['marker', 'remove', 'tombstone']);
    expect(storage.getItem(key)).toBe(before);
    expect(callsFor('create_record')).toHaveLength(1);
    expect(callsFor('create_record')[0][1].data.id).toBe(id);
    expect(callsFor('create_record')[0][1].data).not.toHaveProperty('creation_id');
    expect(nativeRows.size).toBe(1);

    await unmountForm(view);
    // Prove the actual session map protects this residual in the same process.
    view = await mountForm(workspace, actBelow());
    expect(document.body.textContent).toContain('L’enregistrement est confirmé');
    expect(document.body.textContent).not.toContain('Reprendre ma saisie');
    await unmountForm(view);

    vi.resetModules(); // Clears the real completedRecords map without a mock/export.
    runtime = await loadRuntime();
    const recoveredWorkspace = await runtime.desktopApi.loadWorkspace();
    const afterRestart = actBelow();
    await mountForm(recoveredWorkspace, afterRestart);
    expect(storage.getItem(key)).toBe(before);
    await click('Reprendre ma saisie');
    expect(field('hours').value).toBe(legacyValue.hours);
    expect(storedDraft(key).value.creationId).toBe(id);
    const checkpoint = nativeInvoke.mock.calls.length;
    await submit(afterRestart);
    expect(afterRestart.outcomes).toEqual([false]);
    expect(String(afterRestart.failures[0])).toContain('existe déjà');
    expect(nativeInvoke.mock.calls.slice(checkpoint).map(([name]) => name)).toEqual(['get_app_state', 'get_workspace']);
    expect(callsFor('create_record')).toHaveLength(1);
    expect(nativeRows.size).toBe(1);
    expect(storage.getItem(key)).toBe(before);
  });

  it('retries an absent/refused creation after restart and a duration change with the same UUID', async () => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    nativeInvoke.mockClear();
    const first = actBelow();
    const view = await mountForm(workspace, first);
    await fillManual();
    const id = storedDraft().value.creationId;
    rejectCreation = true;
    await submit(first);
    expect(first.outcomes).toEqual([false]);
    const refusal = first.failures[0] as Error;
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(runtime.creation.WorkspaceCreationOutcomeUnknownError);
    expect(refusal.cause).toBeInstanceOf(runtime.creation.WorkspaceCreationOutcomeUnknownError);
    expect(refusal.cause).toMatchObject({ entity: 'timeEntries', recordId: id, mutationCause: creationFailure });
    expect(nativeRows.size).toBe(0);
    expect(storedDraft().value.creationId).toBe(id);
    await unmountForm(view);

    vi.resetModules();
    runtime = await loadRuntime();
    const authoritativeAbsence = await runtime.desktopApi.loadWorkspace();
    expect(authoritativeAbsence.onboardingCompleted).toBe(true);
    expect(authoritativeAbsence.timeEntries).toEqual([]);
    const retry = actBelow();
    await mountForm(authoritativeAbsence, retry);
    await click('Reprendre ma saisie');
    await change('hours', '3');
    expect(storedDraft().value.creationId).toBe(id);
    expect(storedDraft().value.hours).toBe('3');
    rejectCreation = false;
    await submit(retry);
    expect(retry.outcomes).toEqual([true]);
    expect(callsFor('create_record').map(([, args]) => args.data.id)).toEqual([id, id]);
    expect(callsFor('create_record').map(([, args]) => args.data.minutes)).toEqual([135, 195]);
    expect(nativeRows.size).toBe(1);
    expect(nativeRows.get(id!)?.minutes).toBe(195);
    expect(storage.getItem(scopeKey())).toBeNull();
  });

  it('preserves the corrected restored draft when an older invocation commits between absent preflight and native refusal', async () => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    nativeInvoke.mockClear();
    const first = actBelow();
    const view = await mountForm(workspace, first);
    await fillManual();
    const key = scopeKey();
    const id = storedDraft(key).value.creationId;
    const originalRaw = storage.getItem(key)!;
    creationFailure = new Error('Previous native response lost while its write is still delayed');
    rejectCreation = true;
    await submit(first);
    expect(first.outcomes).toEqual([false]);
    const oldNativePayload = structuredClone(callsFor('create_record')[0][1].data) as Record<string, unknown>;
    expect(oldNativePayload).toMatchObject({ id, minutes: 135 });
    expect(nativeRows.size).toBe(0);
    expect(storage.getItem(key)).toBe(originalRaw);
    await unmountForm(view);

    vi.resetModules();
    runtime = await loadRuntime();
    const absentWorkspace = await runtime.desktopApi.loadWorkspace();
    expect(absentWorkspace.timeEntries).toEqual([]);
    const corrected = actBelow();
    await mountForm(absentWorkspace, corrected);
    await click('Reprendre ma saisie');
    await change('hours', '3');
    const correctedRaw = storage.getItem(key)!;
    expect(storedDraft(key).value).toMatchObject({ creationId: id, hours: '3' });
    rejectCreation = false;
    arrivingOldRow = oldNativePayload;
    const checkpoint = nativeInvoke.mock.calls.length;
    await submit(corrected);

    expect(nativeInvoke.mock.calls.slice(checkpoint).map(([name]) => name)).toEqual(['get_app_state', 'get_workspace', 'create_record']);
    expect(callsFor('create_record').map(([, args]) => args.data.id)).toEqual([id, id]);
    expect(callsFor('create_record')[1][1].data.minutes).toBe(195);
    expect(nativeRows.size).toBe(1);
    expect(nativeRows.get(id!)?.minutes).toBe(135);
    expect(corrected.outcomes).toEqual([false]);
    const failure = corrected.failures[0] as Error;
    expect(failure.constructor).toBe(Error);
    expect(failure).not.toBeInstanceOf(runtime.creation.WorkspaceCreationOutcomeUnknownError);
    expect(failure.cause).toBeInstanceOf(runtime.creation.WorkspaceCreationOutcomeUnknownError);
    expect(failure.cause).toMatchObject({ entity: 'timeEntries', recordId: id });
    expect(failure.message).toBe('La création des heures n’est pas confirmée.');
    expect(runtime.userErrors.classifyUserError(failure)).toBe('unknown');
    expectVisibleRecovery(recoveryCopies[0]);
    expect(storage.getItem(key)).toBe(correctedRaw);
    expect(storage.getItem(key.replace(runtime.drafts.FORM_DRAFT_PREFIX, runtime.drafts.FORM_DRAFT_COMPLETED_PREFIX))).toBeNull();
    // The real ID-only classifier could acknowledge the old variant. The prop
    // receives an ordinary Error, so it cannot apply that typed classification.
    const cause = failure.cause;
    if (!(cause instanceof runtime.creation.WorkspaceCreationOutcomeUnknownError)) throw new Error('Missing actual unknown-creation cause');
    expect(cause.wasRecorded(await runtime.desktopApi.loadWorkspace())).toBe(true);
    expect(storage.getItem(key)).toBe(correctedRaw);
  });

  it.each(recoveryCopies)('updates the visible recovery alert to $language through the real language hook', async copy => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    nativeInvoke.mockClear();
    const harness = actBelow();
    await mountForm(workspace, harness);
    await fillManual();
    const key = scopeKey();
    const before = storage.getItem(key);
    rejectCreation = true;
    await submit(harness);
    expect(harness.outcomes).toEqual([false]);
    expectVisibleRecovery(recoveryCopies[0]);

    // Vitest has no asset server. Substitute only that browser I/O boundary,
    // matching the real plugin's emitted URL and JSON contents. Recovery copy
    // is not placed in this response: it must come from WorkTimeForms and its
    // actual useAppLanguage subscription after setAppLanguage publishes.
    const { languageAssets } = await import('virtual:zentra-language-assets');
    const { translations } = await import('./translations');
    const assetFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (copy.language === 'fr') throw new Error('French must not request a language pack');
      expect(String(input)).toBe(languageAssets[copy.language]);
      const index = ['de', 'it', 'en'].indexOf(copy.language);
      return new Response(JSON.stringify(Object.fromEntries(
        Object.entries(translations).map(([source, targets]) => [source, targets[index]]),
      )), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', assetFetch);
    const nativeCheckpoint = nativeInvoke.mock.calls.length;
    await runtime.react.act(async () => {
      expect(await runtime.language.setAppLanguage(copy.language)).toBe(true);
    });
    expect(runtime.language.getAppLanguage()).toBe(copy.language);
    if (copy.language === 'fr') expect(assetFetch).not.toHaveBeenCalled();
    else expect(assetFetch).toHaveBeenCalledTimes(1);
    expectVisibleRecovery(copy);
    expect(nativeInvoke.mock.calls.length).toBe(nativeCheckpoint);
    expect(callsFor('create_record')).toHaveLength(1);
    expect(storage.getItem(key)).toBe(before);
  });

  it('sends no native creation while preflight is unreadable, then keeps the ID for an explicit retry', async () => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    nativeInvoke.mockClear();
    const harness = actBelow();
    await mountForm(workspace, harness);
    await fillManual();
    const id = storedDraft().value.creationId;
    rejectRead = true;
    await submit(harness);
    expect(harness.outcomes).toEqual([false]);
    expect(writes()).toEqual([]);
    expect(storedDraft().value.creationId).toBe(id);
    rejectRead = false;
    await change('minutes', '30');
    await submit(harness);
    expect(harness.outcomes).toEqual([false, true]);
    expect(callsFor('create_record')).toHaveLength(1);
    expect(callsFor('create_record')[0][1].data).toMatchObject({ id, minutes: 150 });
  });

  it('blocks a manual write until the current draft can be retained and retryStorage preserves its UUID', async () => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    nativeInvoke.mockClear();
    const harness = actBelow();
    await mountForm(workspace, harness);
    await fillManual();
    const key = scopeKey();
    const id = storedDraft(key).value.creationId;
    storage.captureFailureKey = key;
    await change('hours', '3');
    expect(field('hours').value).toBe('3');
    expect(storedDraft(key).value.hours).toBe('2');
    expect(button('Enregistrer les heures').disabled).toBe(true);
    await submit(harness, false);
    expect(nativeInvoke).not.toHaveBeenCalled();
    storage.captureFailureKey = null;
    await click('Réessayer la sauvegarde locale');
    expect(storedDraft(key).value).toMatchObject({ creationId: id, hours: '3' });
    expect(button('Enregistrer les heures').disabled).toBe(false);
    await submit(harness);
    expect(harness.outcomes).toEqual([true]);
    expect(callsFor('create_record')).toHaveLength(1);
    expect(callsFor('create_record')[0][1].data).toMatchObject({ id, minutes: 195 });
  });

  it('preserves a legacy draft and refuses even forced submission until the explicit new-entry choice', async () => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    const key = seedLegacy();
    const before = storage.getItem(key);
    nativeInvoke.mockClear();
    const harness = actBelow();
    await mountForm(workspace, harness);
    await submit(harness, false);
    await click('Reprendre ma saisie');
    expect(document.body.textContent).toContain('Vérifiez l’historique des heures');
    expect(field('hours').value).toBe(legacyValue.hours);
    expect(field('note').value).toBe(legacyValue.note);
    expect(field('hours').matches(':disabled')).toBe(true);
    expect(button('Enregistrer les heures').disabled).toBe(true);
    await submit(harness, false);
    expect(nativeInvoke).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(before);
    expect(storedDraft(key).value).toEqual(legacyValue);

    await click('Préparer une nouvelle saisie');
    const prepared = storedDraft(key).value;
    expect(prepared.creationId).toMatch(uuid);
    const { creationId, ...businessFields } = prepared;
    expect(businessFields).toEqual(legacyValue);
    expect(nativeInvoke).not.toHaveBeenCalled();
    expect(button('Enregistrer les heures').disabled).toBe(false);
    await submit(harness);
    expect(callsFor('create_record')).toHaveLength(1);
    expect(callsFor('create_record')[0][1].data.id).toBe(creationId);
  });

  it('rejects a malformed creation UUID instead of silently assigning another UUID to the stored data', async () => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    const key = seedLegacy();
    const record = JSON.parse(storage.getItem(key)!);
    record.value.creationId = 'not-a-uuid';
    storage.setItem(key, JSON.stringify(record));
    const before = storage.getItem(key);
    nativeInvoke.mockClear();
    const harness = actBelow();
    await mountForm(workspace, harness);
    expect(document.body.textContent).toContain('Ce brouillon ne peut plus être repris');
    expect(button('Enregistrer les heures').disabled).toBe(true);
    await submit(harness, false);
    expect(nativeInvoke).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(before);
  });

  it('allows two intentionally new identical entries with distinct UUIDs', async () => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    nativeInvoke.mockClear();
    const first = actBelow();
    const view = await mountForm(workspace, first);
    await fillManual();
    await submit(first);
    await unmountForm(view);
    const second = actBelow();
    await mountForm(await runtime.desktopApi.loadWorkspace(), second);
    await fillManual();
    await submit(second);
    const creations = callsFor('create_record');
    expect(creations).toHaveLength(2);
    expect(creations[0][1].data.id).not.toBe(creations[1][1].data.id);
    const { id: firstId, ...firstData } = creations[0][1].data;
    const { id: secondId, ...secondData } = creations[1][1].data;
    expect(firstId).toMatch(uuid); expect(secondId).toMatch(uuid);
    expect(firstData).toEqual(secondData);
    expect(nativeRows.size).toBe(2);
  });
});

describe('candidate: existing edit and timer draft contracts', () => {
  it('restores the existing edit shape and uses update_record without creation metadata or create preflight', async () => {
    nativeRows.set('edit-1', {
      id: 'edit-1', project_id: legacyValue.projectId, employee_id: legacyValue.employeeId,
      date: legacyValue.date, minutes: 135, break_minutes: 0, billable: true,
      billing_rate_cents: 11000, cost_rate_cents: 4500, status: 'approuve', note: 'Version enregistrée',
    });
    const workspace = await runtime.desktopApi.loadWorkspace();
    const item = workspace.timeEntries[0];
    const key = seedLegacy('time', item.id, runtime.drafts.formDraftFingerprint(item));
    nativeInvoke.mockClear();
    const harness = actBelow();
    await mountForm(workspace, harness, item);
    await click('Reprendre ma saisie');
    await change('note', 'Correction volontaire');
    const value = storedDraft(key).value;
    expect(Object.keys(value).sort()).toEqual(Object.keys(legacyValue).sort());
    expect(value).not.toHaveProperty('creationId');
    expect(document.body.textContent).not.toContain('Préparer une nouvelle saisie');
    await submit(harness);
    expect(harness.outcomes).toEqual([true]);
    expect(writes().map(([name]) => name)).toEqual(['update_record']);
    expect(nativeInvoke.mock.calls.map(([name]) => name)).toEqual(['update_record', 'get_app_state', 'get_workspace']);
    expect(callsFor('update_record')[0][1]).toMatchObject({ entity: 'time_entries', id: item.id });
    expect(callsFor('update_record')[0][1].data).not.toHaveProperty('id');
    expect(callsFor('update_record')[0][1].data).not.toHaveProperty('creation_id');
  });

  it('restores the existing timer shape and sends the unchanged start_timer payload', async () => {
    const workspace = await runtime.desktopApi.loadWorkspace();
    const key = seedLegacy('timer');
    nativeInvoke.mockClear();
    const harness = actBelow();
    await mountForm(workspace, harness, undefined, true);
    await click('Reprendre ma saisie');
    await change('note', 'Pointage repris');
    const value = storedDraft(key).value;
    expect(Object.keys(value).sort()).toEqual(Object.keys(legacyValue).sort());
    expect(value).not.toHaveProperty('creationId');
    expect(document.body.textContent).not.toContain('Préparer une nouvelle saisie');
    await submit(harness);
    expect(harness.outcomes).toEqual([true]);
    expect(writes().map(([name]) => name)).toEqual(['start_timer']);
    expect(callsFor('start_timer')[0][1]).toEqual({ input: {
      project_id: 'project-1', task_id: null, employee_id: 'employee-1', billable: true,
      billing_rate_cents: 11000, cost_rate_cents: 4500, note: 'Pointage repris',
    } });
    expect(storage.getItem(key)).toBeNull();
  });
});
