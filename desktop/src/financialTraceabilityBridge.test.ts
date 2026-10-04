import { afterEach, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';

afterEach(() => invokeMock.mockReset());
it('projects actual persisted invoice cents without recalculation and leaves historical missing amounts absent', async () => {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'get_app_state') return { onboarding_completed: true };
    if (command === 'get_workspace') return {
      invoices: [{ id: 'credit', number: 'AV-42', type: 'avoir', status: 'emise', issue_date: '2026-02-03', currency: 'EUR' }],
      invoice_items: [
        { id: 'recorded', invoice_id: 'credit', position: 0, description: 'Montants conservés', quantity: 1, unit_price_cents: 999999, vat_bp: 810, line_net_cents: -2500, line_vat_cents: -203, line_total_cents: -2703 },
        { id: 'legacy', invoice_id: 'credit', position: 1, description: 'Ancienne ligne', quantity: 1, unit_price_cents: 5000, vat_bp: 810 },
      ],
    };
    throw new Error(`Unexpected read: ${command}`);
  });
  const workspace = await desktopApi.loadWorkspace();
  expect(workspace.invoices[0]).toMatchObject({ id: 'credit', type: 'credit_note', status: 'issued', currency: 'EUR' });
  expect(workspace.invoices[0].lines[0]).toMatchObject({ unitPriceCents: 999999, recordedAmounts: { netCents: -2500, vatCents: -203, totalCents: -2703 } });
  expect(workspace.invoices[0].lines[1].recordedAmounts).toBeUndefined();
  expect(invokeMock.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'get_workspace']);
});
