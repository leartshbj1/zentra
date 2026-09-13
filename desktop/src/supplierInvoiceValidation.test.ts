import { describe, expect, it, vi } from 'vitest';
import type { SupplierInvoice, Workspace } from './types';
import { runSupplierInvoiceValidation, supplierInvoiceWasValidated, SupplierInvoiceValidationOutcomeUnknownError, SupplierInvoiceValidationRefreshError } from './supplierInvoiceValidation';

const invoice = (validated = true) => ({ id: 'invoice', documentStatus: validated ? 'validated' : 'draft', validationJournalEntryId: validated ? 'entry' : null }) as SupplierInvoice;
const workspace = (invoices = [invoice()]) => ({ onboardingCompleted: true, settings: {}, supplierInvoices: invoices }) as Workspace;
describe('supplier validation recovery', () => {
  it('requires this invoice and its accounting link, not just a successful workspace read', () => {
    expect(supplierInvoiceWasValidated(workspace(), 'invoice')).toBe(true);
    expect(supplierInvoiceWasValidated(workspace([invoice(false)]), 'invoice')).toBe(false);
    for (const data of [workspace([]), workspace([invoice(), invoice()]), workspace([{ ...invoice(), validationJournalEntryId: null }]), {} as Workspace]) {
      expect(() => supplierInvoiceWasValidated(data, 'invoice')).toThrow();
    }
  });
  it('recovers a lost response by reading the validated document without repeating the write', async () => {
    const cause = Error('Lost response'), write = vi.fn().mockRejectedValue(cause), load = vi.fn().mockResolvedValue(workspace());
    const error = await runSupplierInvoiceValidation('invoice', write, load).catch(error => error);
    expect(error).toBeInstanceOf(SupplierInvoiceValidationOutcomeUnknownError);
    expect(error.mutationCause).toBe(cause); expect(load).not.toHaveBeenCalled();
    expect(error.wasRecorded(await load())).toBe(true); expect(write).toHaveBeenCalledTimes(1);
  });
  it('preserves a definite refusal when the later read still shows the draft', async () => {
    const cause = Error('Closed period');
    const error = await runSupplierInvoiceValidation('invoice', async () => { throw cause; }, async () => workspace()).catch(error => error);
    expect(error.wasRecorded(workspace([invoice(false)]))).toBe(false);
    expect(error.mutationCause).toBe(cause);
  });
  it('holds an acknowledged validation until both the validated status and journal link can be read', async () => {
    const write = vi.fn().mockResolvedValue({});
    const error = await runSupplierInvoiceValidation('invoice', write, async () => workspace([invoice(false)])).catch(error => error);
    expect(error).toBeInstanceOf(SupplierInvoiceValidationRefreshError);
    expect(() => error.validateRead(workspace([]))).toThrow();
    expect(() => error.validateRead(workspace())).not.toThrow(); expect(write).toHaveBeenCalledTimes(1);
  });
  it('returns the new workspace when validation and its read succeed', async () => {
    const data = workspace(); expect(await runSupplierInvoiceValidation('invoice', async () => ({}), async () => data)).toBe(data);
  });
});
