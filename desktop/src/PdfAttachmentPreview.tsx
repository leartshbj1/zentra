import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Scan, ZoomIn, ZoomOut } from 'lucide-react';
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from './pdfRuntime';
import { Button, ErrorPanel } from './ui';

function previewError(reason: unknown) {
  const protectedPdf = reason instanceof Error && reason.name === 'PasswordException';
  return { retryable: !protectedPdf, message: protectedPdf
    ? 'Ce PDF est protégé par un mot de passe. Ouvrez-le avec une application compatible.'
    : 'Ce PDF ne peut pas être affiché. Réessayez, ou ouvrez-le avec une application compatible.' };
}

export default function PdfAttachmentPreview({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof previewError> | null>(null);
  const [text, setText] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDocument(null); setPage(1); setError(null); setLoading(true);
    // PDF.js transfers its data buffer to the worker. Keep the original bytes for
    // retry/download and destroy the worker when the reader is closed.
    let task: PDFDocumentLoadingTask | undefined;
    try {
      task = getDocument({ data: bytes.slice() });
      void task.promise.then(pdf => { if (!cancelled) setDocument(pdf); })
        .catch(reason => { if (!cancelled) { setError(previewError(reason)); setLoading(false); } });
    } catch (reason) {
      setError(previewError(reason)); setLoading(false);
    }
    return () => { cancelled = true; void task?.destroy().catch(() => {}); };
  }, [bytes, attempt]);

  useEffect(() => {
    const element = viewport.current!;
    const measure = () => setWidth(Math.max(1, Math.floor(element.clientWidth - 32)));
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !width) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    const canvas = window.document.createElement('canvas');
    setLoading(true); setError(null); setText('');
    surface.current!.replaceChildren();
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled) { pdfPage.cleanup(); return; }
      try {
        const initial = pdfPage.getViewport({ scale: 1 });
        const cssWidth = Math.min(width, 1100) * zoom;
        const cssHeight = cssWidth * initial.height / initial.width;
        // Only the current page is rasterized. Bound both area and dimensions,
        // including unusually large plans, on memory-limited mobile WebViews.
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (cssWidth * cssHeight)), 4096 / Math.max(cssWidth, cssHeight));
        const rendered = pdfPage.getViewport({ scale: cssWidth / initial.width * ratio });
        canvas.width = Math.max(1, Math.floor(rendered.width));
        canvas.height = Math.max(1, Math.floor(rendered.height));
        canvas.style.width = `${cssWidth}px`; canvas.style.height = `${cssHeight}px`;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${name} — page ${page} sur ${document.numPages}`);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas unavailable');
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport: rendered });
        await renderTask.promise;
        if (cancelled) return;
        surface.current!.replaceChildren(canvas);
        setLoading(false);
        // Expose the extracted text as an optional reading/copying view, keeping
        // untrusted PDF strings in React text nodes rather than HTML.
        try {
          const content = await pdfPage.getTextContent();
          if (!cancelled) setText(content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join(''));
        } catch { /* A missing text layer does not invalidate a rendered page. */ }
      } finally { pdfPage.cleanup(); }
    })().catch(reason => { if (!cancelled) { setError(previewError(reason)); setLoading(false); } })
      .finally(() => { if (cancelled) { canvas.width = 0; canvas.height = 0; } });
    return () => {
      cancelled = true; renderTask?.cancel(); canvas.remove();
      void (renderTask?.promise ?? Promise.resolve()).catch(() => {}).finally(() => { canvas.width = 0; canvas.height = 0; });
    };
  }, [document, page, width, zoom]);

  function changePage(next: number) {
    setPage(next);
    viewport.current?.scrollTo({ top: 0, left: 0 });
  }
  return <div className="pdf-attachment-preview">
    {document || !error ? <div className="pdf-attachment-preview__toolbar" role="group" aria-label="Lecture du PDF">
      <div className="pdf-attachment-preview__pages">
        <Button size="icon" variant="ghost" aria-label="Page précédente" disabled={!document || page <= 1} onClick={() => changePage(page - 1)}><ChevronLeft size={20} /></Button>
        <span aria-live="polite">{document ? `Page ${page} sur ${document.numPages}` : 'PDF'}</span>
        <Button size="icon" variant="ghost" aria-label="Page suivante" disabled={!document || page >= document.numPages} onClick={() => changePage(page + 1)}><ChevronRight size={20} /></Button>
      </div>
      <div className="pdf-attachment-preview__zoom">
        <Button size="icon" variant="ghost" aria-label="Réduire" disabled={!document || zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - .5))}><ZoomOut size={18} /></Button>
        <Button variant="ghost" aria-label="Ajuster à la largeur" disabled={!document} onClick={() => setZoom(1)}><Scan size={16} /><span>{Math.round(zoom * 100)} %</span></Button>
        <Button size="icon" variant="ghost" aria-label="Agrandir" disabled={!document || zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .5))}><ZoomIn size={18} /></Button>
      </div>
    </div> : null}
    <div ref={viewport} className="pdf-attachment-preview__viewport" tabIndex={0} role="region" aria-label="Page du PDF" aria-busy={loading}>
      {loading ? <p className="attachment-preview__status" role="status">Chargement de la page…</p> : null}
      {error ? <ErrorPanel title="Aperçu indisponible" message={error.message} onRetry={error.retryable ? () => { viewport.current?.focus({ preventScroll: true }); setAttempt(value => value + 1); } : undefined} /> : null}
      <div ref={surface} className="pdf-attachment-preview__page" hidden={!!error} />
      {text.trim() ? <details className="pdf-attachment-preview__text" key={page}><summary>Texte de la page</summary><p>{text}</p></details> : null}
    </div>
  </div>;
}
