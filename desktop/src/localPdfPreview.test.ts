import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('./pdfRuntime', () => ({ getDocument: pdf.getDocument }));
import { renderPdfPages } from './localPdfPreview';
import { recentDiagnosticEvents } from './diagnostics';

const bytes = new Uint8Array([1, 2, 3]);
function previewFixture(numPages = 3) {
  const context = { fillStyle: '', fillRect: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: vi.fn().mockReturnValue(context), toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,synthetic') };
  vi.stubGlobal('document', { createElement: vi.fn().mockReturnValue(canvas) });
  const page = { getViewport: vi.fn(({ scale }) => ({ width: 300 * scale, height: 240 * scale })), render: vi.fn().mockReturnValue({ promise: Promise.resolve() }) };
  const document = { numPages, getPage: vi.fn().mockResolvedValue(page) };
  const task = { promise: Promise.resolve(document), destroy: vi.fn().mockResolvedValue(undefined) };
  Object.assign(document, { loadingTask: task });
  pdf.getDocument.mockReturnValue(task);
  return { task, document, page, canvas, context };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('renderPdfPages resource lifetime', () => {
  it('destroys a loading task rejected before a document exists', async () => {
    const { task } = previewFixture();
    const reason = new Error('Invalid PDF structure');
    task.promise = Promise.reject(reason);
    await expect(renderPdfPages(bytes)).rejects.toBe(reason);
    expect(task.destroy).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['getPage', 'getViewport', 'render', 'toDataURL'] as const)('destroys resources when %s fails and preserves the reason', async stage => {
    const { task, document, page, canvas } = previewFixture();
    const reason = new Error('Synthetic render interrupted');
    if (stage === 'getPage') document.getPage.mockRejectedValue(reason);
    else if (stage === 'getViewport') page.getViewport.mockImplementation(() => { throw reason; });
    else if (stage === 'render') page.render.mockReturnValue({ promise: Promise.reject(reason) });
    else canvas.toDataURL.mockImplementation(() => { throw reason; });
    await expect(renderPdfPages(bytes)).rejects.toBe(reason);
    expect(task.destroy).toHaveBeenCalledExactlyOnceWith();
    if (stage === 'render' || stage === 'toDataURL') expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it('clears the canvas and destroys the document when a canvas context is unavailable', async () => {
    const { task, canvas } = previewFixture();
    canvas.getContext.mockReturnValue(null);
    await expect(renderPdfPages(bytes)).rejects.toThrow("L'aperçu local du PDF n'a pas pu être préparé.");
    expect(task.destroy).toHaveBeenCalledOnce();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it.each([new Error('Original render error'), undefined])('does not replace the original rejection when destruction also fails (%s)', async reason => {
    const { task, page } = previewFixture();
    page.render.mockReturnValue({ promise: Promise.reject(reason) });
    task.destroy.mockRejectedValue(new Error('private-alice@example.ch /private/document.pdf secret-token'));
    const start = recentDiagnosticEvents().length;
    const observed = await renderPdfPages(bytes).then(() => ({ resolved: true }), error => ({ resolved: false, error }));
    expect(observed).toEqual({ resolved: false, error: reason });
    expect(task.destroy).toHaveBeenCalledOnce();
    const events = recentDiagnosticEvents().slice(start);
    expect(events.map(event => [event.operation, event.phase])).toEqual([['pdf.preview_cleanup', 'start'], ['pdf.preview_cleanup', 'failure']]);
    expect(events[0].id).toBe(events[1].id);
    expect(JSON.stringify(events)).not.toMatch(/alice|document\.pdf|secret-token|Original render/);
  });

  it('retains page count, rendering scale, JPEG quality and cap while releasing canvases after encoding', async () => {
    const { task, document, page, canvas, context } = previewFixture();
    canvas.toDataURL.mockImplementation(() => {
      expect([canvas.width, canvas.height]).toEqual([900, 720]);
      return 'data:image/jpeg;base64,synthetic';
    });
    await expect(renderPdfPages(bytes, 2)).resolves.toEqual({ pageCount: 3, pages: ['data:image/jpeg;base64,synthetic', 'data:image/jpeg;base64,synthetic'] });
    expect(document.getPage.mock.calls).toEqual([[1], [2]]);
    expect(page.render).toHaveBeenCalledTimes(2);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 900, 720);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.94);
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it('preserves URL input and does not settle before destruction completes', async () => {
    const { task } = previewFixture(1);
    let release!: () => void;
    task.destroy.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const preview = renderPdfPages('blob:synthetic-local-pdf').finally(() => { settled = true; });
    await vi.waitFor(() => expect(task.destroy).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    release();
    await expect(preview).resolves.toMatchObject({ pageCount: 1 });
    expect(pdf.getDocument).toHaveBeenCalledExactlyOnceWith({ url: 'blob:synthetic-local-pdf' });
  });

  it('rejects a cleanup failure after successful rendering instead of reporting false success', async () => {
    const { task } = previewFixture(1);
    const reason = new Error('Synthetic destruction failure');
    task.destroy.mockRejectedValue(reason);
    await expect(renderPdfPages(bytes)).rejects.toBe(reason);
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it('destroys a document with no readable pages', async () => {
    const { task } = previewFixture(0);
    await expect(renderPdfPages(bytes)).rejects.toThrow('Le PDF ne contient aucune page lisible.');
    expect(task.destroy).toHaveBeenCalledOnce();
  });
});
