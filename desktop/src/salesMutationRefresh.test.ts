import { beforeEach, describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

const request = '39c85c22-7fc0-42d0-95f9-c1ad536fe2cf';
const operations = [
  { command: 'save_delivery_note_draft', run: () => desktopApi.saveDeliveryNoteDraft({ id: request, salesOrderId: 'order', deliveryDate: '2026-09-05', lines: [{ salesOrderLineId: 'line', quantityMilli: 2000 }] }) },
  { command: 'issue_delivery_note', run: () => desktopApi.issueDeliveryNote(request, 'delivery') },
  { command: 'reverse_delivery_note', run: () => desktopApi.reverseDeliveryNote(request, 'delivery', 'Retour client') },
  { command: 'confirm_sales_order', run: () => desktopApi.confirmSalesOrder(request, 'order') },
  { command: 'create_sales_order_invoice', run: () => desktopApi.createSalesOrderInvoice({ requestId: request, salesOrderId: 'order', serviceDateFrom: '2026-09-01', serviceDateTo: '2026-09-05', allocations: [{ salesOrderLineId: 'line', deliveryNoteLineId: 'delivery-line', quantityMilli: 2000 }] }) },
];

describe('reprise des commandes après écriture locale confirmée', () => {
  beforeEach(() => { invokeMock.mockReset(); });
  it.each(operations)('$command distingue une écriture confirmée d’une lecture interrompue', async ({ command, run }) => {
    const cause = new Error('Lecture interrompue');
    invokeMock.mockImplementation(async (name: string) => {
      if (name === command) return {};
      if (name === 'get_app_state') throw cause;
      throw new Error(`unexpected ${name}`);
    });
    const error = await run().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect((error as WorkspaceRefreshAfterMutationError).refreshCause).toBe(cause);
    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual([command, 'get_app_state']);
  });
  it.each(operations)('$command ne présente jamais un refus natif comme une écriture réussie', async ({ command, run }) => {
    const error = new Error('Période fermée');
    invokeMock.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe(command);
  });
  it('renvoie directement les données lorsque l’écriture et la lecture réussissent', async () => {
    invokeMock.mockImplementation(async (command: string) => command === 'get_app_state' ? { onboarding_completed: 0 } : {});
    const workspace = await operations[0].run();
    expect(workspace.onboardingCompleted).toBe(false);
    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(['save_delivery_note_draft', 'get_app_state']);
  });
});
