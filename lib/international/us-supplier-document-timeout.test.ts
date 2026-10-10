import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ resolveModule: vi.fn(), open: vi.fn(), extract: vi.fn(), destroy: vi.fn(async () => {}) }));
vi.mock('unpdf', () => ({ getResolvedPDFJS: f.resolveModule, extractText: f.extract }));
import { supplierDocumentText } from './us-supplier-document-bytes';
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); f.resolveModule.mockResolvedValue({ getDocument: f.open }); });
afterEach(() => vi.useRealTimers());
describe('PDF deadline owns its loading task', () => {
  it('cancels an opening task that never resolves', async () => {
    f.open.mockReturnValue({ promise: new Promise(() => {}), destroy: f.destroy });
    const result = supplierDocumentText(new Uint8Array([1]), 'application/pdf');
    await vi.advanceTimersByTimeAsync(8000);
    expect(await result).toBeNull(); expect(f.destroy).toHaveBeenCalledTimes(1); expect(f.extract).not.toHaveBeenCalled();
  });
  it('cancels a suspended extraction and ignores a late result', async () => {
    let resolve!: (v: { text: string }) => void;
    f.open.mockReturnValue({ promise: Promise.resolve({ numPages: 1 }), destroy: f.destroy });
    f.extract.mockImplementation(() => new Promise(r => { resolve = r; }));
    const result = supplierDocumentText(new Uint8Array([1]), 'application/pdf');
    await vi.advanceTimersByTimeAsync(8000); expect(await result).toBeNull();
    resolve({ text: 'late output' }); await vi.advanceTimersByTimeAsync(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });
  it('does not start a document after delayed module loading crosses deadline', async () => {
    let resolve!: (v: unknown) => void; f.resolveModule.mockImplementation(() => new Promise(r => { resolve = r; }));
    const result = supplierDocumentText(new Uint8Array([1]), 'application/pdf');
    await vi.advanceTimersByTimeAsync(8000); expect(await result).toBeNull();
    resolve({ getDocument: f.open }); await vi.advanceTimersByTimeAsync(1);
    expect(f.open).not.toHaveBeenCalled();
  });
  it('rejects extracted UTF8 beyond the limit without keeping a prefix', async () => {
    f.open.mockReturnValue({ promise: Promise.resolve({ numPages: 1 }), destroy: f.destroy });
    f.extract.mockResolvedValue({ text: 'é'.repeat(8193) });
    expect(await supplierDocumentText(new Uint8Array([1]), 'application/pdf')).toBeNull(); expect(f.destroy).toHaveBeenCalledTimes(1);
  });
});
