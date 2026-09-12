import { PdfExportReceipt } from './PdfExportReceipt';
import type { PdfExportReceipt as Receipt } from './pdfExportDelivery';
import { useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle, RotateCcw, ZoomIn, ZoomOut, Undo2, Redo2, Copy, Bold, Italic } from 'lucide-react';
import { desktopApi } from './bridge';
import { documentAppearance, defaultDocumentStyle, type DocumentDesignKind } from './documentAppearance';
import type { AppSettings } from './types';
import { Button } from './ui';
import './DocumentDesignStudio.css';
import { normalizeComposition, documentFontCss, type DocumentComposition } from './documentComposition';
import { RichTextEditor } from './RichTextEditor';

const labels = { invoices: 'Factures', quotes: 'Devis', accounts: 'Bilan', payslips: 'Fiches de salaire' };
const colors = ['#134d33', '#182b49', '#793c32', '#66523f', '#563d73', '#242424', '#d7b878'];
export function DocumentDesignStudio({ settings, busy, onChange, onSave }: {
  settings: AppSettings; busy: boolean; onChange: (settings: AppSettings) => void; onSave: () => void;
}) {
  const [kind, setKind] = useState<DocumentDesignKind>('invoices');
  const previewElement = useRef<HTMLDivElement>(null);
  const appearance = documentAppearance(settings.documentAppearance);
  const baseStyle = appearance[kind];
  const composition = settings.documentComposition?.[kind];
  const design = normalizeComposition(composition);
  const style = { ...baseStyle, ...(composition ? { composition: design } : {}) };
  const history = useRef<AppSettings[]>([]);
  const future = useRef<AppSettings[]>([]);
  const [panel, setPanel] = useState<'style' | 'layout' | 'text'>('style');
  const [copyTarget, setCopyTarget] = useState<DocumentDesignKind>('quotes');
  const [retry, setRetry] = useState(0);
  const [textZone, setTextZone] = useState<'intro' | 'closing' | 'footerText'>('closing');
  const [preview, setPreview] = useState<{ key: string; pages: string[]; pageCount: number } | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const exportFlight = useRef(false);
  const [exportError, setExportError] = useState('');
  const [exported, setExported] = useState<{ key: string; result: Receipt } | null>(null);
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
        if (!active) return null;
        const { renderPdfPages } = await import('./localPdfPreview');
        return renderPdfPages(new Uint8Array(bytes), 8);
      }).then(result => { if (active && result) setPreview({ key: requestKey, pages: result.pages, pageCount: result.pageCount }); })
        .catch(reason => { if (active) setError(String(reason instanceof Error ? reason.message : reason)); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [requestKey, retry]);
  function change(next: AppSettings) {
    history.current.push(settings); if (history.current.length > 50) history.current.shift(); future.current = [];
    setNotice(''); onChange(next);
  }
  function patch(value: Partial<typeof baseStyle>) { change({ ...settings, documentAppearance: { ...appearance, [kind]: { ...baseStyle, ...value } } }); }
  function compose(value: Partial<DocumentComposition>) { change({ ...settings, documentComposition: { ...settings.documentComposition, [kind]: normalizeComposition({ ...design, ...value }) } }); }
  function undo(redo = false) { const from = redo ? future.current : history.current, to = redo ? history.current : future.current; const next = from.pop(); if (next) { to.push(settings); onChange(next); setNotice(redo ? 'Modification rétablie.' : 'Modification annulée.'); } }
  function preset(value: 'modern' | 'classic' | 'editorial') {
    const selected = value === 'classic' ? { fontFamily: 'times' as const, titleAlign: 'center' as const, logoPosition: 'center' as const, tableStyle: 'lines' as const, marginMm: 20, titleSize: 28 } : value === 'editorial' ? { fontFamily: 'helvetica' as const, titleAlign: 'left' as const, logoPosition: 'right' as const, tableStyle: 'striped' as const, marginMm: 18, titleSize: 30 } : { fontFamily: 'helvetica' as const, titleAlign: 'left' as const, logoPosition: 'left' as const, tableStyle: 'band' as const, marginMm: 15, titleSize: 24 };
    compose(selected);
  }
  function copy() { if (copyTarget === kind) return; change({ ...settings, documentAppearance: { ...appearance, [copyTarget]: { ...baseStyle } }, documentComposition: { ...settings.documentComposition, [copyTarget]: composition ? structuredClone(design) : undefined } }); setNotice(`Présentation copiée vers ${labels[copyTarget].toLowerCase()}. Pensez à enregistrer.`); }

  async function exportExample() {
    if (exportFlight.current || exporting) return;
    exportFlight.current = true; setExporting(true); setNotice(''); setExportError('');
    try {
      const result = await desktopApi.exportDocumentDesignExample({ kind, style, issuer });
      if (result) setExported({ key: requestKey, result });
    } catch (reason) { setExportError(String(reason instanceof Error ? reason.message : reason)); }
    finally { exportFlight.current = false; setExporting(false); }
  }
  return <section className="design-studio settings-card--wide" aria-label="Personnalisation des documents">
    <div className="design-studio__heading"><p className="eyebrow">Votre signature</p><h2>Des documents à votre image</h2><p>Un atelier simple pour composer vos documents. Choisissez un style, ajustez la page, puis écrivez vos textes comme dans un traitement de texte.</p></div>
    <div className="design-studio__tabs" role="group" aria-label="Document à personnaliser">{(Object.keys(labels) as DocumentDesignKind[]).map(value => <button type="button" key={value} disabled={exporting} aria-pressed={kind === value} onClick={() => { setKind(value); setNotice(''); setExportError(''); setExported(null); }}>{labels[value]}</button>)}</div>
    <div className="design-studio__commandbar" role="group" aria-label="Historique de la présentation">
      <button type="button" disabled={busy || !history.current.length} onClick={() => undo()}><Undo2 size={17} /> Annuler</button>
      <button type="button" disabled={busy || !future.current.length} onClick={() => undo(true)}><Redo2 size={17} /> Rétablir</button>
      <span>Les montants se calculent automatiquement.</span>
    </div>
    <div className="design-studio__body">
      <div className="design-studio__tools">
        <div className="design-studio__panels" role="group" aria-label="Outils de personnalisation">{([['style','Style'],['layout','Mise en page'],['text','Textes']] as const).map(([key,label]) => <button type="button" key={key} aria-pressed={panel === key} onClick={() => setPanel(key)}>{label}</button>)}</div>
        <div hidden={panel !== 'style'} className="design-studio__panel">
        {!composition && <p className="design-studio__hint">Votre modèle actuel est conservé. Choisissez un point de départ ou ajustez la police pour activer la mise en page flexible.</p>}
        <fieldset disabled={busy}><legend>Un point de départ</legend><div className="design-studio__presets">{([['modern','Moderne'],['classic','Classique'],['editorial','Éditorial']] as const).map(([key,label]) => <button type="button" key={key} onClick={() => preset(key)}>{label}</button>)}</div><small>Vous gardez vos textes et votre couleur.</small></fieldset>
        <label>Police du document<select aria-label="Police du document" value={design.fontFamily} disabled={busy} onChange={e => compose({ fontFamily: e.target.value as DocumentComposition['fontFamily'] })}><option value="helvetica">Helvetica · sobre et moderne</option><option value="times">Times · élégante et classique</option><option value="courier">Courier · style dactylographié</option></select></label>
        <div className="design-studio__pair"><label>Taille du texte<select aria-label="Taille du texte" value={design.bodySize} disabled={busy} onChange={e => compose({ bodySize: Number(e.target.value) })}>{[8,9,10,11,12].map(n => <option key={n} value={n}>{n} pt</option>)}</select></label><label>Taille du titre<select aria-label="Taille du titre" value={design.titleSize} disabled={busy} onChange={e => compose({ titleSize: Number(e.target.value) })}>{[18,20,24,28,30,34].map(n => <option key={n} value={n}>{n} pt</option>)}</select></label></div>
        <fieldset disabled={busy}><legend>Style du titre</legend><div className="design-studio__presets"><button type="button" aria-pressed={design.titleBold} onClick={() => compose({ titleBold: !design.titleBold })}><Bold size={16} /> Gras</button><button type="button" aria-pressed={design.titleItalic} onClick={() => compose({ titleItalic: !design.titleItalic })}><Italic size={16} /> Italique</button></div></fieldset>
        <fieldset disabled={busy}><legend>Présentation</legend><div className="design-studio__layouts">{(['signature', 'minimal'] as const).map(value => <button type="button" key={value} aria-pressed={style.layout === value} onClick={() => patch({ layout: value })}><span className={`design-studio__layout-sample design-studio__layout-sample--${value}`} aria-hidden="true" /><strong>{value === 'signature' ? 'Signature' : 'Épurée'}</strong><small>{value === 'signature' ? 'Une touche de couleur affirmée' : 'Des lignes simples et légères'}</small>{style.layout === value && <Check size={15} />}</button>)}</div></fieldset>
        <fieldset disabled={busy}><legend>Couleur</legend><div className="design-studio__swatches">{colors.map(color => <button type="button" key={color} style={{ backgroundColor: color }} aria-label={`Couleur ${color}`} aria-pressed={style.accentColor === color} onClick={() => patch({ accentColor: color })} />)}</div><label className="design-studio__color">Couleur personnalisée<input type="color" aria-label="Couleur personnalisée" value={style.accentColor} onChange={event => patch({ accentColor: event.target.value })} /></label></fieldset>
        </div>
        <div hidden={panel !== 'layout'} className="design-studio__panel">
        <label>Position du logo<select aria-label="Position du logo" disabled={busy} value={design.logoPosition} onChange={e => compose({ logoPosition: e.target.value as DocumentComposition['logoPosition'] })}><option value="left">À gauche</option><option value="center">Au centre</option><option value="right">À droite</option><option value="hidden">Masquer le logo</option></select></label>
        <label>Taille du logo<select aria-label="Taille du logo" value={style.logoWidth} disabled={busy} onChange={event => patch({ logoWidth: Number(event.target.value) })}><option value="88">Discrète</option><option value="120">Équilibrée</option><option value="150">Affirmée</option></select><small>Le logo conserve ses proportions.</small></label>
        <label>Hauteur maximale du logo<select aria-label="Hauteur maximale du logo" value={design.logoHeight} disabled={busy} onChange={e => compose({ logoHeight: Number(e.target.value) })}>{[24,36,48,60,72].map(n => <option key={n} value={n}>{n} pt</option>)}</select></label>
        <label>Alignement du titre<select aria-label="Alignement du titre" value={design.titleAlign} disabled={busy} onChange={e => compose({ titleAlign: e.target.value as DocumentComposition['titleAlign'] })}><option value="left">À gauche</option><option value="center">Centré</option><option value="right">À droite</option></select></label>
        <div className="design-studio__pair"><label>Marges<select aria-label="Marges" value={design.marginMm} disabled={busy} onChange={e => compose({ marginMm: Number(e.target.value) })}>{[12,15,18,20,25].map(n => <option key={n} value={n}>{n} mm</option>)}</select></label><label>Interligne<select aria-label="Interligne" value={design.lineSpacing} disabled={busy} onChange={e => compose({ lineSpacing: Number(e.target.value) })}><option value="1.15">Serré · 1,15</option><option value="1.35">Équilibré · 1,35</option><option value="1.5">Aéré · 1,5</option><option value="1.8">Très aéré · 1,8</option></select></label></div>
        <label>Présentation du tableau<select aria-label="Présentation du tableau" value={design.tableStyle} disabled={busy} onChange={e => compose({ tableStyle: e.target.value as DocumentComposition['tableStyle'] })}><option value="band">En-tête coloré</option><option value="striped">Lignes alternées</option><option value="lines">Lignes discrètes</option></select></label>
        <label>Espace dans les lignes<select aria-label="Espace dans les lignes" value={design.tablePadding} disabled={busy} onChange={e => compose({ tablePadding: Number(e.target.value) })}><option value="4">Compact</option><option value="6">Équilibré</option><option value="8">Confortable</option><option value="10">Très aéré</option></select></label>
        {kind !== 'accounts' && <label>Position des totaux<select aria-label="Position des totaux" value={design.totalsPosition} disabled={busy} onChange={e => compose({ totalsPosition: e.target.value as DocumentComposition['totalsPosition'] })}><option value="beforeNotes">Juste après le tableau</option><option value="afterNotes">Après les remarques et conditions</option></select></label>}
        </div>
        <div hidden={panel !== 'text'} className="design-studio__panel">
        <p className="design-studio__hint">Ces textes seront ajoutés aux prochains documents de cette catégorie. Les remarques propres à chaque document restent présentes.</p>
        <label>Zone de texte<select aria-label="Zone de texte" value={textZone} onChange={e => setTextZone(e.target.value as typeof textZone)}><option value="intro">Introduction · avant le tableau</option><option value="closing">{kind === 'accounts' ? 'Commentaire après les comptes' : 'Conditions et message de fin'}</option><option value="footerText">Pied de page · sur chaque page</option></select></label>
        <RichTextEditor key={`${kind}-${textZone}`} label={textZone === 'intro' ? 'Texte d’introduction' : textZone === 'footerText' ? 'Pied de page mis en forme' : kind === 'accounts' ? 'Commentaire après les comptes' : 'Conditions et message de fin'} maxLength={textZone === 'footerText' ? 180 : 5000} value={design[textZone]} fontFamily={documentFontCss[design.fontFamily]} baseFontSize={textZone === 'footerText' ? 8 : design.bodySize} disabled={busy} onChange={value => compose({ [textZone]: value })} />
        <details><summary>Pied de page simple</summary><p className="design-studio__hint">Utilisé lorsque le pied de page mis en forme est vide.</p>
        <label>Une phrase en pied de page<input aria-label="Une phrase en pied de page" value={style.footer} maxLength={100} disabled={busy} placeholder="Merci pour votre confiance." onChange={event => patch({ footer: event.target.value })} /><small>{style.footer.length}/100 caractères · les mentions obligatoires restent présentes.</small></label>
        </details>
        </div>
        <details className="design-studio__copy"><summary>Réutiliser cette présentation</summary><label>Copier vers<select aria-label="Copier vers" value={copyTarget} onChange={e => setCopyTarget(e.target.value as DocumentDesignKind)}>{(Object.keys(labels) as DocumentDesignKind[]).map(k => <option key={k} value={k}>{labels[k]}</option>)}</select></label><Button variant="secondary" disabled={busy || copyTarget === kind} onClick={copy}><Copy size={16} /> Copier la présentation</Button><small>Remplace le style et les textes de la catégorie choisie. Annuler permet de revenir en arrière.</small></details>
        <Button className="design-studio__jump" variant="secondary" onClick={() => previewElement.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })}>Voir le résultat</Button>
        <div className="design-studio__actions"><Button disabled={busy || loading || !!error} onClick={onSave}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Enregistrer les présentations</Button><Button variant="secondary" disabled={exporting || loading || !!error} onClick={() => void exportExample()}><Download size={16} /> Exporter cet exemple</Button><Button variant="ghost" disabled={busy} onClick={() => { const next = { ...settings.documentComposition }; delete next[kind]; change({ ...settings, documentAppearance: { ...appearance, [kind]: { ...defaultDocumentStyle } }, documentComposition: next }); }}><RotateCcw size={15} /> Réinitialiser {labels[kind].toLowerCase()}</Button></div>
        <p className="design-studio__hint">Les réglages s’appliquent aux brouillons et aux prochains documents. Les documents émis et les fiches comptabilisées conservent leur présentation.</p>
        {notice && <p role="status">{notice}</p>}
        {exportError && <p role="alert">L’export n’a pas abouti. Vos réglages sont conservés. {exportError} Réessayez avec « Exporter cet exemple ».</p>}
        {exported?.key === requestKey && <PdfExportReceipt result={exported.result} disabled={exporting} onBusyChange={setExporting} />}
      </div>
      <div ref={previewElement} className="design-studio__preview" aria-label={`Exemple ${labels[kind]}`} aria-busy={loading && !error}>
        <div className="design-studio__preview-label"><span>Exemple fictif · A4</span>{loading && !error ? <span role="status"><LoaderCircle size={14} className="spin" /> Mise à jour…</span> : <span>Rendu PDF{preview ? ` · ${preview.pageCount} page${preview.pageCount > 1 ? 's' : ''}` : ''}</span>}<button type="button" aria-label={zoomed ? 'Ajuster l’aperçu' : 'Agrandir l’aperçu'} aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>{zoomed ? <ZoomOut size={18} /> : <ZoomIn size={18} />}</button></div>
        {error ? <div className="design-studio__error" role="alert"><strong>L’aperçu demande une correction</strong><p>{error}</p><Button variant="secondary" onClick={() => setRetry(r => r + 1)}>Réessayer l’aperçu</Button></div> : preview ? <div className={`design-studio__pages${loading ? ' design-studio__pages--loading' : ''}${zoomed ? ' design-studio__pages--zoomed' : ''}`} tabIndex={zoomed ? 0 : undefined} aria-label="Pages de l’exemple">{preview.pages.map((src, index) => <img key={index} src={src} alt={`Exemple ${labels[kind]} · page ${index + 1}`} />)}{preview.pageCount > preview.pages.length && <p>Aperçu des {preview.pages.length} premières pages. Le PDF exporté contient les {preview.pageCount} pages.</p>}</div> : <div className="design-studio__placeholder">Préparation de votre exemple…</div>}
      </div>
    </div>
  </section>;
}
