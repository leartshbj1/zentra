import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, BookOpen, Check, FileText, List, Maximize, Minus, Plus, X } from 'lucide-react';
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
  const requestedSection = useRef<string | null>(null);
  const [mode, setMode] = useState<'reading' | 'page'>(() => window.matchMedia('(max-width: 860px)').matches ? 'reading' : 'page');
  const [zoom, setZoom] = useState<number | null>(null);
  const [measure, setMeasure] = useState({ width: 794, height: 1123 });
  const [sections, setSections] = useState<{ selector: string; label: string }[]>([]);
  const [activeSection, setActiveSection] = useState('.print-header');
  const [progress, setProgress] = useState(0);
  const [lineCount, setLineCount] = useState(0);
  const scale = zoom ?? Math.min(1, measure.width / 794);

  const goTo = (selector: string) => {
    const area = viewport.current;
    const target = paper.current?.querySelector(selector);
    if (!area || !target) return;
    requestedSection.current = selector;
    setActiveSection(selector);
    // Scroll only the paper viewport: scrollIntoView also moves enclosing toolbars
    // and the background on small WebViews, especially after fitting an A4 page.
    area.scrollTo({ top: area.scrollTop + target.getBoundingClientRect().top - area.getBoundingClientRect().top - 20, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };

  useLayoutEffect(() => {
    const content = paper.current!;
    setLineCount(content.querySelectorAll('.print-table tbody tr').length);
    setSections([
      { selector: '.print-header', label: 'Document' },
      { selector: '.print-table', label: 'Prestations' },
      { selector: '.print-totals', label: 'Totaux' },
      { selector: '.print-footer', label: 'Conditions' },
      { selector: '.swiss-qr-section', label: 'Paiement' },
    ].filter(section => content.querySelector(section.selector)));
  }, [children]);

  useEffect(() => {
    const area = viewport.current!;
    let frame = 0;
    const update = () => {
      const max = area.scrollHeight - area.clientHeight;
      setProgress(max > 1 ? Math.min(100, Math.round(area.scrollTop / max * 100)) : 100);
      // Near the end several short sections can share the same scroll position.
      // Keep the section explicitly chosen until the reader scrolls manually.
      if (requestedSection.current) { setActiveSection(requestedSection.current); return; }
      const top = area.getBoundingClientRect().top;
      let current = sections[0]?.selector || '';
      for (const section of sections) {
        const target = paper.current?.querySelector(section.selector);
        if (target && target.getBoundingClientRect().top <= top + 40) current = section.selector;
      }
      if (max > 1 && area.scrollTop >= max - 2) current = sections.at(-1)?.selector || current;
      setActiveSection(current);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const followScroll = () => { requestedSection.current = null; schedule(); };
    const followKey = (event: KeyboardEvent) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) followScroll(); };
    area.addEventListener('scroll', schedule, { passive: true });
    area.addEventListener('wheel', followScroll, { passive: true });
    area.addEventListener('touchstart', followScroll, { passive: true });
    area.addEventListener('pointerdown', followScroll, { passive: true });
    area.addEventListener('keydown', followKey);
    update();
    return () => {
      area.removeEventListener('scroll', schedule);
      area.removeEventListener('wheel', followScroll);
      area.removeEventListener('touchstart', followScroll);
      area.removeEventListener('pointerdown', followScroll);
      area.removeEventListener('keydown', followKey);
      cancelAnimationFrame(frame);
    };
  }, [sections, mode, scale, measure.height]);

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
    requestedSection.current = null; setActiveSection('.print-header');
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
        <span className={`document-preview__state ${finalDocument ? 'is-final' : ''}`}>{finalDocument ? <Check size={14} aria-hidden="true" /> : <span className="document-preview__draft-dot" aria-hidden="true" />}{finalDocument ? 'Document final' : 'Brouillon'}</span>
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
        <button type="button" className="document-preview__amount" title="Aller au total du document" aria-label={`Aller au total du document : ${total}`} onClick={() => goTo('.print-totals')}><span>Total TTC <span aria-hidden="true">↗</span></span><strong>{total}</strong></button>
      </div>
      <div className="document-preview__body">
        <aside className="document-preview__outline">
          <div className="document-preview__outline-heading"><List size={16} aria-hidden="true" /><strong>Dans ce document</strong></div>
          <nav aria-label="Sections du document">
            {sections.map((section, index) => <button key={section.selector} type="button" aria-current={activeSection === section.selector ? 'location' : undefined} onClick={() => goTo(section.selector)}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{section.label}</button>)}
          </nav>
          <div className="document-preview__document-info"><FileText size={24} aria-hidden="true" /><strong>{lineCount} {lineCount === 1 ? 'prestation' : 'prestations'}</strong><span>{mode === 'reading' ? 'Lecture confortable, adaptée à votre écran.' : 'Format A4. Le PDF final gère les sauts de page.'}</span></div>
          <button type="button" className="document-preview__back-top" onClick={() => goTo('.print-header')}><ArrowUp size={16} /> Revenir au début</button>
        </aside>
        <div className="document-preview__reading-area">
          <div className="document-preview__progress" aria-hidden="true"><span style={{ transform: `scaleX(${progress / 100})` }} /></div>
          <div ref={viewport} className="document-preview__viewport" tabIndex={0} aria-label="Contenu du document">
            <div className="document-preview__canvas" key={mode} style={mode === 'page' ? { width: 794 * scale, height: measure.height * scale } : undefined}>
              <div ref={paper} className="document-preview__paper" style={mode === 'page' ? { width: 794, transform: `scale(${scale})`, transformOrigin: 'top left' } : undefined}>{children}</div>
            </div>
          </div>
        </div>
      </div>
      <footer className="document-preview__export">{actions}</footer>
    </div>, document.body,
  );
}
