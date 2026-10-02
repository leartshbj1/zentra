import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real serializers and normalisation, closed native transport. These tests do
// not execute SQL, generate documents, send messages or contact a service.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('./diagnostics', () => ({ diagnosticInvoke: invokeMock }));
import { desktopApi } from './bridge';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

const scope = 'synthetic-background-origin-a';
const requestId = 'bf1a171a-1653-49a9-9ab4-9e603190fbdf';
const scheduleId = 'a424234a-609e-487f-8b65-cc5d6bce4b04';
const input = { requestId: ` ${requestId} `, scheduleId: ` ${scheduleId} `, throughDate: ' 2026-10-02 ' };
const rawWorkspace = (workNotesScope = scope) => ({ work_notes_scope: workNotesScope, settings: { company_name: 'Synthetic company' } });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'get_app_state') return { onboarding_completed: 1 };
    if (command === 'get_workspace') return rawWorkspace();
    if (command === 'get_reminder_settings') return { enabled: 1, sender_name: 'Synthetic sender', last_scan_at: '2026-10-02T10:00:00Z' };
    if (command === 'scan_due_reminders') return { as_of: '2026-10-02', enabled: 1, created: [], cancelled: ['synthetic-old'], review: [], idempotent: 1 };
    if (command === 'generate_recurrence_occurrences') return {};
    throw new Error(`Unexpected command: ${command}`);
  });
});

describe('background checks keep their originating workspace at the IPC boundary', () => {
  it('scopes the settings read without changing its normalised result', async () => {
    expect(await desktopApi.getReminderSettings(scope)).toEqual({ enabled: true, senderName: 'Synthetic sender', lastScanAt: '2026-10-02T10:00:00Z' });
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('get_reminder_settings', { expectedWorkspaceScope: scope });
  });

  it('scopes the due scan outside the strict business input', async () => {
    expect(await desktopApi.scanDueReminders(requestId, '2026-10-02', scope)).toMatchObject({ enabled: true, cancelled: ['synthetic-old'], idempotent: true });
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('scan_due_reminders', {
      expectedWorkspaceScope: scope, input: { request_id: requestId, as_of: '2026-10-02' },
    });
  });

  it('keeps a null date, the request ID and the origin during a scan', async () => {
    await desktopApi.scanDueReminders(requestId, undefined, scope);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('scan_due_reminders', {
      expectedWorkspaceScope: scope, input: { request_id: requestId, as_of: null },
    });
  });

  it('keeps legacy omissions and payloads for existing explicit callers', async () => {
    await desktopApi.getReminderSettings();
    await desktopApi.scanDueReminders(requestId);
    await desktopApi.generateRecurrenceOccurrences(input);
    expect(invokeMock.mock.calls[0]).toEqual(['get_reminder_settings']);
    expect(invokeMock.mock.calls[1]).toEqual(['scan_due_reminders', { input: { request_id: requestId, as_of: null } }]);
    expect(invokeMock.mock.calls[2]).toEqual(['generate_recurrence_occurrences', { input: {
      request_id: requestId, schedule_id: scheduleId, through_date: '2026-10-02',
    } }]);
  });

  it('passes the recurrence scope separately and refreshes once in that origin', async () => {
    const next = await desktopApi.generateRecurrenceOccurrences(input, scope);
    expect(next.workNotesScope).toBe(scope);
    expect(invokeMock.mock.calls).toEqual([
      ['generate_recurrence_occurrences', { expectedWorkspaceScope: scope, input: {
        request_id: requestId, schedule_id: scheduleId, through_date: '2026-10-02',
      } }], ['get_app_state'], ['get_workspace'],
    ]);
  });

  it('does not expose a different space as the receipt of a confirmed generation', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'generate_recurrence_occurrences') return {};
      if (command === 'get_app_state') return { onboarding_completed: 1 };
      if (command === 'get_workspace') return rawWorkspace('synthetic-background-space-b');
      throw new Error(`Unexpected command: ${command}`);
    });
    const error = await desktopApi.generateRecurrenceOccurrences(input, scope).catch(reason => reason);
    expect(error).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(error.refreshCause).toBeInstanceOf(Error);
    expect(error.refreshCause.message).toMatch(/entreprise ouverte a changé/i);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(['generate_recurrence_occurrences', 'get_app_state', 'get_workspace']);
  });

  it.each(['get_reminder_settings', 'scan_due_reminders', 'generate_recurrence_occurrences'] as const)('preserves %s refusal without retrying or refreshing', async command => {
    const refusal = new Error('Synthetic origin refusal');
    invokeMock.mockRejectedValue(refusal);
    const task = command === 'get_reminder_settings' ? desktopApi.getReminderSettings(scope)
      : command === 'scan_due_reminders' ? desktopApi.scanDueReminders(requestId, undefined, scope)
      : desktopApi.generateRecurrenceOccurrences(input, scope);
    await expect(task).rejects.toBe(refusal);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe(command);
  });

  it('keeps a confirmed-generation read failure separate from a native refusal without replay', async () => {
    const cause = new Error('Synthetic read unavailable');
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'generate_recurrence_occurrences') return {};
      if (command === 'get_app_state') throw cause;
      throw new Error(`Unexpected command: ${command}`);
    });
    const error = await desktopApi.generateRecurrenceOccurrences(input, scope).catch(reason => reason);
    expect(error).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(error.refreshCause).toBe(cause);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(['generate_recurrence_occurrences', 'get_app_state']);
  });
});
