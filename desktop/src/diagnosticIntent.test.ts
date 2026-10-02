import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./bridge', () => ({ desktopApi: { loadWorkspace: vi.fn() } }));
async function api() {
  return { ...await import('./diagnosticIntent'), ...await import('./diagnostics') };
}
beforeEach(() => { vi.resetModules(); invoke.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const intentions = [
  ['automation_request', 'state', 'automation.state'],
  ['automation_request', 'decide', 'automation.decide'],
  ['automation_request', 'feedback', 'automation.feedback'],
  ['automation_request', 'settings', 'automation.settings'],
  ['automation_request', 'centre', 'automation.centre'],
  ['automation_request', 'workflow_save', 'automation.workflow_save'],
  ['automation_request', 'workflow_preview', 'automation.workflow_preview'],
  ['automation_request', 'workflow_confirm', 'automation.workflow_confirm'],
  ['automation_request', 'workflow_cancel', 'automation.workflow_cancel'],
  ['automation_request', 'workflow_retry', 'automation.workflow_retry'],
  ['automation_request', 'workflow_undo', 'automation.workflow_undo'],
  ['automation_request', 'work_item_update', 'automation.work_item_update'],
  ['automation_request', 'invoice_scan', 'automation.invoice_scan'],
  ['supplier_inbox_request', 'state', 'supplier_inbox.state'],
  ['supplier_inbox_request', 'forgetHabit', 'supplier_inbox.forget_habit'],
  ['supplier_inbox_request', 'prepareSupplier', 'supplier_inbox.prepare_supplier'],
  ['supplier_inbox_request', 'prepareSuppliers', 'supplier_inbox.prepare_suppliers'],
  ['supplier_inbox_request', 'remember', 'supplier_inbox.remember'],
  ['supplier_inbox_request', 'ignore', 'supplier_inbox.ignore'],
  ['supplier_inbox_request', 'document', 'supplier_inbox.document'],
  ['supplier_inbox_request', 'import', 'supplier_inbox.import'],
  ['appointment_inbox_request', 'state', 'appointment_inbox.state'],
  ['appointment_inbox_request', 'ignore', 'appointment_inbox.ignore'],
  ['appointment_inbox_request', 'import', 'appointment_inbox.import'],
] as const;
const privateMarker = 'customer@example.ch password=synthetic token=private-token /private/document.pdf';
function closedEvents(events: readonly object[]) {
  for (const event of events) {
    expect(Object.keys(event).every(key => ['id', 'sessionId', 'timestamp', 'area', 'operation', 'phase', 'durationMs', 'errorCode'].includes(key))).toBe(true);
  }
  expect(JSON.stringify(events)).not.toMatch(/customer@|password|synthetic|private-token|document\.pdf/);
}

describe('fixed IPC diagnostic intent', () => {
  it.each(intentions)('%s / %s logs one precise pair without changing success, rejection or transport', async (command, action, operation) => {
    const d = await api(), body = Object.freeze({ action: 'untrusted-other-action', text: privateMarker });
    const args = Object.freeze({ data: body }), options = { headers: { private: privateMarker } };
    expect(d.withDiagnosticIntent(args, command, action)).toBe(args);
    const result = { accepted: true, private: privateMarker };
    invoke.mockResolvedValueOnce(result);
    expect(await d.diagnosticInvoke(command, args, options)).toBe(result);
    expect(invoke.mock.calls[0]).toHaveLength(3);
    expect(invoke.mock.calls[0][1]).toBe(args);
    expect(invoke.mock.calls[0][2]).toBe(options);
    const rejection = new Error(`network timeout ${privateMarker}`);
    invoke.mockRejectedValueOnce(rejection);
    const preserved = await d.diagnosticInvoke(command, args).catch(reason => reason === rejection);
    expect(preserved).toBe(true);
    expect(invoke.mock.calls[1]).toHaveLength(2);
    expect(invoke.mock.calls[1][1]).toBe(args);
    expect(invoke).toHaveBeenCalledTimes(2);
    const events = d.recentDiagnosticEvents();
    expect(events.map(event => [event.operation, event.phase])).toEqual([[operation, 'start'], [operation, 'success'], [operation, 'start'], [operation, 'failure']]);
    expect(events[0].id).toBe(events[1].id);
    expect(events[2].id).toBe(events[3].id);
    expect(events[3].errorCode).toBe('NETWORK');
    expect(d.resolveErrorIncident(rejection).code).toBe(`ZT-${events[3].id}`);
    expect(d.resolveErrorIncident(rejection).code).toBe(`ZT-${events[3].id}`);
    expect(d.recentDiagnosticEvents()).toHaveLength(4);
    closedEvents(events);
  });

  it('copies intent through a single-argument callback without adding properties or reading a hostile body', async () => {
    const d = await api(), read = vi.fn(() => { throw new Error('payload inspection'); });
    const body = new Proxy(Object.freeze({}), { get: read, getOwnPropertyDescriptor: read, getPrototypeOf: read, ownKeys: read });
    expect(d.withDiagnosticIntent(body, 'automation_request', 'workflow_save')).toBe(body);
    const result = { accepted: true };
    invoke.mockResolvedValue(result);
    const request = vi.fn((data: unknown) => d.diagnosticInvoke('automation_request', d.copyDiagnosticIntent(data, { data }, 'automation_request')));
    expect(await request(body)).toBe(result);
    expect(request.mock.calls[0]).toHaveLength(1);
    expect(request.mock.calls[0][0]).toBe(body);
    expect(invoke.mock.calls[0]).toHaveLength(2);
    expect(invoke.mock.calls[0][1].data).toBe(body);
    expect(read).not.toHaveBeenCalled();
    expect(d.recentDiagnosticEvents().map(event => event.operation)).toEqual(['automation.workflow_save', 'automation.workflow_save']);
    const plain = { action: 'centre', private: privateMarker }, args = { data: plain };
    d.withDiagnosticIntent(plain, 'automation_request', 'centre');
    expect(d.copyDiagnosticIntent(plain, args, 'automation_request')).toBe(args);
    expect(Reflect.ownKeys(plain)).toEqual(['action', 'private']);
    expect(Reflect.ownKeys(args)).toEqual(['data']);
    closedEvents(d.recentDiagnosticEvents());
  });

  it('looks up arguments by identity even when data is a getter or the arguments proxy is revoked', async () => {
    const d = await api(), read = vi.fn(() => { throw new Error('data getter'); });
    const args = Object.defineProperty({}, 'data', { get: read });
    d.withDiagnosticIntent(args, 'supplier_inbox_request', 'document');
    invoke.mockResolvedValue(null);
    await d.diagnosticInvoke('supplier_inbox_request', args);
    const proxy = Proxy.revocable({}, {});
    d.withDiagnosticIntent(proxy.proxy, 'supplier_inbox_request', 'ignore');
    proxy.revoke();
    await d.diagnosticInvoke('supplier_inbox_request', proxy.proxy);
    expect(read).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0][1]).toBe(args);
    expect(invoke.mock.calls[1][1]).toBe(proxy.proxy);
    expect(d.recentDiagnosticEvents().map(event => event.operation)).toEqual(['supplier_inbox.document', 'supplier_inbox.document', 'supplier_inbox.ignore', 'supplier_inbox.ignore']);
  });

  it.each(['unknown_action', '__proto__', 'constructor', 'toString'])('keeps %s annotations generic without inferring a payload action', async action => {
    const d = await api(), args = { data: { action: 'import', private: privateMarker } };
    d.withDiagnosticIntent(args, 'supplier_inbox_request', action as Parameters<typeof d.withDiagnosticIntent>[2]);
    invoke.mockResolvedValue(args.data);
    expect(await d.diagnosticInvoke('supplier_inbox_request', args)).toBe(args.data);
    expect(d.recentDiagnosticEvents().map(event => event.operation)).toEqual(['supplier_inbox_request', 'supplier_inbox_request']);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('supplier_inbox_request', args);
    closedEvents(d.recentDiagnosticEvents());
  });

  it('never coerces unknown command/action annotations and never copies an intent across commands', async () => {
    const d = await api(), read = vi.fn(() => { throw new Error('annotation coercion'); });
    const hostile = new Proxy({}, { get: read, getPrototypeOf: read, getOwnPropertyDescriptor: read });
    const args = { data: { action: 'import' } };
    d.withDiagnosticIntent(args, hostile as Parameters<typeof d.withDiagnosticIntent>[1], 'import');
    d.withDiagnosticIntent(args, 'supplier_inbox_request', hostile as Parameters<typeof d.withDiagnosticIntent>[2]);
    const body = d.withDiagnosticIntent({}, 'automation_request', 'settings');
    d.copyDiagnosticIntent(body, args, 'supplier_inbox_request');
    invoke.mockResolvedValue(true);
    await d.diagnosticInvoke('supplier_inbox_request', args);
    await d.diagnosticInvoke('appointment_inbox_request', d.withDiagnosticIntent({}, 'automation_request', 'decide'));
    expect(read).not.toHaveBeenCalled();
    expect(d.recentDiagnosticEvents().map(event => event.operation)).toEqual(['supplier_inbox_request', 'supplier_inbox_request', 'appointment_inbox_request', 'appointment_inbox_request']);
  });

  it('clears stale metadata on invalid reannotation, including boxed and hostile intentions', async () => {
    const d = await api(), read = vi.fn(() => { throw new Error('annotation inspection'); });
    const hostile = new Proxy({}, { get: read, getPrototypeOf: read, getOwnPropertyDescriptor: read });
    const args = {};
    for (const invalid of ['unknown_action', new String('import'), hostile]) {
      d.withDiagnosticIntent(args, 'supplier_inbox_request', 'import');
      expect(d.withDiagnosticIntent(args, 'supplier_inbox_request', invalid as Parameters<typeof d.withDiagnosticIntent>[2])).toBe(args);
      expect(d.diagnosticIntentOperation('supplier_inbox_request', args)).toBeUndefined();
    }
    d.withDiagnosticIntent(args, 'supplier_inbox_request', 'document');
    d.withDiagnosticIntent(args, hostile as Parameters<typeof d.withDiagnosticIntent>[1], 'document');
    expect(d.diagnosticIntentOperation('supplier_inbox_request', args)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    invoke.mockResolvedValue(true);
    await d.diagnosticInvoke('supplier_inbox_request', args);
    expect(d.recentDiagnosticEvents().map(event => event.operation)).toEqual(['supplier_inbox_request', 'supplier_inbox_request']);
  });

  it('clears an old target tag on invalid copy and retains valid metadata when source equals target', async () => {
    const d = await api(), target = {}, known = d.withDiagnosticIntent({}, 'automation_request', 'centre');
    for (const body of [null, {}, known]) {
      d.withDiagnosticIntent(target, 'supplier_inbox_request', 'document');
      expect(d.copyDiagnosticIntent(body, target, 'supplier_inbox_request')).toBe(target);
      expect(d.diagnosticIntentOperation('supplier_inbox_request', target)).toBeUndefined();
    }
    d.withDiagnosticIntent(target, 'supplier_inbox_request', 'import');
    expect(d.copyDiagnosticIntent(target, target, 'supplier_inbox_request')).toBe(target);
    expect(d.diagnosticIntentOperation('supplier_inbox_request', target)).toBe('supplier_inbox.import');
    d.copyDiagnosticIntent(target, target, 'appointment_inbox_request');
    expect(d.diagnosticIntentOperation('supplier_inbox_request', target)).toBeUndefined();
  });

  it('preserves the one-argument SDK call and ignores metadata for unrelated and diagnostic commands', async () => {
    const d = await api(); invoke.mockResolvedValue(true);
    await d.diagnosticInvoke('automation_request');
    expect(invoke.mock.calls[0]).toEqual(['automation_request']);
    const args = d.withDiagnosticIntent({}, 'automation_request', 'centre');
    await d.diagnosticInvoke('load_workspace', args);
    await d.diagnosticInvoke('get_diagnostics_summary', args);
    expect(invoke.mock.calls[1]).toEqual(['load_workspace', args]);
    expect(invoke.mock.calls[2]).toEqual(['get_diagnostics_summary', args]);
    expect(d.recentDiagnosticEvents().map(event => event.operation)).toEqual(['automation_request', 'automation_request', 'load_workspace', 'load_workspace']);
  });

  it('uses the real supplier request adapter without changing null, tagged or unknown bodies', async () => {
    const d = await api(), { inboxRequest } = await import('./supplierInbox');
    const result = { saved: true }; invoke.mockResolvedValue(result);
    expect(await inboxRequest()).toBe(result);
    const body = d.withDiagnosticIntent(Object.freeze({ action: 'import', invoice: privateMarker }), 'supplier_inbox_request', 'import');
    expect(await inboxRequest(body)).toBe(result);
    const unknown = Object.freeze({ action: 'document' });
    expect(await inboxRequest(unknown)).toBe(result);
    expect(invoke.mock.calls.map(call => call.length)).toEqual([2, 2, 2]);
    expect(invoke.mock.calls[0][1]).toEqual({ data: null });
    expect(invoke.mock.calls[1][1].data).toBe(body);
    expect(invoke.mock.calls[2][1].data).toBe(unknown);
    expect(d.recentDiagnosticEvents().map(event => event.operation)).toEqual(['supplier_inbox.state', 'supplier_inbox.state', 'supplier_inbox.import', 'supplier_inbox.import', 'supplier_inbox_request', 'supplier_inbox_request']);
    closedEvents(d.recentDiagnosticEvents());
  });

  it('uses the real Automation state/settings callsites and preserves their result and failure fallback', async () => {
    const d = await api(), automation = await import('./automation');
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const state = { organizationId: 'private-org', active: true }, settings = { enabled: true, consent: true, mode: 'shadow', flags: [], thresholds: { medium: 1, high: 2 } } as const;
    invoke.mockResolvedValueOnce(state).mockResolvedValueOnce(settings).mockRejectedValueOnce(new Error('network timeout'));
    expect(await automation.loadAutomationState()).toBe(state);
    expect(await automation.saveAutomationSettings({ ...settings, flags: [] })).toBe(settings);
    expect(await automation.automationState()).toBeNull();
    expect(invoke.mock.calls[0]).toEqual(['automation_request', { data: null }]);
    expect(invoke.mock.calls[1]).toEqual(['automation_request', { data: { action: 'settings', ...settings } }]);
    expect(invoke.mock.calls[2]).toEqual(['automation_request', { data: null }]);
    expect(d.recentDiagnosticEvents().map(event => [event.operation, event.phase])).toEqual([['automation.state', 'start'], ['automation.state', 'success'], ['automation.settings', 'start'], ['automation.settings', 'success'], ['automation.state', 'start'], ['automation.state', 'failure']]);
    expect(JSON.stringify(d.recentDiagnosticEvents())).not.toContain('private-org');
  });
});
