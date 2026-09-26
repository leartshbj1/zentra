import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, CheckCircle2, Plus, ReceiptText, Trash2 } from 'lucide-react';
import { desktopApi } from './bridge';
import { AttentionSuggestion } from './AutomationControls';
import { SupplierRouting } from './AutomationDocument';
import { automationResourceFeedback, type AutomationDecision } from './automation';
import { InvoiceScanPanel } from './InvoiceScanPanel';
import { applyInvoiceScan } from './invoiceScan';
import type { SupplierInvoice, Workspace } from './types';
import { selectableSuppliers, supplierDueDate } from './purchases';
import { purchaseCostCategories, purchaseVatOptions, nonRegisteredPurchaseVatHint } from './purchaseVat';
import { projectTerminology } from './terminology';
import { createId, errorMessage, formatDate, formatMoney } from './utils';
import { isSalesDate } from './salesFormValidation';
import { Button, ErrorPanel, Field, Modal, submitForm } from './ui';
import { changePurchaseDate, newPurchaseLine, purchaseFields, purchaseIssue, purchaseLineField, purchaseLineValue, purchaseTotals, supplierInvoiceLineTotals, type PurchaseFields, type PurchaseIssue, type PurchaseLineFields } from './supplierInvoicePreparation';
import { t, useAppLanguage, getAppLocale } from './language';
import { purchaseIssueText, purchaseNativeMessage } from './purchaseLanguage';
import './purchase-entry.css';

export type SupplierPreparationProps = {
  item?: SupplierInvoice; initialTarget?: 'reference' | 'attachments'; workspace: Workspace; busy: boolean; readOnly?: boolean;
  close: () => void;
  act: (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;
  renderAttachments: (invoice: SupplierInvoice | undefined, canEdit: boolean, busy: boolean, onPending: (pending: boolean) => void) => ReactNode;
};
const steps = ['Facture', 'Achats', 'Vérifier', 'Justificatif'];
const titles = ['Quelle facture avez-vous reçue ?', 'Recopiez ce que vous avez acheté', 'Comparez avec la facture originale', 'Gardez le document original'];

export function SupplierInvoicePreparation(props: SupplierPreparationProps) {
  return <Preparation key={`${props.item?.id ?? 'new'}:${props.initialTarget ?? ''}`} {...props} />;
}

function Preparation({ item, initialTarget, workspace, busy, readOnly = false, close, act, renderAttachments }: SupplierPreparationProps) {
  const language = useAppLanguage();
  const settings = workspace.settings!, terminology = projectTerminology(settings.business.nogaSection);
  const [draftId] = useState(() => item?.id ?? createId());
  const [scanFile,setScanFile]=useState<File|null>(null);
  const [automationText,setAutomationText]=useState('');
  const automationDecision=useRef<AutomationDecision|null>(null);
  const [initial] = useState(() => purchaseFields(workspace, item));
  const [fields, setFields] = useState(initial), [baseline, setBaseline] = useState(initial);
  const [step, setStep] = useState(initialTarget === 'attachments' && item ? 3 : 0);
  const [issue, setIssue] = useState<PurchaseIssue | null>(initialTarget === 'reference' ? { step: 0, field: 'reference', message: 'Recopiez le numéro indiqué sur la facture reçue, puis enregistrez le brouillon.' } : null);
  const [serverError, setServerError] = useState(''), [saving, setSaving] = useState(false), [attachmentPending, setAttachmentPending] = useState(false), [leaving, setLeaving] = useState(false);
  const inFlight = useRef(false), form = useRef<HTMLFormElement>(null), heading = useRef<HTMLHeadingElement>(null), problem = useRef<HTMLDivElement>(null), leavePanel = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step), previousLeave = useRef(false), firstFocus = useRef(true), leaveOrigin = useRef<HTMLElement | null>(null);
  const current = workspace.supplierInvoices.find(invoice => invoice.id === draftId);
  const matching = workspace.supplierInvoiceMatches.some(match => match.supplierInvoiceId === draftId);
  const unavailable = Boolean(item && !current), finalized = Boolean(current && current.documentStatus !== 'draft');
  const locked = busy || saving || attachmentPending;
  const cannotEdit = readOnly || matching || finalized || unavailable;
  const dirty = Boolean(scanFile) || JSON.stringify(fields) !== JSON.stringify(baseline);
  const choices = selectableSuppliers(workspace.suppliers, item?.supplierId);
  const supplier = choices.find(value => value.id === fields.supplierId);
  const rates = purchaseVatOptions(settings.organization.vatRegistered, settings.billing.vatRatesBp);
  const totals = purchaseTotals(fields.lines);
  const money = (value: number | undefined) => value === undefined ? t("À compléter") : formatMoney(value);
  const date = (value: string) => isSalesDate(value) ? formatDate(value) : t("À compléter");
  const fieldError = (name: string) => issue?.field === name ? purchaseIssueText(issue) : undefined;

  useEffect(() => {
    if (locked) return;
    let target: HTMLElement | null = null;
    if (leaving) target = leavePanel.current;
    else if (issue) {
      const field = form.current?.elements.namedItem(issue.field);
      target = field instanceof HTMLElement ? field : form.current?.querySelector('[data-purchase-lines]') ?? null;
      const details = target?.closest('details'); if (details) details.open = true;
    } else if (serverError) target = problem.current;
    else if (previousLeave.current) target = leaveOrigin.current?.isConnected ? leaveOrigin.current : heading.current;
    else if (firstFocus.current && initialTarget === 'attachments') target = form.current?.querySelector('.supplier-preparation__page') ?? null;
    else if (firstFocus.current || previousStep.current !== step) target = heading.current;
    previousStep.current = step; previousLeave.current = leaving; firstFocus.current = false;
    const frame = requestAnimationFrame(() => { target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' }); });
    return () => cancelAnimationFrame(frame);
  }, [step, issue, serverError, leaving, locked]);

  useEffect(() => {
    const container = form.current; let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const input = document.activeElement;
        if (!(input instanceof HTMLElement) || !container?.contains(input) || !input.matches('input, textarea, select')) return;
        const body = container.closest<HTMLElement>('.modal__body'); if (!body) return;
        const area = body.getBoundingClientRect(), rect = input.getBoundingClientRect(), viewport = window.visualViewport;
        const top = Math.max(area.top, viewport?.offsetTop ?? 0) + 12;
        let bottom = Math.min(area.bottom, viewport ? viewport.offsetTop + viewport.height : innerHeight) - 12;
        const bar = container.querySelector('.supplier-preparation__actions')?.getBoundingClientRect();
        if (bar && bar.top > top && bar.top < bottom) bottom = bar.top - 12;
        if (bottom > top && (rect.top < top || rect.bottom > bottom)) body.scrollBy({ top: rect.top - top - Math.max(0, (bottom - top - rect.height) / 2), behavior: 'instant' });
      });
    };
    container?.addEventListener('focusin', reveal); window.addEventListener('resize', reveal); window.visualViewport?.addEventListener('resize', reveal); reveal();
    return () => { cancelAnimationFrame(frame); container?.removeEventListener('focusin', reveal); window.removeEventListener('resize', reveal); window.visualViewport?.removeEventListener('resize', reveal); };
  }, [language]);

  function change<K extends Exclude<keyof PurchaseFields, 'lines'>>(field: K, value: PurchaseFields[K]) {
    if (locked || cannotEdit || inFlight.current) return;
    setFields(previous => field === 'date' || field === 'supplierId' ? changePurchaseDate(previous, field, value, workspace) : { ...previous, [field]: value });
    if (issue?.field === field) setIssue(null); setServerError('');
  }
  function patchLine(id: string, patch: Partial<PurchaseLineFields>) {
    if (locked || cannotEdit || inFlight.current) return;
    setFields(previous => ({ ...previous, lines: previous.lines.map(line => line.id === id ? { ...line, ...patch } : line) }));
    if (issue && Object.keys(patch).some(key => issue.field === purchaseLineField(id, key))) setIssue(null); setServerError('');
  }
  function validate(onlyStep?: 0 | 1) {
    const next = purchaseIssue(fields, rates, onlyStep);
    setIssue(next); if (next) setStep(next.step); return !next;
  }
  function go(next: number) {
    if (locked || inFlight.current) return;
    if (!cannotEdit && next === 1 && !validate(0)) return;
    if (!cannotEdit && next === 2 && !validate()) return;
    if (next === 3 && (!current || dirty)) return;
    setStep(next); setIssue(null); setServerError('');
  }
  function requestClose() {
    if (locked || inFlight.current) return;
    if (dirty) { leaveOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setLeaving(true); }
    else close();
  }
  async function save() {
    if (locked || cannotEdit || inFlight.current || !validate()) return;
    inFlight.current = true; setSaving(true); setServerError('');
    let reported = false;
    const report = (reason: unknown) => { reported = true; setServerError(errorMessage(reason, 'Le brouillon n’a pas pu être enregistré. Votre saisie est conservée.')); };
    try {
      const saved = await act(() => desktopApi.saveSupplierInvoiceDraft({
        id: draftId, supplierId: fields.supplierId, projectId: fields.projectId || null, date: fields.date, dueDate: fields.dueDate,
        reference: fields.reference.trim(), note: fields.note.trim(), vatTreatment: fields.vatTreatment || undefined,
        items: fields.lines.map(value => { const line = purchaseLineValue(value)!; return { ...line, expenseAccountId: line.expenseAccountId || null, projectId: line.projectId || null }; }),
      }), current ? t('Le brouillon fournisseur a été mis à jour.') : t('Le brouillon fournisseur a été enregistré. Ajoutez maintenant son justificatif.'), false, report);
      if (saved) {
        void automationResourceFeedback(automationDecision.current,{supplier:fields.supplierId||null,project:fields.projectId||null,expense_category:fields.lines[0]?.category||null});
        setBaseline(fields); setStep(3);
        if(scanFile){
          const attached=await act(()=>desktopApi.addScannedSupplierAttachment(draftId,scanFile),t('Le document original est joint à la facture.'),false,report);
          if(attached)setScanFile(null);
          else if(!reported)setServerError('Le brouillon est enregistré, mais le justificatif reste à joindre. Réessayez ci-dessous.');
        }
      }
      else if (!reported) setServerError('La sauvegarde n’est pas confirmée. Votre saisie reste présente ; vérifiez le message de reprise avant une nouvelle tentative.');
    } catch (reason) { report(reason); }
    finally { inFlight.current = false; setSaving(false); }
  }

  return <Modal className="purchase-entry-modal supplier-preparation" title={item ? t("Modifier le brouillon fournisseur") : t("Nouvelle facture fournisseur")} description={t("Un pas à la fois : recopiez, vérifiez, puis gardez l’original.")} wide dismissible={!locked} onClose={requestClose}>
    <form ref={form} noValidate onSubmit={submitForm(async () => { if (step < 2) go(step + 1); else if (step === 2) await save(); })}>
      <nav className="supplier-preparation__steps" aria-label={t("Étapes de la facture fournisseur")}>{steps.map((label, index) => <Button key={label} type="button" variant="ghost" aria-current={step === index ? 'step' : undefined} disabled={locked || index === 3 && (!current || dirty)} onClick={() => go(index)}><span>{index + 1}</span>{t(label)}</Button>)}</nav>
      <div className="supplier-preparation__overview"><div><small>{supplier?.name || t("Fournisseur à choisir")}</small><strong>{fields.reference || t("Facture reçue")}</strong></div><div><small>{t("Total TTC")}</small><strong>{money(totals?.totalCents)}</strong></div></div>
      {readOnly && <p className="info-strip">{t("Mode lecture seule : vous pouvez consulter les étapes, sans enregistrer de modification.")}</p>}
      {matching && <p className="info-strip">{t("Ce brouillon est rapproché avec une commande. Ses informations sont protégées ; les justificatifs restent accessibles. Retirez les liens dans le rapprochement pour modifier les achats.")}</p>}
      {(finalized || unavailable) && <p className="info-strip">{finalized ? t("Cette facture a été validée. Ses informations sont maintenant protégées.") : t("Ce brouillon n’est plus dans la liste des achats. Fermez cette fenêtre et actualisez les achats.")}</p>}
      <section className="supplier-preparation__page" key={step} tabIndex={-1} aria-labelledby="supplier-preparation-heading">
        <h3 id="supplier-preparation-heading" ref={heading} tabIndex={-1}>{t(titles[step])}</h3>
        {step === 0 && <fieldset disabled={locked || cannotEdit}>
          <InvoiceScanPanel disabled={locked||cannotEdit} onBusy={setAttachmentPending} onApply={(scan,file,text)=>{setFields(previous=>applyInvoiceScan(scan,previous,workspace));setScanFile(file);setAutomationText(text);automationDecision.current=null;setIssue(null);setServerError('');}}/>
          {automationText&&<SupplierRouting text={automationText} workspace={workspace} disabled={locked||cannotEdit} onDecision={value=>{automationDecision.current=value;}} onApply={ids=>{setFields(previous=>({...previous,...(ids.supplier?{supplierId:ids.supplier}:{}),...(ids.project?{projectId:ids.project}:{}),lines:ids.category?previous.lines.map(line=>({...line,category:ids.category!})):previous.lines}));}}/>}
          <p>{t("Gardez la facture devant vous. Recopiez son fournisseur et ses dates ; les achats viennent juste après.")}</p>
          <div className="form-grid">
            <Field label={t("Fournisseur")} required wide error={fieldError('supplierId')}><select name="supplierId" value={fields.supplierId} onChange={event => change('supplierId', event.target.value)}><option value="">{t("Choisir un fournisseur")}</option>{choices.map(value => <option key={value.id} value={value.id}>{value.name}{value.archivedAt ? t(" · archivé (historique)") : ''}</option>)}</select></Field>
            <Field label={t("Numéro / référence fournisseur")} error={fieldError('reference')} hint={t("Recopiez le numéro du document reçu. Vous pourrez le compléter avant la validation si vous ne l’avez pas encore.")}><input name="reference" value={fields.reference} maxLength={200} onChange={event => change('reference', event.target.value)} /></Field>
            <Field label={t(terminology.singularTitle)} hint={t("Facultatif. Rattachez cet achat au dossier concerné.")}><select name="projectId" value={fields.projectId} onChange={event => change('projectId', event.target.value)}><option value="">{t("Aucun projet")}</option>{workspace.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
            <Field label={t("Date de facture")} required error={fieldError('date')} hint={t("La date inscrite sur la facture reçue.")}><input name="date" type="date" value={fields.date} onChange={event => change('date', event.target.value)} /></Field>
            <Field label={t("Échéance")} required error={fieldError('dueDate')} hint={t("La date limite de paiement indiquée par le fournisseur.")}><input name="dueDate" type="date" value={fields.dueDate} onChange={event => change('dueDate', event.target.value)} /></Field>
          </div>
          <Button type="button" variant="secondary" disabled={locked || cannotEdit || !isSalesDate(fields.date)} onClick={() => change('dueDate', supplierDueDate(fields.date, supplier, settings.billing.paymentTermsDays))}>{t("Reprendre le délai habituel")}</Button>
          {fields.dueDate&&<AttentionSuggestion context={{dueDate:fields.dueDate,resolved:false}} identity={`supplier-due:${draftId}`}/>}
          <Field label={t("Note interne")} error={fieldError('note')} hint={t("Facultatif. Cette note sert à votre suivi de l’achat.")}><textarea name="note" rows={3} value={fields.note} maxLength={10_000} onChange={event => change('note', event.target.value)} /></Field>
        </fieldset>}
        {step === 1 && <fieldset disabled={locked || cannotEdit}>
          <p>{t("Une ligne par article ou prestation. Recopiez le prix d’une unité hors TVA : le total se calcule en dessous.")}</p>
          {!settings.organization.vatRegistered && <p className="info-strip">{t(nonRegisteredPurchaseVatHint)}</p>}
          <div data-purchase-lines tabIndex={-1} className="supplier-preparation__lines">
            {fields.lines.map((line, index) => {
              const value = purchaseLineValue(line), total = value && supplierInvoiceLineTotals(value);
              const name = (field: string) => purchaseLineField(line.id, field), error = (field: string) => fieldError(name(field));
              return <article className="supplier-preparation__line" key={line.id}>
                <header><strong>{t("Achat {number}", { number: index + 1 })}</strong><span>{money(total?.totalCents)}</span></header>
                <div className="form-grid">
                  <Field label={t("Description")} required wide error={error('description')}><input name={name('description')} value={line.description} maxLength={1_000} onChange={event => patchLine(line.id, { description: event.target.value })} /></Field>
                  <Field label={t("Quantité")} required error={error('quantity')} hint={t("Exemple : 2 ou 2,5.")}><input name={name('quantity')} inputMode="decimal" value={line.quantity} maxLength={64} onChange={event => patchLine(line.id, { quantity: event.target.value })} /></Field>
                  <Field label={t("Unité")} required error={error('unit')}><input name={name('unit')} value={line.unit} maxLength={50} onChange={event => patchLine(line.id, { unit: event.target.value })} /></Field>
                  <Field label={t("Prix unitaire net (CHF)")} required error={error('price')} hint={t("Le prix d’une unité, hors TVA.")}><input name={name('price')} inputMode="decimal" value={line.price} maxLength={64} onChange={event => patchLine(line.id, { price: event.target.value })} /></Field>
                  <Field label={t("TVA")} required error={error('vatBp') || (!rates.includes(line.vatBp) ? t("Ce taux historique n’est plus disponible. Choisissez un taux de vos paramètres.") : undefined)}><select name={name('vatBp')} value={line.vatBp} onChange={event => patchLine(line.id, { vatBp: Number(event.target.value) })}>{[...new Set([...rates, line.vatBp])].map(rate => <option key={rate} value={rate}>{(rate / 100).toLocaleString(getAppLocale(), { maximumFractionDigits: 2 })} %{!rates.includes(rate) ? t(" · à vérifier") : ''}</option>)}</select></Field>
                </div>
                <details className="supplier-preparation__options"><summary>{t("Remise, catégorie et projet de cette ligne")}</summary><div className="form-grid">
                  <Field label={t("Remise (%)")} error={error('discount')} hint={t("Facultatif. Laissez zéro si aucune remise n’est indiquée.")}><input name={name('discount')} inputMode="decimal" value={line.discount} maxLength={64} onChange={event => patchLine(line.id, { discount: event.target.value })} /></Field>
                  <Field label={t("Catégorie")} required error={error('category')} hint={t("Pour classer cet achat dans vos coûts.")}><select name={name('category')} value={line.category} onChange={event => patchLine(line.id, { category: event.target.value })}><option value="">{t("Choisir")}</option>{[...new Set([...purchaseCostCategories(settings.work.costCategories), ...(line.category ? [line.category] : [])])].map(category => <option key={category} value={category}>{category}</option>)}</select></Field>
                  <Field label={t(terminology.singularTitle)} hint={t("Facultatif. À utiliser si cette ligne concerne un autre projet.")}><select name={name('projectId')} value={line.projectId} onChange={event => patchLine(line.id, { projectId: event.target.value })}><option value="">{t("Reprendre le document")}</option>{workspace.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
                </div></details>
                <footer><span>{t("Net")} {money(total?.netCents)} {t("· TVA")} {money(total?.vatCents)}</span>{fields.lines.length > 1 && <Button type="button" size="small" variant="ghost" onClick={() => { if (locked || cannotEdit || inFlight.current) return; setFields(previous => ({ ...previous, lines: previous.lines.filter(value => value.id !== line.id) })); setIssue(null); }}><Trash2 size={15} /> {t("Retirer cet achat")}</Button>}</footer>
              </article>;
            })}
          </div>
          <Button type="button" variant="secondary" disabled={locked || cannotEdit || fields.lines.length >= 250} onClick={() => { if (locked || cannotEdit || inFlight.current) return; setFields(previous => ({ ...previous, lines: [...previous.lines, newPurchaseLine(workspace)] })); }}><Plus size={15} /> {t("Ajouter une ligne")}</Button>
          {settings.organization.vatRegistered && <Field label={t("Traitement TVA de ces achats")} hint={t("Appliqué à toutes les lignes. Si leurs usages diffèrent, conservez le classement et vérifiez chaque ligne dans Comptabilité → TVA.")}><select name="vatTreatment" value={fields.vatTreatment} onChange={event => change('vatTreatment', event.target.value as PurchaseFields['vatTreatment'])}><option value="">{t("Conserver le classement / classer ensuite")}</option><option value="input_materials">{t("Marchandises et prestations professionnelles · TVA déductible (400)")}</option><option value="input_investments">{t("Investissements et autres charges · TVA déductible (405)")}</option><option value="non_deductible">{t("Sans droit à déduction / usage privé")}</option></select></Field>}
          {issue?.field === 'purchase-lines' && <p role="alert" className="field__error">{purchaseIssueText(issue)}</p>}
        </fieldset>}
        {step === 2 && <div className="supplier-preparation__review">
          <p>{t("Le total doit correspondre au document reçu. L’enregistrement garde un brouillon ; la validation et le paiement restent des actions séparées.")}</p>
          <dl><div><dt>{t("Fournisseur")}</dt><dd>{supplier?.name || t("À choisir")}</dd></div><div><dt>{t("Référence")}</dt><dd>{fields.reference || t("À compléter avant validation")}</dd></div><div><dt>{t("Date de facture")}</dt><dd>{date(fields.date)}</dd></div><div><dt>{t("Échéance")}</dt><dd>{date(fields.dueDate)}</dd></div><div><dt>{t(terminology.singularTitle)}</dt><dd>{workspace.projects.find(project => project.id === fields.projectId)?.name || t("Aucun")}</dd></div></dl>
          <Button type="button" variant="ghost" disabled={locked} onClick={() => go(0)}>{t("Corriger les informations")}</Button>
          <ul>{fields.lines.map(line => { const value = purchaseLineValue(line), total = value && supplierInvoiceLineTotals(value); return <li key={line.id}><div><strong>{line.description || t("À compléter")}</strong><small>{line.quantity} {line.unit} · {line.category}{line.discount && Number(line.discount.replace(',', '.')) > 0 ? t(" · remise {discount} %", { discount: line.discount }) : ''}</small></div><strong>{money(total?.totalCents)}</strong></li>; })}</ul>
          <Button type="button" variant="ghost" disabled={locked} onClick={() => go(1)}>{t("Corriger les achats")}</Button>
          <div className="supplier-invoice-total"><div><span>{t("Net")}</span><strong>{money(totals?.netCents)}</strong></div><div><span>{t("TVA")}</span><strong>{money(totals?.vatCents)}</strong></div><div><span>{t("Total TTC")}</span><strong>{money(totals?.totalCents)}</strong></div></div>
          {fields.vatTreatment && <p>{t("Classement TVA :")} {fields.vatTreatment === 'input_materials' ? t("marchandises et prestations professionnelles (400)") : fields.vatTreatment === 'input_investments' ? t("investissements et autres charges (405)") : t("sans droit à déduction / usage privé")}.</p>}
          {fields.note && <div className="supplier-preparation__note"><strong>{t("Note interne")}</strong><p>{fields.note}</p></div>}
        </div>}
        {step === 3 && <div>
          <div className="purchase-entry-saved" role="status"><CheckCircle2 size={19} /><div><strong>{t("Brouillon enregistré")}</strong><p>{t("Joignez le PDF ou une photo. Vous retrouverez ensuite cette facture dans les brouillons des achats pour la vérifier et la valider.")}</p></div></div>
          {renderAttachments(current, !readOnly && !finalized && !unavailable, locked, setAttachmentPending)}
          {scanFile&&<Button type="button" variant="secondary" disabled={locked||cannotEdit} onClick={()=>void save()}>Joindre {scanFile.name}</Button>}
          <p className="info-strip"><ReceiptText size={17} /> {t("Aucune écriture comptable ni aucun paiement n’a été créé par cet enregistrement.")}</p>
        </div>}
      </section>
      {serverError && <div ref={problem} tabIndex={-1}><ErrorPanel title={t("Vérifions la facture")} message={purchaseNativeMessage(serverError, "Le brouillon n’a pas pu être enregistré. Votre saisie est conservée.")} />{purchaseNativeMessage(serverError, "Le brouillon n’a pas pu être enregistré. Votre saisie est conservée.") !== serverError && <details><summary>{t("Voir le message détaillé")}</summary><p className="supplier-preparation__technical">{serverError}</p></details>}</div>}
      {leaving && <div ref={leavePanel} tabIndex={-1} role="alert" className="supplier-preparation__leave"><strong>{t("Garder vos modifications ?")}</strong><p>{t("Votre saisie n’est pas encore enregistrée. Restez ici pour la terminer.")}</p><div><Button type="button" disabled={locked} onClick={() => setLeaving(false)}>{t("Rester sur la facture")}</Button><Button type="button" variant="ghost" disabled={locked} onClick={() => { if (!locked && !inFlight.current) close(); }}>{t("Quitter sans enregistrer")}</Button></div></div>}
      <div className="supplier-preparation__actions">
        <Button type="button" variant="ghost" disabled={locked} onClick={requestClose}>{step === 3 ? t("Terminer") : t("Fermer")}</Button>
        {step > 0 && <Button type="button" variant="secondary" disabled={locked} onClick={() => go(step === 3 ? 0 : step - 1)}><ArrowLeft size={15} /> {step === 3 ? t("Modifier les informations") : t("Retour")}</Button>}
        {step < 2 && <Button type="submit" disabled={locked}>{step === 0 ? t("Continuer vers les achats") : t("Vérifier la facture")}</Button>}
        {step === 2 && <Button type="submit" disabled={locked || cannotEdit}>{saving ? t("Enregistrement…") : current ? t("Mettre à jour le brouillon") : t("Enregistrer le brouillon")}</Button>}
      </div>
    </form>
  </Modal>;
}
