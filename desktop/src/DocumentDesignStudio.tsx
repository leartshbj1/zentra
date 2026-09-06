import { useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { desktopApi } from './bridge';
import { documentAppearance, defaultDocumentStyle, type DocumentDesignKind } from './documentAppearance';
import type { AppSettings } from './types';
import { Button } from './ui';
import './DocumentDesignStudio.css';

const labels = { invoices: 'Factures', quotes: 'Devis', accounts: 'Bilan', payslips: 'Fiches de salaire' };
const colors = ['#134d33', '#182b49', '#793c32', '#66523f', '#563d73', '#242424', '#d7b878'];
export function DocumentDesignStudio({ settings, busy, onChange, onSave }: {
  settings: AppSettings; busy: boolean; onChange: (settings: AppSettings) => void; onSave: () => void;
}) {
  const [kind, setKind] = useState<DocumentDesignKind>('invoices');
  const previewElement = useRef<HTMLDivElement>(null);
  const appearance = documentAppearance(settings.documentAppearance);
  const style = appearance[kind];
  const [preview, setPreview] = useState<{ key: string; pages: string[] } | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [notice, setNotice] = useState('');
  const issuer = desktopApi.designExampleIssuer(settings);
  const requestKey = JSON.stringify({ kind, style, issuer });
  const loading = preview?.key !== requestKey;
  useEffect(() => {
    let active = true;
    setError('');
    const timer = window.setTimeout(() => {
      const input = JSON.parse(requestKey);
      void desktopApi.documentDesignExample(input).then(async bytes => {
        const { renderPdfPages } = await import('./localPdfPreview');
        return renderPdfPages(new Uint8Array(bytes), 4);
      }).then(result => { if (active) setPreview({ key: requestKey, pages: result.pages }); })
        .catch(reason => { if (active) setError(String(reason instanceof Error ? reason.message : reason)); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [requestKey]);
  function patch(value: Partial<typeof style>) {
    setNotice('');
    onChange({ ...settings, documentAppearance: { ...appearance, [kind]: { ...style, ...value } } });
  }
  async function exportExample() {
    setExporting(true); setNotice('');
    try {
      const path = await desktopApi.exportDocumentDesignExample({ kind, style, issuer });
      if (path) setNotice('Exemple PDF exporté.');
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setExporting(false); }
  }
  return <section className="design-studio settings-card--wide" aria-label="Personnalisation des documents">
    <div className="design-studio__heading"><p className="eyebrow">Votre signature</p><h2>Des documents à votre image</h2><p>Choisissez une présentation pour chaque document. L’exemple est un vrai PDF, mis à jour au fil de vos réglages.</p></div>
    <div className="design-studio__tabs" role="group" aria-label="Document à personnaliser">{(Object.keys(labels) as DocumentDesignKind[]).map(value => <button type="button" key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setNotice(''); }}>{labels[value]}</button>)}</div>
    <div className="design-studio__body">
      <div className="design-studio__tools">
        <fieldset disabled={busy}><legend>Présentation</legend><div className="design-studio__layouts">{(['signature', 'minimal'] as const).map(value => <button type="button" key={value} aria-pressed={style.layout === value} onClick={() => patch({ layout: value })}><span className={`design-studio__layout-sample design-studio__layout-sample--${value}`} aria-hidden="true" /><strong>{value === 'signature' ? 'Signature' : 'Épurée'}</strong><small>{value === 'signature' ? 'Une touche de couleur affirmée' : 'Des lignes simples et légères'}</small>{style.layout === value && <Check size={15} />}</button>)}</div></fieldset>
        <fieldset disabled={busy}><legend>Couleur</legend><div className="design-studio__swatches">{colors.map(color => <button type="button" key={color} style={{ backgroundColor: color }} aria-label={`Couleur ${color}`} aria-pressed={style.accentColor === color} onClick={() => patch({ accentColor: color })} />)}</div><label className="design-studio__color">Couleur personnalisée<input type="color" aria-label="Couleur personnalisée" value={style.accentColor} onChange={event => patch({ accentColor: event.target.value })} /></label></fieldset>
        <label>Taille du logo<select value={style.logoWidth} disabled={busy} onChange={event => patch({ logoWidth: Number(event.target.value) })}><option value="88">Discrète</option><option value="120">Équilibrée</option><option value="150">Affirmée</option></select><small>Le logo conserve ses proportions.</small></label>
        <label>Une phrase en pied de page<input value={style.footer} maxLength={100} disabled={busy} placeholder="Merci pour votre confiance." onChange={event => patch({ footer: event.target.value })} /><small>{style.footer.length}/100 caractères · les mentions obligatoires restent présentes.</small></label>
        <Button className="design-studio__jump" variant="secondary" onClick={() => previewElement.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })}>Voir le résultat</Button>
        <div className="design-studio__actions"><Button disabled={busy || !!error} onClick={onSave}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Enregistrer les présentations</Button><Button variant="secondary" disabled={exporting || loading || !!error} onClick={() => void exportExample()}><Download size={16} /> Exporter cet exemple</Button><Button variant="ghost" disabled={busy} onClick={() => patch({ ...defaultDocumentStyle })}><RotateCcw size={15} /> Réinitialiser {labels[kind].toLowerCase()}</Button></div>
        <p className="design-studio__hint">Les réglages s’appliquent aux brouillons et aux prochains documents. Les documents émis et les fiches comptabilisées conservent leur présentation.</p>
        {notice && <p role="status">{notice}</p>}
      </div>
      <div ref={previewElement} className="design-studio__preview" aria-label={`Exemple ${labels[kind]}`} aria-busy={loading && !error}>
        <div className="design-studio__preview-label"><span>Exemple fictif · A4</span>{loading && !error ? <span role="status"><LoaderCircle size={14} className="spin" /> Mise à jour…</span> : <span>Rendu PDF</span>}<button type="button" aria-label={zoomed ? 'Ajuster l’aperçu' : 'Agrandir l’aperçu'} aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>{zoomed ? <ZoomOut size={18} /> : <ZoomIn size={18} />}</button></div>
        {error ? <div className="design-studio__error" role="alert">L’aperçu n’a pas pu être généré : {error}</div> : preview ? <div className={`design-studio__pages${loading ? ' design-studio__pages--loading' : ''}${zoomed ? ' design-studio__pages--zoomed' : ''}`} tabIndex={zoomed ? 0 : undefined} aria-label="Pages de l’exemple">{preview.pages.map((src, index) => <img key={index} src={src} alt={`Exemple ${labels[kind]} · page ${index + 1}`} />)}</div> : <div className="design-studio__placeholder">Préparation de votre exemple…</div>}
      </div>
    </div>
  </section>;
}
