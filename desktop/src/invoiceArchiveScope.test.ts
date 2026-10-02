import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, Channel: class {} }));
import { desktopApi } from './bridge';

const receipt = { archiveId: 'synthetic-receipt', revision: 2, contentSha256: 'synthetic-hash', retentionUntil: '2036-12-31', alreadyStored: true };
const archiveCalls = () => native.invoke.mock.calls.filter(([command]) => command === 'archive_invoice_to_cloud');
beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(receipt);
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe('portée d’origine de l’archivage de facture', () => {
  it('transmet la portée capturée même si le contexte change pendant la réponse', async () => {
    let release!: (value: typeof receipt) => void;
    native.invoke.mockImplementation(command => command === 'archive_invoice_to_cloud' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({}));
    let currentScope = 'synthetic-origin';
    const pending = desktopApi.archiveInvoiceToCloud('synthetic-invoice', undefined, currentScope);
    currentScope = 'synthetic-restored';
    release(receipt);
    await expect(pending).resolves.toEqual(receipt);
    expect(currentScope).toBe('synthetic-restored');
    expect(archiveCalls()).toEqual([['archive_invoice_to_cloud', { invoiceId: 'synthetic-invoice', correctionReason: null, expectedWorkspaceScope: 'synthetic-origin' }]]);
  });

  it('garde la même portée lors d’une demande avec motif de correction', async () => {
    await desktopApi.archiveInvoiceToCloud('synthetic-invoice', '  Synthetic correction  ', 'synthetic-origin');
    expect(archiveCalls()).toEqual([['archive_invoice_to_cloud', { invoiceId: 'synthetic-invoice', correctionReason: 'Synthetic correction', expectedWorkspaceScope: 'synthetic-origin' }]]);
  });

  it('conserve les arguments legacy lorsque la portée est omise', async () => {
    await desktopApi.archiveInvoiceToCloud('synthetic-invoice');
    expect(archiveCalls()).toEqual([['archive_invoice_to_cloud', { invoiceId: 'synthetic-invoice', correctionReason: null }]]);
  });

  it('conserve le reçu d’archivage et la distinction déjà conservé', async () => {
    await expect(desktopApi.archiveInvoiceToCloud('synthetic-invoice')).resolves.toEqual(receipt);
    native.invoke.mockResolvedValueOnce({ ...receipt, alreadyStored: false });
    await expect(desktopApi.archiveInvoiceToCloud('synthetic-invoice')).resolves.toEqual({ ...receipt, alreadyStored: false });
  });

  it('conserve l’identité du refus natif sans relancer l’archivage', async () => {
    const original = new Error('Synthetic obsolete workspace refusal');
    native.invoke.mockRejectedValue(original);
    await expect(desktopApi.archiveInvoiceToCloud('synthetic-invoice')).rejects.toBe(original);
    expect(archiveCalls()).toHaveLength(1);
  });
});
