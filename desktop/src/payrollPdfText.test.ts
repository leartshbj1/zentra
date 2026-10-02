import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('./pdfRuntime', () => ({ getDocument: pdf.getDocument }));
import { extractPayrollPdfTextByPage } from './payrollPdfText';
import { recentDiagnosticEvents } from './diagnostics';

const bytes = new Uint8Array([1, 2, 3]);
function documentFixture(numPages = 3) {
  const page = {
    getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'First line', hasEOL: true }, { str: 'Second line' }] }),
    getViewport: vi.fn().mockReturnValue({ width: 300, height: 240 }),
    cleanup: vi.fn(),
  };
  const document = { numPages, getPage: vi.fn().mockResolvedValue(page) };
  const task = { promise: Promise.resolve(document), destroy: vi.fn().mockResolvedValue(undefined) };
  pdf.getDocument.mockReturnValue(task);
  return { task, document, page };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('extractPayrollPdfTextByPage resource lifetime', () => {
  it('destroys a loading task rejected before a document exists', async () => {
    const reason = new Error('Invalid PDF structure');
    const { task } = documentFixture();
    task.promise = Promise.reject(reason);
    await expect(extractPayrollPdfTextByPage(bytes)).rejects.toBe(reason);
    expect(task.destroy).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['getPage', 'getTextContent', 'getViewport', 'cleanup'] as const)('destroys resources when %s fails and preserves the reason', async stage => {
    const reason = new Error('Synthetic processing failure');
    const { task, document, page } = documentFixture();
    if (stage === 'getPage') document.getPage.mockRejectedValue(reason);
    else if (stage === 'getTextContent') page.getTextContent.mockRejectedValue(reason);
    else page[stage].mockImplementation(() => { throw reason; });
    await expect(extractPayrollPdfTextByPage(bytes)).rejects.toBe(reason);
    expect(task.destroy).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    ['loading', new Error('Original PDF error')], ['loading', undefined],
    ['text', new Error('Original PDF error')], ['text', undefined],
  ] as const)('does not replace the original %s rejection when destruction also fails (%s)', async (stage, reason) => {
    const { task, page } = documentFixture();
    if (stage === 'loading') task.promise = Promise.reject(reason);
    else page.getTextContent.mockRejectedValue(reason);
    task.destroy.mockRejectedValue(new Error('private-alice@example.ch /private/document.pdf secret-token'));
    const start = recentDiagnosticEvents().length;
    const observed = await extractPayrollPdfTextByPage(bytes).then(() => ({ resolved: true }), error => ({ resolved: false, error }));
    expect(observed).toEqual({ resolved: false, error: reason });
    expect(task.destroy).toHaveBeenCalledExactlyOnceWith();
    const events = recentDiagnosticEvents().slice(start);
    expect(events.map(event => [event.operation, event.phase])).toEqual([['pdf.text_cleanup', 'start'], ['pdf.text_cleanup', 'failure']]);
    expect(events[0].id).toBe(events[1].id);
    expect(JSON.stringify(events)).not.toMatch(/alice|document\.pdf|secret-token|Original PDF/);
  });

  it('retains page count, text normalization, page cap and cleanup, and awaits destruction', async () => {
    const { task, document, page } = documentFixture();
    let release!: () => void;
    task.destroy.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const reading = extractPayrollPdfTextByPage(bytes, 2).finally(() => { settled = true; });
    await vi.waitFor(() => expect(task.destroy).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    release();
    await expect(reading).resolves.toEqual({ pageCount: 3, pages: ['First line\nSecond line', 'First line\nSecond line'] });
    expect(pdf.getDocument).toHaveBeenCalledExactlyOnceWith({ data: bytes });
    expect(document.getPage.mock.calls).toEqual([[1], [2]]);
    expect(page.cleanup).toHaveBeenCalledTimes(2);
  });

  it('rejects a cleanup failure after successful extraction instead of reporting false success', async () => {
    const { task } = documentFixture();
    const reason = new Error('Synthetic destruction failure');
    task.destroy.mockRejectedValue(reason);
    await expect(extractPayrollPdfTextByPage(bytes, 1)).rejects.toBe(reason);
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it('destroys a document with no readable pages', async () => {
    const { task } = documentFixture(0);
    await expect(extractPayrollPdfTextByPage(bytes)).rejects.toThrow('Le PDF ne contient aucune page lisible.');
    expect(task.destroy).toHaveBeenCalledOnce();
  });
});
