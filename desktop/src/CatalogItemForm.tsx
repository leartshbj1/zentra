import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Box, Wrench } from 'lucide-react';
import { desktopApi } from './bridge';
import type { CatalogItem, Workspace } from './types';
import { catalogDraft, catalogFormData, catalogFormIssue, catalogNativeIssue, catalogPricePreview, catalogVatRates, formatCatalogMoney, mergeCatalogDraft, requireCatalogWorkspace, type CatalogDraft, type CatalogIssue } from './catalogForm';
import { formatCatalogQuantity } from './catalog';
import { createId, errorMessage } from './utils';
import { Button, Field, FormActions, Modal } from './ui';
import './catalog-form.css';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void, validateRead?: (workspace: Workspace) => void) => Promise<boolean>;
const labels: Record<keyof CatalogDraft, string> = { kind: 'Type', name: 'Nom', sku: 'Référence', description: 'Description', unit: 'Unité', salesPrice: 'Prix de vente', purchaseCost: 'Coût d’achat', vatBp: 'TVA', trackStock: 'Suivi du stock', reorderLevel: 'Seuil d’alerte' };
const display = (field: keyof CatalogDraft, value: string | boolean) => field === 'kind' ? value === 'product' ? 'Produit' : 'Service' : typeof value === 'boolean' ? value ? 'Activé' : 'Désactivé' : field === 'vatBp' ? `${Number(value) / 100} %` : value || 'Non renseigné';

export function CatalogItemForm({ item, workspace, busy, readOnly, close, act, onReadWorkspace }: {
  item?: CatalogItem; workspace: Workspace; busy: boolean; readOnly: boolean; close: () => void; act: ActionRunner; onReadWorkspace: () => Promise<Workspace>;
}) {
  const settings = workspace.settings!;
  const [id] = useState(() => item?.id ?? createId());
  const current = item ? workspace.catalogItems.find(row => row.id === id) : undefined;
  const [baseline, setBaseline] = useState(item);
  const [draft, setDraft] = useState(() => catalogDraft(item, settings));
  const [issue, setIssue] = useState<CatalogIssue | null>(null), [failure, setFailure] = useState('');
  const [saving, setSaving] = useState(false), [reading, setReading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null), alertRef = useRef<HTMLDivElement>(null), inFlight = useRef(false);
  const locked = busy || saving || reading;
  const changed = !!item && !!current && current.updatedAt !== baseline?.updatedAt;
  const missing = !!item && !current;
  const history = workspace.stockMovements.some(row => row.catalogItemId === id);
  const rates = catalogVatRates(settings, baseline);
  const allowedRates = settings.organization.vatRegistered ? rates : [0];
  const preview = catalogPricePreview(draft.salesPrice, draft.vatBp);
  const beforeDraft = catalogDraft(baseline, settings), currentDraft = catalogDraft(current, settings);
  const differences = changed ? (Object.keys(draft) as (keyof CatalogDraft)[]).filter(field => beforeDraft[field] !== currentDraft[field]) : [];

  useEffect(() => {
    if (locked) return;
    const element = issue && issue.field !== 'record' ? formRef.current?.elements.namedItem(issue.field) as HTMLElement | null : failure || changed || missing ? alertRef.current : null;
    if (!element || !(element instanceof HTMLElement)) return;
    const details = element.closest('details'); if (details) details.open = true;
    const field = element.closest<HTMLElement>('.field') || element;
    field.style.scrollMarginBlockEnd = `${(formRef.current?.querySelector('.form-actions')?.getBoundingClientRect().height || 0) + 20}px`;
    element.focus({ preventScroll: true }); field.scrollIntoView({ block: element === alertRef.current ? 'start' : 'center' });
  }, [locked, issue, failure, changed, missing]);

  function change<K extends keyof CatalogDraft>(field: K, value: CatalogDraft[K]) {
    if (locked || readOnly || changed || missing) return;
    setDraft(previous => ({ ...previous, [field]: value })); setIssue(null); setFailure('');
  }
  function chooseKind(kind: CatalogItem['kind']) {
    if (locked || readOnly || changed || missing || history) return;
    setDraft(previous => ({ ...previous, kind, unit: !item && ['heure', 'pièce'].includes(previous.unit) ? kind === 'product' ? 'pièce' : 'heure' : previous.unit })); setIssue(null); setFailure('');
  }
  const fieldError = (field: keyof CatalogDraft) => issue?.field === field ? issue.message : undefined;
  const input = (field: Exclude<keyof CatalogDraft, 'kind' | 'trackStock'>) => ({ name: field, value: draft[field], onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => change(field, event.target.value), 'aria-invalid': !!fieldError(field) });
  const refused = (reason: unknown) => { setIssue(catalogNativeIssue(reason)); setFailure(errorMessage(reason, 'La fiche n’a pas pu être enregistrée. Votre saisie est conservée.')); };
  async function refresh() {
    if (locked || inFlight.current) return;
    setReading(true); setFailure('');
    try { await onReadWorkspace(); } catch (reason) { refused(reason); } finally { setReading(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked || readOnly || inFlight.current || changed || missing) return;
    const invalid = catalogFormIssue(draft, allowedRates, current, history);
    if (invalid) { setIssue(invalid); return; }
    setIssue(null); setFailure(''); inFlight.current = true; setSaving(true);
    try {
      await act(() => desktopApi.saveCatalogItem(id, catalogFormData(draft, !!item), item ? baseline?.updatedAt ?? '' : undefined), item ? 'La référence a été enregistrée. Les documents existants et le stock sont conservés.' : draft.kind === 'product' && draft.trackStock ? 'Le produit a été ajouté. Utilisez Entrée sur sa fiche pour renseigner le stock de départ.' : 'La référence a été ajoutée au catalogue.', true, refused, requireCatalogWorkspace);
    } catch (reason) { refused(reason); } finally { inFlight.current = false; setSaving(false); }
  }
  return <Modal title={item ? 'Modifier la référence' : 'Ajouter un produit ou un service'} description="Donnez un nom et un prix pour réutiliser cette référence dans vos prochains devis et factures." onClose={close} dismissible={!locked} wide className="catalog-form-modal">
    <form ref={formRef} className="catalog-form" onSubmit={submit} noValidate>
      {item && <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => void refresh()}>Actualiser la fiche</Button>}
      {(changed || missing || failure) && <div ref={alertRef} tabIndex={-1} className="catalog-form-alert" role="alert">
        <strong>{missing ? 'Cette référence n’est plus accessible' : changed ? 'La fiche a changé entre-temps' : 'Vérifions ce point'}</strong>
        <p>{missing ? 'Votre saisie reste affichée. Actualisez ou revenez au catalogue pour vérifier la référence.' : changed ? 'Votre saisie est conservée. Comparez les informations avant de reprendre ; aucun choix ci-dessous n’enregistre la fiche.' : issue?.message || 'Votre saisie est conservée. Vous pouvez corriger la fiche ou réessayer.'}</p>
        {changed && <>{differences.length ? <div className="catalog-form-comparison">{differences.map(field => <section key={field}><h4>{labels[field]}</h4><div><span>Votre saisie</span><p>{display(field, draft[field])}</p></div><div><span>Version actuelle</span><p>{display(field, currentDraft[field])}</p></div></section>)}</div> : <p>Les informations à remplir sont identiques ; le stock ou l’état de la fiche a été actualisé.</p>}
          <p>Conserver ma saisie garde les champs que vous avez modifiés et reprend les autres informations actuelles.</p><div className="catalog-form-choices"><Button type="button" disabled={locked || readOnly} onClick={() => { setDraft(mergeCatalogDraft(beforeDraft, draft, currentDraft)); setBaseline(current); setIssue(null); setFailure(''); }}>Conserver ma saisie</Button><Button type="button" variant="secondary" disabled={locked || readOnly} onClick={() => { setBaseline(current); setDraft(currentDraft); setIssue(null); setFailure(''); }}>Utiliser les valeurs actuelles</Button></div></>}
        {failure && <details><summary>Détail du message</summary><p>{failure}</p></details>}
        <div className="catalog-form-choices"><Button type="button" variant="ghost" disabled={locked} onClick={() => void refresh()}>Relire la fiche</Button>{missing && <Button type="button" variant="secondary" disabled={locked} onClick={close}>Revenir au catalogue</Button>}</div>
      </div>}
      <fieldset disabled={locked || readOnly || changed || missing}>
        <section className="catalog-form-section"><h3>Que proposez-vous ?</h3>
          <div className="catalog-kind-picker" role="group" aria-label="Type de référence">{(['service', 'product'] as const).map(kind => <Button key={kind} type="button" variant="secondary" aria-pressed={draft.kind === kind} disabled={history} onClick={() => chooseKind(kind)}>{kind === 'service' ? <Wrench size={19} /> : <Box size={19} />}<span><strong>{kind === 'service' ? 'Service' : 'Produit'}</strong><small>{kind === 'service' ? 'Une prestation : conseil, pose, entretien…' : 'Un bien : peinture, matériel, marchandise…'}</small></span></Button>)}</div>
          {history && <p className="catalog-form-hint">Ce produit a déjà un historique de stock. Son type et son suivi restent conservés. Pour une prestation, ajoutez une référence de service.</p>}
          {fieldError('kind') && <p role="alert" className="catalog-form-field-error">{fieldError('kind')}</p>}
          <Field label="Nom à retrouver dans les documents" required error={fieldError('name')}><input {...input('name')} autoFocus maxLength={200} placeholder={draft.kind === 'service' ? 'Ex. Pose de parquet' : 'Ex. Peinture blanche'} /></Field>
          <div className="form-grid"><Field label="Unité du prix" required hint="Le prix ci-dessous correspond à une seule unité." error={fieldError('unit')}><input {...input('unit')} maxLength={40} /></Field><Field label="Prix de vente par unité (CHF, hors TVA)" required error={fieldError('salesPrice')} hint="Ex. 85,50. La TVA est ajoutée dans le document."><input {...input('salesPrice')} inputMode="decimal" /></Field></div>
          <div className="catalog-form-choices" role="group" aria-label="Unités habituelles">{(draft.kind === 'service' ? ['heure', 'forfait', 'jour', 'm²'] : ['pièce', 'mètre', 'litre', 'kg', 'm²']).map(unit => <Button key={unit} type="button" size="small" variant="ghost" aria-pressed={draft.unit === unit} onClick={() => change('unit', unit)}>{unit}</Button>)}</div>
        </section>
        <section className="catalog-form-section"><h3>Quel montant pour le client ?</h3>
          <Field label="TVA à ajouter" required error={fieldError('vatBp')} hint={settings.organization.vatRegistered ? 'Le taux doit correspondre à ce que vous vendez.' : 'Votre entreprise est configurée comme non assujettie : choisissez 0 %.'}><select {...input('vatBp')}>{rates.map(rate => <option key={rate} value={rate}>{rate / 100} %{rate === 0 ? ' · aucune TVA ajoutée' : !settings.billing.vatRatesBp.includes(rate) ? ' · taux de cette fiche' : ''}</option>)}</select></Field>
          {preview && <dl className="catalog-form-price" aria-label="Exemple pour une unité"><div><dt>Prix hors TVA</dt><dd>{formatCatalogMoney(preview.netCents)}</dd></div><div><dt>TVA ajoutée</dt><dd>{formatCatalogMoney(preview.vatCents)}</dd></div><div><dt>Total pour 1 {draft.unit || 'unité'}</dt><dd>{formatCatalogMoney(preview.totalCents)}</dd></div></dl>}
          <p className="catalog-form-hint">Exemple sans remise. Dans un devis ou une facture, vous pourrez adapter la quantité, le prix et le texte de la ligne.</p>
          <a href="https://www.estv.admin.ch/fr/taux-de-la-tva-suisse" target="_blank" rel="noreferrer">Comprendre les taux sur le site de l’AFC</a>
        </section>
        <details className="catalog-form-section"><summary>Référence, description et coût d’achat <small>Facultatif</small></summary><div className="catalog-form-optional">
          <Field label="Référence interne" hint="Le code de votre catalogue, aussi appelé SKU." error={fieldError('sku')}><input {...input('sku')} maxLength={80} /></Field>
          <Field label="Description pour les devis et factures" hint="Vous pourrez adapter ce texte dans chaque document." error={fieldError('description')}><textarea {...input('description')} rows={4} maxLength={10_000} /></Field>
          <Field label="Coût d’achat par unité (CHF)" hint="Repère interne facultatif. Un champ vide est enregistré à zéro ; cette fiche ne comptabilise aucun achat ni TVA récupérable." error={fieldError('purchaseCost')}><input {...input('purchaseCost')} inputMode="decimal" /></Field>
        </div></details>
        {draft.kind === 'product' && <section className="catalog-form-section"><h3>Souhaitez-vous suivre les quantités ?</h3><Field label="Suivre les quantités en stock" error={fieldError('trackStock')}><input name="trackStock" type="checkbox" checked={draft.trackStock} disabled={history} onChange={event => change('trackStock', event.target.checked)} /></Field>
          {draft.trackStock && <><p className="catalog-form-hint">{current ? `Présent au dépôt : ${formatCatalogQuantity(current.stockQuantityMilli)} ${current.unit}. Cette fiche ne modifie pas la quantité.` : 'Le produit commencera à zéro. Après l’enregistrement, utilisez Entrée sur sa fiche pour renseigner le stock de départ.'}</p><Field label="M’avertir à partir de cette quantité" error={fieldError('reorderLevel')} hint="Le seuil compare la quantité disponible après réservations. Zéro : avertir uniquement en rupture."><input {...input('reorderLevel')} inputMode="decimal" /></Field></>}
        </section>}
        {current?.archivedAt && <p className="catalog-form-hint">Cette référence est archivée. Modifier sa fiche ne la réactive pas.</p>}
      </fieldset>
      <FormActions onCancel={close} busy={locked} disabled={readOnly || changed || missing} submitLabel={item ? 'Enregistrer les modifications' : 'Ajouter au catalogue'} />
    </form>
  </Modal>;
}
