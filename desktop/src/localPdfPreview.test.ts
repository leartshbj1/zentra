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

describe('renderPdfPages bounded page allocations', () => {
  it.each([
    ['square plan', 10_000, 10_000, 1],
    ['tall plan', 100, 10_000, 1],
    ['wide plan', 10_000, 100, 1],
    ['finite dimensions whose area overflows', 1e200, 2e200, 1],
    ['extreme finite userUnit', 595, 842, 1e300],
    ['tiny finite userUnit with a large view box', 1e200, 2e200, 1e-200],
    ['extreme finite width with a nonzero scaled height', Number.MAX_VALUE, 1e294, 1],
  ] as const)('keeps %s complete within 4 MP and 4096 px', async (_, width, height, userUnit) => {
    const {task,page,canvas} = previewFixture(1);
    // PDF.js PageViewport multiplies scale by userUnit before each view-box
    // dimension. These test doubles never allocate an actual bitmap.
    page.getViewport.mockImplementation(({scale}) => ({width:width*(scale*userUnit),height:height*(scale*userUnit)}));
    let encoded = false;
    canvas.toDataURL.mockImplementation(() => {
      encoded = true;
      expect(Number.isInteger(canvas.width) && Number.isInteger(canvas.height)).toBe(true);
      expect(canvas.width).toBeGreaterThan(0);
      expect(canvas.height).toBeGreaterThan(0);
      expect(canvas.width).toBeLessThanOrEqual(4096);
      expect(canvas.height).toBeLessThanOrEqual(4096);
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(4_000_000);
      return 'data:image/jpeg;base64,synthetic';
    });
    await expect(renderPdfPages(bytes,1)).resolves.toEqual({pageCount:1,pages:['data:image/jpeg;base64,synthetic']});
    expect(encoded).toBe(true);
    expect(page.render).toHaveBeenCalledOnce();
    const viewport=page.render.mock.calls[0][0].viewport;
    const originalRatio=width/height;
    expect(Math.abs((viewport.width/viewport.height)/originalRatio-1)).toBeLessThan(1e-12);
    expect([canvas.width,canvas.height]).toEqual([0,0]);
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it('preserves the exact ordinary A4 dimensions and JPEG contract', async () => {
    const {task,page,canvas} = previewFixture(1);
    page.getViewport.mockImplementation(({scale}) => ({width:595*scale,height:842*scale}));
    canvas.toDataURL.mockImplementation(() => {
      expect([canvas.width,canvas.height]).toEqual([1272,1800]);
      return 'data:image/jpeg;base64,synthetic';
    });
    await expect(renderPdfPages(bytes,1)).resolves.toMatchObject({pageCount:1});
    expect(canvas.toDataURL).toHaveBeenCalledExactlyOnceWith('image/jpeg',0.94);
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ['zero width',0,240],['zero height',300,0],
    ['negative width',-300,240],['negative height',300,-240],
    ['NaN width',Number.NaN,240],['NaN height',300,Number.NaN],
    ['infinite width',Number.POSITIVE_INFINITY,240],['infinite height',300,Number.POSITIVE_INFINITY],
  ] as const)('refuses an invalid initial viewport (%s) before creating a canvas', async (_, width, height) => {
    const {task,page} = previewFixture(1);
    page.getViewport.mockReturnValue({width,height});
    await expect(renderPdfPages(bytes,1)).rejects.toThrow('Le fichier PDF contient une page de taille invalide.');
    expect(globalThis.document.createElement).not.toHaveBeenCalled();
    expect(page.render).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ['zero width',0,240],['zero height',300,0],
    ['negative width',-300,240],['negative height',300,-240],
    ['NaN width',Number.NaN,240],['NaN height',300,Number.NaN],
    ['infinite width',Number.POSITIVE_INFINITY,240],['infinite height',300,Number.POSITIVE_INFINITY],
  ] as const)('refuses an invalid scaled viewport (%s) before creating a canvas', async (_, width, height) => {
    const {task,page} = previewFixture(1);
    page.getViewport.mockReturnValueOnce({width:300,height:240}).mockReturnValueOnce({width,height});
    await expect(renderPdfPages(bytes,1)).rejects.toThrow('Le fichier PDF contient une page de taille invalide.');
    expect(globalThis.document.createElement).not.toHaveBeenCalled();
    expect(page.render).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it('refuses final underflow from a finite extreme aspect ratio without allocating', async () => {
    const {task,page} = previewFixture(1);
    page.getViewport.mockImplementation(({scale}) => ({width:Number.MAX_VALUE*scale,height:Number.MIN_VALUE*scale}));
    await expect(renderPdfPages(bytes,1)).rejects.toThrow('Le fichier PDF contient une page de taille invalide.');
    expect(globalThis.document.createElement).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledOnce();
  });
});
