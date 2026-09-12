import { beforeEach, expect, it, vi } from 'vitest';
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
beforeEach(() => { invokeMock.mockReset(); });
it('distingue la création réussie de la facture de temps de la lecture échouée', async () => {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'create_invoice_from_time_entries') return { invoice_id: 'created' };
    throw new Error('Lecture indisponible');
  });
  await expect(desktopApi.createInvoiceFromTimeEntries({ requestId: 'request', projectId: 'project', timeEntryIds: ['entry'], vatBp: 810 })).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
  expect(invokeMock.mock.calls.filter(([command]) => command === 'create_invoice_from_time_entries')).toHaveLength(1);
  expect(invokeMock.mock.calls.some(([command]) => command === 'get_app_state')).toBe(true);
});
it('ne présente pas un refus natif comme une facture enregistrée', async () => {
  invokeMock.mockRejectedValue(new Error('Ces heures sont déjà réservées.'));
  await expect(desktopApi.createInvoiceFromTimeEntries({ requestId: 'request', projectId: 'project', timeEntryIds: ['entry'] })).rejects.toThrow('Ces heures sont déjà réservées.');
  expect(invokeMock).toHaveBeenCalledTimes(1);
});
