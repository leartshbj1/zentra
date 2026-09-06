import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, FileText, Maximize, Minus, Plus, X } from 'lucide-react';
import { Button } from './ui';
import './DocumentPreviewFrame.css';

/** A reading surface around the existing document; never changes its financial content. */
export function DocumentPreviewFrame({ title, number, customer, total, finalDocument, actions, children, onClose }: {
  title: string; number: string; customer: string; total: string; finalDocument: boolean;
  actions: ReactNode; children: ReactNode; onClose: () => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'reading' | 'page'>(() => window.matchMedia('(max-width: 860px)').matches ? 'reading' : 'page');
  const [zoom, setZoom] = useState<number | null>(null);
  const [measure, setMeasure] = useState({ width: 794, height: 1123 });
  const scale = zoom ?? Math.min(1, measure.width / 794);

  useEffect(() => {
    const element = root.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = Array.from(document.body.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== element);
    const saved = background.map(child => ({ child, inert: child.inert }));
    saved.forEach(({ child }) => { child.inert = true; });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.focus({ preventScroll: true });
    return () => {
      saved.forEach(({ child, inert }) => { child.inert = inert; });
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const area = viewport.current!;
    const content = paper.current!;
    const update = () => {
      const padding = parseFloat(getComputedStyle(area).paddingLeft) + parseFloat(getComputedStyle(area).paddingRight);
      const next = { width: Math.max(1, area.clientWidth - padding), height: content.offsetHeight };
      setMeasure(current => current.width === next.width && current.height === next.height ? current : next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(area); observer.observe(content); update();
    return () => observer.disconnect();
  }, [mode]);

  const changeMode = (next: 'reading' | 'page') => {
    setMode(next); setZoom(null);
    viewport.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  };

  return createPortal(
    <div ref={root} className={`print-preview document-preview document-preview--${mode}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]')).filter(el => el.getClientRects().length > 0 && !el.closest('[inert], [hidden]'));
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus(); }
      }}>
      <header className="document-preview__header">
        <span className="document-preview__icon" aria-hidden="true"><FileText size={23} /></span>
        <div className="document-preview__identity"><h2 id={id}>{title} <span>{number || 'Sans numéro'}</span></h2><p>{customer || 'Destinataire à compléter'}</p></div>
        <span className={`document-preview__state ${finalDocument ? 'is-final' : ''}`}>{finalDocument ? 'Document final' : 'Brouillon'}</span>
        <Button variant="ghost" size="icon" aria-label="Fermer l’aperçu" title="Fermer l’aperçu (Échap)" onClick={onClose}><X size={21} /></Button>
      </header>
      <div className="document-preview__controls">
        <div className="document-preview__modes" role="group" aria-label="Mode d’aperçu">
          <button type="button" aria-pressed={mode === 'reading'} onClick={() => changeMode('reading')}><BookOpen size={17} /> Lecture</button>
          <button type="button" aria-pressed={mode === 'page'} onClick={() => changeMode('page')}><FileText size={17} /> Mise en page</button>
        </div>
        {mode === 'page' ? <div className="document-preview__zoom" role="group" aria-label="Zoom du document">
          <Button variant="ghost" size="icon" aria-label="Réduire le zoom" disabled={scale <= .25} onClick={() => setZoom(Math.max(.25, Math.round((scale - .15) * 100) / 100))}><Minus size={17} /></Button>
          <output aria-live="polite">{Math.round(scale * 100)} %</output>
          <Button variant="ghost" size="icon" aria-label="Agrandir le document" disabled={scale >= 1.5} onClick={() => setZoom(Math.min(1.5, Math.round((scale + .15) * 100) / 100))}><Plus size={17} /></Button>
          <Button variant="ghost" size="icon" aria-label="Ajuster à la largeur" title="Ajuster à la largeur" onClick={() => setZoom(null)}><Maximize size={17} /></Button>
        </div> : <p className="document-preview__reading-hint">Lecture adaptée à votre écran</p>}
        <button type="button" className="document-preview__amount" title="Aller au total du document" aria-label={`Aller au total du document : ${total}`} onClick={() => paper.current?.querySelector('.print-totals')?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })}><span>Total TTC <span aria-hidden="true">↗</span></span><strong>{total}</strong></button>
      </div>
      <div ref={viewport} className="document-preview__viewport" tabIndex={0} aria-label="Contenu du document">
        <div className="document-preview__canvas" style={mode === 'page' ? { width: 794 * scale, height: measure.height * scale } : undefined}>
          <div ref={paper} className="document-preview__paper" style={mode === 'page' ? { width: 794, transform: `scale(${scale})`, transformOrigin: 'top left' } : undefined}>{children}</div>
        </div>
      </div>
      <footer className="document-preview__export">{actions}</footer>
    </div>, document.body,
  );
}
