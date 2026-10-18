import type { WorkspaceMutationOrigin } from './workspaceMemberOrigin';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Box, Wrench } from 'lucide-react';
import { desktopApi } from './bridge';
import type { CatalogItem, Workspace } from './types';
import { catalogDraft, catalogFormData, catalogFormIssue, catalogNativeIssue, catalogPricePreview, catalogVatRates, formatCatalogMoney, mergeCatalogDraft, requireCatalogWorkspace, type CatalogDraft, type CatalogIssue } from './catalogForm';
import { formatCatalogQuantity } from './catalog';
import { createId, errorMessage } from './utils';
import { Button, Field, FormActions, Modal } from './ui';
import { FormDraftNotice, useFormDraft, useFormDraftScope } from './useFormDraft';
import { draftObject, draftStrings, formDraftFingerprint } from './formDrafts';
import { ErrorGuidance } from './ErrorGuidance';
import { useAppLanguage, t } from './language';
import { autopilotCatalogueCopy } from './autopilotPresentation';
import { assertAutopilotCatalogueMutationOrigin, autopilotCatalogueSkuExists, type AutopilotCatalogueRequest } from './autopilotCatalogue';
import { WorkspaceOriginChangedError } from './workspaceOrigin';
import './catalog-form.css';

type ActionRunner = (action: (origin: WorkspaceMutationOrigin) => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void, validateRead?: (workspace: Workspace) => void) => Promise<boolean>;
const labels: Record<keyof CatalogDraft, string> = { kind: 'Type', name: 'Nom', sku: 'Référence', description: 'Description', unit: 'Unité', salesPrice: 'Prix de vente', purchaseCost: 'Coût d’achat', vatBp: 'TVA', trackStock: 'Suivi du stock', reorderLevel: 'Seuil d’alerte' };
const display = (field: keyof CatalogDraft, value: string | boolean) => field === 'kind' ? t(value === 'product' ? 'Produit' : 'Service') : typeof value === 'boolean' ? t(value ? 'Activé' : 'Désactivé') : field === 'vatBp' ? `${Number(value) / 100} %` : value || t('Non renseigné');
type SavedCatalogDraft = CatalogDraft & { recordId: string };
const catalogDraftFields = ['recordId', 'kind', 'name', 'sku', 'description', 'unit', 'salesPrice', 'purchaseCost', 'vatBp', 'reorderLevel'] as const;
const validCatalogDraft = (value: unknown): value is SavedCatalogDraft => draftStrings(value, catalogDraftFields) &&
  draftObject(value) && Object.keys(value).length === catalogDraftFields.length + 1 && ['service', 'product'].includes(String(value.kind)) && typeof value.trackStock === 'boolean';

export function CatalogItemForm({ item, workspace, busy, readOnly, close, act, onReadWorkspace, autopilotRequest, onCreated }: {
  item?: CatalogItem; workspace: Workspace; busy: boolean; readOnly: boolean; close: () => void; act: ActionRunner; onReadWorkspace: () => Promise<Workspace>;
  autopilotRequest?: AutopilotCatalogueRequest; onCreated?: (id: string) => void;
}) {
  const language = useAppLanguage(), catalogue = autopilotCatalogueCopy(language);
  const settings = workspace.settings!;
  const [newId] = useState(() => item?.id ?? createId());
  const current = item ? workspace.catalogItems.find(row => row.id === item.id) : undefined;
  const [baseline, setBaseline] = useState(item);
  const persisted = useFormDraft({ scope: useFormDraftScope(workspace, 'catalog', item?.id, autopilotRequest ? `review:${autopilotRequest.proposalId}` : undefined),
    initial: { ...catalogDraft(current, settings), ...(!item && autopilotRequest ? { vatBp: '', unit: '', ...(autopilotRequest.phrase ? { name: autopilotRequest.phrase.slice(0, 120) } : {}) } : {}), recordId: newId }, fingerprint: current ? formDraftFingerprint(current) : item ? 'missing' : 'new', validate: validCatalogDraft });
  const draft = persisted.value, setDraft = persisted.setValue, id = draft.recordId;
  const closeForm = () => persisted.close(close);
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
    if (locked || readOnly || changed || missing || persisted.pending || persisted.conflict) return;
    setDraft(previous => ({ ...previous, [field]: value })); setIssue(null); setFailure('');
  }
  function chooseKind(kind: CatalogItem['kind']) {
    if (locked || readOnly || changed || missing || history || persisted.pending || persisted.conflict) return;
    setDraft(previous => ({ ...previous, kind, unit: !item && ['heure', 'pièce'].includes(previous.unit) ? kind === 'product' ? 'pièce' : 'heure' : previous.unit })); setIssue(null); setFailure('');
  }
  const issueText = (message: string) => {
    if (message === 'Indiquez le nom à retrouver dans vos documents.') return t(message);
    if (message.startsWith('Indiquez l’unité utilisée')) return t('Indiquez l’unité utilisée pour le prix, par exemple heure ou pièce.');
    const length = /^Raccourcissez .+ à (.+) caractères maximum\.$/.exec(message);
    return length ? t('Raccourcissez ce champ à {count} caractères maximum.', { count: length[1] }) : t(message);
  };
  const fieldError = (field: keyof CatalogDraft) => issue?.field === field ? issueText(issue.message) : undefined;
  const input = (field: Exclude<keyof CatalogDraft, 'kind' | 'trackStock'>) => ({ name: field, value: draft[field], onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => change(field, event.target.value), 'aria-invalid': !!fieldError(field) });
  const refused = (reason: unknown) => { setIssue(catalogNativeIssue(reason));
    setFailure(autopilotRequest ? reason instanceof WorkspaceOriginChangedError ? catalogue.contextChanged : t('La fiche n’a pas pu être enregistrée. Votre saisie est conservée.')
      : t(errorMessage(reason, 'La fiche n’a pas pu être enregistrée. Votre saisie est conservée.'))); };
  async function refresh() {
    if (locked || inFlight.current) return;
    setReading(true); setFailure('');
    try { await onReadWorkspace(); } catch (reason) { refused(reason); } finally { setReading(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked || readOnly || inFlight.current || changed || missing || persisted.pending || persisted.conflict) return;
    const originWorkspaceScope = workspace.workNotesScope;
    const invalid = catalogFormIssue(draft, allowedRates, current, history);
    if (invalid) { setIssue(invalid); return; }
    if (autopilotRequest && autopilotCatalogueSkuExists(draft.sku, workspace.catalogItems)) {
      setIssue({ field: 'sku', message: catalogue.skuExists }); return;
    }
    setIssue(null); setFailure(''); inFlight.current = true; setSaving(true);
    try {
      const saved = await act((mutationOrigin) => {
        if (autopilotRequest) assertAutopilotCatalogueMutationOrigin(autopilotRequest, mutationOrigin);
        return desktopApi.saveCatalogItem(id, catalogFormData(draft, !!item), item ? baseline?.updatedAt ?? '' : undefined, originWorkspaceScope, mutationOrigin.memberContextNonce);
      }, autopilotRequest ? catalogue.saved : t(item ? 'La référence a été enregistrée. Les documents existants et le stock sont conservés.' : draft.kind === 'product' && draft.trackStock ? 'Le produit a été ajouté. Utilisez Entrée sur sa fiche pour renseigner le stock de départ.' : 'La référence a été ajoutée au catalogue.'), true, refused, requireCatalogWorkspace);
      persisted.complete(saved);
      if (saved && !item) onCreated?.(id);
    } catch (reason) { refused(reason); } finally { inFlight.current = false; setSaving(false); }
  }
  return <Modal title={item ? t("Modifier la référence") : autopilotRequest ? catalogue.add : t("Ajouter un produit ou un service")} description={autopilotRequest ? catalogue.formHint : t("Donnez un nom et un prix pour réutiliser cette référence dans vos prochains devis et factures.")} onClose={closeForm} dismissible={!locked} wide className="catalog-form-modal">
    <form ref={formRef} className="catalog-form" onSubmit={submit} noValidate>
      {!readOnly && <FormDraftNotice draft={{ ...persisted, conflict: persisted.conflict && !changed, discard: () => { persisted.discard(); setBaseline(current); } }} disabled={locked} currentValues={(Object.keys(labels) as (keyof CatalogDraft)[]).map(field => ({ label: t(labels[field]), value: display(field, currentDraft[field]) }))} />}
      {item && <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => void refresh()}>{t("Actualiser la fiche")}</Button>}
      {(changed || missing || failure) && <div ref={alertRef} tabIndex={-1} className="catalog-form-alert" role="alert">
        <strong>{missing ? t("Cette référence n’est plus accessible") : changed ? t("La fiche a changé entre-temps") : t("Vérifions ce point")}</strong>
        <p>{missing ? t("Votre saisie reste affichée. Actualisez ou revenez au catalogue pour vérifier la référence.") : changed ? t("Votre saisie est conservée. Comparez les informations avant de reprendre ; aucun choix ci-dessous n’enregistre la fiche.") : issue?.message || 'Votre saisie est conservée. Vous pouvez corriger la fiche ou réessayer.'}</p>
        {changed && <>{differences.length ? <div className="catalog-form-comparison">{differences.map(field => <section key={field}><h4>{t(labels[field])}</h4><div><span>{t("Votre saisie")}</span><p>{display(field, draft[field])}</p></div><div><span>{t("Version actuelle")}</span><p>{display(field, currentDraft[field])}</p></div></section>)}</div> : <p>{t("Les informations à remplir sont identiques ; le stock ou l’état de la fiche a été actualisé.")}</p>}
          <p>{t("Conserver ma saisie garde les champs que vous avez modifiés et reprend les autres informations actuelles.")}</p><div className="catalog-form-choices"><Button type="button" disabled={locked || readOnly} onClick={() => { setDraft({ ...mergeCatalogDraft(beforeDraft, draft, currentDraft), recordId: id }); persisted.keepLocal(); setBaseline(current); setIssue(null); setFailure(''); }}>{t("Conserver ma saisie")}</Button><Button type="button" variant="secondary" disabled={locked || readOnly} onClick={() => { setBaseline(current); setDraft({ ...currentDraft, recordId: id }); persisted.keepLocal(); setIssue(null); setFailure(''); }}>{t("Utiliser les valeurs actuelles")}</Button></div></>}
        {failure && <ErrorGuidance error={failure} operation="mutation" compact />}
        <div className="catalog-form-choices"><Button type="button" variant="ghost" disabled={locked} onClick={() => void refresh()}>{t("Relire la fiche")}</Button>{missing && <Button type="button" variant="secondary" disabled={locked} onClick={closeForm}>{t("Revenir au catalogue")}</Button>}</div>
      </div>}
      <fieldset disabled={locked || readOnly || changed || missing || !!persisted.pending || persisted.conflict || persisted.invalid}>
        <section className="catalog-form-section"><h3>{t("Que proposez-vous ?")}</h3>
          <div className="catalog-kind-picker" role="group" aria-label={t("Type de référence")}>{(['service', 'product'] as const).map(kind => <Button key={kind} type="button" variant="secondary" aria-pressed={draft.kind === kind} disabled={history} onClick={() => chooseKind(kind)}>{kind === 'service' ? <Wrench size={19} /> : <Box size={19} />}<span><strong>{kind === 'service' ? t("Service") : t("Produit")}</strong><small>{kind === 'service' ? t("Une prestation : conseil, pose, entretien…") : t("Un bien : peinture, matériel, marchandise…")}</small></span></Button>)}</div>
          {history && <p className="catalog-form-hint">{t("Ce produit a déjà un historique de stock. Son type et son suivi restent conservés. Pour une prestation, ajoutez une référence de service.")}</p>}
          {fieldError('kind') && <p role="alert" className="catalog-form-field-error">{fieldError('kind')}</p>}
          <Field label={t("Nom à retrouver dans les documents")} required error={fieldError('name')}><input {...input('name')} autoFocus maxLength={200} placeholder={draft.kind === 'service' ? t("Ex. Pose de parquet") : t("Ex. Peinture blanche")} /></Field>
          <div className="form-grid"><Field label={t("Unité du prix")} required hint={t("Le prix ci-dessous correspond à une seule unité.")} error={fieldError('unit')}><input {...input('unit')} maxLength={40} /></Field><Field label={t("Prix de vente par unité (CHF, hors TVA)")} required error={fieldError('salesPrice')} hint={t("Ex. 85,50. La TVA est ajoutée dans le document.")}><input {...input('salesPrice')} inputMode="decimal" /></Field></div>
          <div className="catalog-form-choices" role="group" aria-label={t("Unités habituelles")}>{(draft.kind === 'service' ? ['heure', 'forfait', 'jour', 'm²'] : ['pièce', 'mètre', 'litre', 'kg', 'm²']).map(unit => <Button key={unit} type="button" size="small" variant="ghost" aria-pressed={draft.unit === t(unit)} onClick={() => change('unit', t(unit))}>{t(unit)}</Button>)}</div>
        </section>
        <section className="catalog-form-section"><h3>{t("Quel montant pour le client ?")}</h3>
          <Field label={t("TVA à ajouter")} required error={fieldError('vatBp')} hint={settings.organization.vatRegistered ? t("Le taux doit correspondre à ce que vous vendez.") : t("Votre entreprise est configurée comme non assujettie : choisissez 0 %.")}><select {...input('vatBp')}>{autopilotRequest && <option value="" disabled>{catalogue.chooseTax}</option>}{rates.map(rate => <option key={rate} value={rate}>{rate / 100}%{rate === 0 ? ' · ' + t('aucune TVA ajoutée') : !settings.billing.vatRatesBp.includes(rate) ? ' · ' + t('taux de cette fiche') : ''}</option>)}</select></Field>
          {preview && <dl className="catalog-form-price" aria-label={t("Exemple pour une unité")}><div><dt>{t("Prix hors TVA")}</dt><dd>{formatCatalogMoney(preview.netCents)}</dd></div><div><dt>{t("TVA ajoutée")}</dt><dd>{formatCatalogMoney(preview.vatCents)}</dd></div><div><dt>{t('Total pour 1 {unit}', { unit: draft.unit || t('unité') })}</dt><dd>{formatCatalogMoney(preview.totalCents)}</dd></div></dl>}
          <p className="catalog-form-hint">{t("Exemple sans remise. Dans un devis ou une facture, vous pourrez adapter la quantité, le prix et le texte de la ligne.")}</p>
          <a href="https://www.estv.admin.ch/fr/taux-de-la-tva-suisse" target="_blank" rel="noreferrer">{t("Comprendre les taux sur le site de l’AFC")}</a>
        </section>
        <details className="catalog-form-section"><summary>{t("Référence, description et coût d’achat")}{' '}<small>{t("Facultatif")}</small></summary><div className="catalog-form-optional">
          <Field label={t("Référence interne")} hint={t("Le code de votre catalogue, aussi appelé SKU.")} error={fieldError('sku')}><input {...input('sku')} maxLength={80} /></Field>
          <Field label={t("Description pour les devis et factures")} hint={t("Vous pourrez adapter ce texte dans chaque document.")} error={fieldError('description')}><textarea {...input('description')} rows={4} maxLength={10_000} /></Field>
          <Field label={t("Coût d’achat par unité (CHF)")} hint={t("Repère interne facultatif. Un champ vide est enregistré à zéro ; cette fiche ne comptabilise aucun achat ni TVA récupérable.")} error={fieldError('purchaseCost')}><input {...input('purchaseCost')} inputMode="decimal" /></Field>
        </div></details>
        {draft.kind === 'product' && <section className="catalog-form-section"><h3>{t("Souhaitez-vous suivre les quantités ?")}</h3><Field label={t("Suivre les quantités en stock")} error={fieldError('trackStock')}><input name="trackStock" type="checkbox" checked={draft.trackStock} disabled={history} onChange={event => change('trackStock', event.target.checked)} /></Field>
          {draft.trackStock && <><p className="catalog-form-hint">{current ? t('Présent au dépôt : {quantity} {unit}. Cette fiche ne modifie pas la quantité.', { quantity: formatCatalogQuantity(current.stockQuantityMilli), unit: current.unit }) : t("Le produit commencera à zéro. Après l’enregistrement, utilisez Entrée sur sa fiche pour renseigner le stock de départ.")}</p><Field label={t("M’avertir à partir de cette quantité")} error={fieldError('reorderLevel')} hint={t("Le seuil compare la quantité disponible après réservations. Zéro : avertir uniquement en rupture.")}><input {...input('reorderLevel')} inputMode="decimal" /></Field></>}
        </section>}
        {current?.archivedAt && <p className="catalog-form-hint">{t("Cette référence est archivée. Modifier sa fiche ne la réactive pas.")}</p>}
      </fieldset>
      <FormActions onCancel={closeForm} busy={locked} disabled={readOnly || changed || missing || !!persisted.pending || persisted.conflict || persisted.invalid} submitLabel={item ? t("Enregistrer les modifications") : t("Ajouter au catalogue")} />
    </form>
  </Modal>;
}
