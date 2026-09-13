import { useRef, useState } from 'react';
import { BookmarkPlus, Check, Pencil, Trash2 } from 'lucide-react';
import type { AppSettings } from './types';
import type { DocumentDesignKind } from './documentAppearance';
import { documentFontCss, normalizeComposition } from './documentComposition';
import { applyDocumentTemplate, captureDocumentTemplate, documentKindLabels, documentKindTargets, maxDocumentTemplates, templateNameError } from './documentTemplates';
import './DocumentTemplateLibrary.css';

export function DocumentTemplateLibrary({ settings, kind, disabled, onChange, onNotice }: {
  settings: AppSettings; kind: DocumentDesignKind; disabled: boolean;
  onChange: (settings: AppSettings) => void; onNotice: (message: string) => void;
}) {
  const templates = settings.documentDesignTemplates ?? [];
  const [name, setName] = useState(''), [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [includeText, setIncludeText] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null), [rename, setRename] = useState('');
  const nameInput = useRef<HTMLInputElement>(null), renameInput = useRef<HTMLInputElement>(null);
  const selected = templates.find(item => item.id === selectedId) ?? templates[0];
  const design = normalizeComposition(selected?.style.composition);
  function fail(message: string, isRename = false) {
    setError(message);
    requestAnimationFrame(() => { const input = isRename ? renameInput.current : nameInput.current; input?.focus(); input?.scrollIntoView({ block: 'center' }); });
  }
  function create() {
    if (disabled) return;
    try {
      const template = captureDocumentTemplate(settings, kind, name, crypto.randomUUID());
      onChange({ ...settings, documentDesignTemplates: [...templates, template] });
      setSelectedId(template.id); setName(''); setError(''); setRenaming(null); setIncludeText(false);
      onNotice(`« ${template.name} » est ajouté à vos modèles. Choisissez Enregistrer pour le conserver après fermeture.`);
    } catch (reason) { fail(reason instanceof Error ? reason.message : 'Le modèle n’a pas pu être créé.'); }
  }
  function apply() {
    if (disabled || !selected) return;
    onChange(applyDocumentTemplate(settings, kind, selected, includeText)); setError('');
    onNotice(`« ${selected.name} » est appliqué ${documentKindTargets[kind]}. ${includeText ? 'Ses textes modèles sont repris.' : 'Vos textes sont conservés.'} Vérifiez l’aperçu puis enregistrez.`);
  }
  function renameSelected() {
    if (disabled || !selected || renaming !== selected.id) return;
    const problem = templateNameError(rename, templates, selected.id);
    if (problem) { fail(problem, true); return; }
    onChange({ ...settings, documentDesignTemplates: templates.map(item => item.id === selected.id ? { ...item, name: rename.trim() } : item) });
    setError(''); setRenaming(null); onNotice('Le modèle est renommé. Pensez à enregistrer.');
  }
  function remove() {
    if (disabled || !selected) return;
    onChange({ ...settings, documentDesignTemplates: templates.filter(item => item.id !== selected.id) });
    setSelectedId(''); setRenaming(null); setError(''); setIncludeText(false);
    onNotice(`« ${selected.name} » est retiré de vos modèles. Vos documents gardent leur présentation. Annuler permet de retrouver ce modèle.`);
  }
  return <details className="design-studio__advanced document-template-library">
    <summary>Mes modèles{templates.length ? ` · ${templates.length}` : ''}</summary>
    <p className="design-studio__hint">Gardez vos présentations préférées et réutilisez-les pour vos devis, factures, bilans et fiches de salaire.</p>
    <fieldset disabled={disabled}>
      <legend>Garder la présentation actuelle</legend>
      <label>Nom du modèle<input ref={nameInput} aria-label="Nom du modèle" value={name} placeholder="Ex. Devis classique" aria-invalid={!!error && !renaming} aria-describedby={error ? 'document-template-error' : undefined} onChange={e => { setName(e.target.value); setError(''); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); create(); } }} /></label>
      <button type="button" onClick={create}><BookmarkPlus size={17} /> Créer ce modèle</button>
      <small>La mise en page, les couleurs et les textes modèles sont conservés. Le logo reste celui de votre entreprise. {templates.length}/{maxDocumentTemplates} modèles.</small>
    </fieldset>
    {error && <p id="document-template-error" role="alert" className="document-template-library__error">{error}</p>}
    {selected && <fieldset disabled={disabled}>
      <legend>Réutiliser un modèle</legend>
      <label>Choisir un modèle<select aria-label="Choisir un modèle" value={selected.id} onChange={e => { setSelectedId(e.target.value); setRenaming(null); setIncludeText(false); setError(''); }}>{templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="document-template-library__card">
        <div className="document-template-library__paper" aria-hidden="true" data-orientation={design.pageOrientation ?? 'portrait'} style={{ color: selected.style.accentColor, fontFamily: documentFontCss[design.fontFamily] }}><span>Aa</span><i /><i /><i /></div>
        <div><strong>{selected.name}</strong><small>Créé depuis : {documentKindLabels[selected.sourceKind]}</small><small>{design.fontFamily === 'times' ? 'Times' : design.fontFamily === 'courier' ? 'Courier' : 'Helvetica'} · {design.pageOrientation === 'landscape' ? 'Paysage' : 'Portrait'}</small></div>
      </div>
      <label className="design-studio__choice"><input type="checkbox" checked={includeText} onChange={e => setIncludeText(e.target.checked)} />Reprendre aussi les textes du modèle</label>
      <small>{includeText ? 'L’introduction, les conditions ou commentaires et le pied de page de cette catégorie seront remplacés.' : 'Vos textes actuels restent en place. Seule leur présentation change.'}</small>
      <button type="button" onClick={apply}><Check size={17} /> Appliquer {documentKindTargets[kind]}</button>
      <div className="document-template-library__actions">
        <button type="button" onClick={() => { setRename(selected.name); setRenaming(selected.id); setError(''); requestAnimationFrame(() => { renameInput.current?.focus(); renameInput.current?.select(); }); }}><Pencil size={15} /> Renommer</button>
        <button type="button" onClick={remove}><Trash2 size={15} /> Retirer ce modèle</button>
      </div>
      {renaming === selected.id && <div className="document-template-library__rename">
        <label>Nouveau nom du modèle<input ref={renameInput} aria-label="Nouveau nom du modèle" value={rename} aria-invalid={!!error} aria-describedby={error ? 'document-template-error' : undefined} onChange={e => { setRename(e.target.value); setError(''); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); renameSelected(); } }} /></label>
        <div className="document-template-library__actions"><button type="button" onClick={renameSelected}>Valider le nom</button><button type="button" onClick={() => { setRenaming(null); setError(''); }}>Garder le nom actuel</button></div>
      </div>}
    </fieldset>}
    <p className="design-studio__hint">Ces choix restent annulables. Enregistrer conserve vos modèles avec les paramètres de l’entreprise.</p>
  </details>;
}
