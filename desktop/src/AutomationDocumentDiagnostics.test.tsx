import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const pipeline = vi.hoisted(() => ({ text: vi.fn(), render: vi.fn(), image: vi.fn(), ocr: vi.fn() }));
vi.mock('./payrollPdfText', () => ({ extractPayrollPdfTextByPage: pipeline.text }));
vi.mock('./localPdfPreview', () => ({ renderPdfPages: pipeline.render, prepareImageForAnalysis: pipeline.image }));
vi.mock('./payrollOcr', () => ({ readPayslipImages: pipeline.ocr }));
vi.mock('./AutomationControls', () => ({ DocumentClassification: 'div', useAutomation: vi.fn() }));
vi.mock('./AutomationCompany', () => ({ useCompanyAutomation: () => ({ state: null }) }));
vi.mock('./language', () => ({ getAppLanguage: () => 'fr', useAppLanguage: () => 'fr', t: (value: string) => value }));
vi.mock('./ui', () => ({ Button: 'button' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  pipeline.text.mockResolvedValue({ pages: [''], pageCount: 1 });
  pipeline.render.mockResolvedValue({ pages: ['private-rendered-image'], pageCount: 1 });
  pipeline.image.mockResolvedValue('private-prepared-image');
  pipeline.ocr.mockResolvedValue({ text: 'private-document-content' });
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function trace(phase: 'success' | 'failure', original?: unknown, errorCode?: string) {
  const d = await import('./diagnostics'), events = d.recentDiagnosticEvents();
  expect(events.map(event => [event.area, event.operation, event.phase])).toEqual([
    ['app', 'automation.document_read', 'start'], ['app', 'automation.document_read', phase],
  ]);
  expect(events[1].id).toBe(events[0].id); expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
  if (errorCode) expect(events[1].errorCode).toBe(errorCode);
  if (original) expect(d.resolveErrorIncident(original).code).toBe(`ZT-${events[1].id}`);
  expect(JSON.stringify(events)).not.toMatch(/private|alice@example|filename|base64|fileName|OCR|document-content|password|token|PDF structure/);
}
describe('Automation local document diagnostics', () => {
  it.each(['txt', 'csv'])('preserves the %s excerpt and logs no file or extracted contents', async extension => {
    const { localDocumentExcerpt } = await import('./AutomationDocument');
    const text = 'private-document-content '.repeat(100), file = new File([text], `private-alice@example.ch.${extension}`);
    expect(await localDocumentExcerpt(file)).toBe(text.slice(0, 1800));
    expect(pipeline.text).not.toHaveBeenCalled(); expect(pipeline.ocr).not.toHaveBeenCalled(); await trace('success');
  });
  it('preserves a browser read rejection and links its incident without error text', async () => {
    const { localDocumentExcerpt } = await import('./AutomationDocument'), original = new DOMException('private-file-read token=private-secret', 'NotReadableError');
    const file = new File(['original'], 'private-alice@example.ch.txt');
    vi.spyOn(file, 'slice').mockReturnValue({ text: () => Promise.reject(original) } as Blob);
    await expect(localDocumentExcerpt(file)).rejects.toBe(original); await trace('failure', original, 'INTERNAL');
  });
  it('records the original PDF parser rejection before UI consumers may fall back', async () => {
    const { localDocumentExcerpt } = await import('./AutomationDocument'), original = Object.assign(new Error('Invalid PDF structure token=private-secret'), { name: 'InvalidPDFException' });
    pipeline.text.mockRejectedValue(original); const file = new File(['%PDF invalid'], 'private-alice@example.ch.pdf');
    await expect(localDocumentExcerpt(file)).rejects.toBe(original);
    expect(pipeline.text).toHaveBeenCalledWith(expect.any(Uint8Array), 2); expect(pipeline.render).not.toHaveBeenCalled(); expect(pipeline.ocr).not.toHaveBeenCalled();
    await trace('failure', original, 'VALIDATION');
  });
  it('preserves usable PDF text and does not add OCR or another request', async () => {
    const { localDocumentExcerpt } = await import('./AutomationDocument'), text = 'private PDF extracted text '.repeat(100); pipeline.text.mockResolvedValue({ pages: [text], pageCount: 1 });
    expect(await localDocumentExcerpt(new File(['original PDF bytes'], 'private.pdf'))).toBe(text.slice(0, 1800));
    expect(pipeline.text).toHaveBeenCalledOnce(); expect(pipeline.render).not.toHaveBeenCalled(); expect(pipeline.ocr).not.toHaveBeenCalled(); await trace('success');
  });
  it('preserves the PDF image/OCR fallback and returns only the existing excerpt', async () => {
    const { localDocumentExcerpt } = await import('./AutomationDocument'), text = 'private OCR contents '.repeat(100); pipeline.ocr.mockResolvedValue({ text });
    expect(await localDocumentExcerpt(new File(['original PDF bytes'], 'private.pdf'))).toBe(text.slice(0, 1800));
    expect(pipeline.render).toHaveBeenCalledWith(expect.any(Uint8Array), 2);
    expect(pipeline.ocr).toHaveBeenCalledWith(['private-rendered-image'], 'http://localhost/', expect.any(Function)); await trace('success');
  });
  it('preserves image rejection and object URL cleanup', async () => {
    const { localDocumentExcerpt } = await import('./AutomationDocument'), original = new Error('network private-image token=private-secret');
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-image'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); pipeline.image.mockRejectedValue(original);
    const file = new File(['image bytes'], 'private-alice@example.ch.png'); await expect(localDocumentExcerpt(file)).rejects.toBe(original);
    expect(create).toHaveBeenCalledWith(file); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:private-image'); expect(pipeline.ocr).not.toHaveBeenCalled(); await trace('failure', original, 'NETWORK');
  });
  it('preserves an OCR rejection without retrying or logging OCR inputs', async () => {
    const { localDocumentExcerpt } = await import('./AutomationDocument'), original = new Error('private-OCR-read-failed password=private-secret'); pipeline.ocr.mockRejectedValue(original);
    await expect(localDocumentExcerpt(new File(['original PDF bytes'], 'private.pdf'))).rejects.toBe(original);
    expect(pipeline.ocr).toHaveBeenCalledOnce(); expect(pipeline.render).toHaveBeenCalledOnce(); await trace('failure', original, 'INTERNAL');
  });
});
