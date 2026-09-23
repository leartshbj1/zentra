import { getAppLocale, t, useAppLanguage } from './language';
import { DocumentNumberInput } from './DocumentNumberInput';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  Check,
  Package,
  Plus,
  Receipt,
  Save,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { CustomerCreditPanel } from './CustomerCreditPanel';
import { activeCatalogItems, catalogItemToDocumentLine } from './catalog';
import type { DocumentLine, Invoice, Project, Quote, Workspace } from './types';
import {
  addDaysIso,
  createId,
  documentTotals,
  errorMessage,
  formatDate,
  formatMoney,
  invoicePaid,
  todayIso,
} from './utils';
import { Button, ErrorPanel, Field, FormActions, Modal, submitForm } from './ui';
import { projectTerminology } from './terminology';
import {
  buildDepositLines,
  restoreDepositBaseLines,
  validDepositPercentageBp,
} from './deposit';
import {
  DOCUMENT_CATALOG_RESULT_LIMIT,
  documentLinesValidationError,
  documentLineIssue,
  documentVatRateFromInput,
  prepareDocumentQuickClient,
  salesDocumentDateError,
  searchableDocumentCatalogItems,
  upsertDocumentFooterTemplate,
} from './documentUi';

type ActionRunner = (
  action: () => Promise<Workspace>,
  message: string,
  close?: boolean,
  onError?: (reason: unknown) => void,
) => Promise<boolean>;

export function DocumentEditor({
  entity,
  item,
  quoteSource,
  initialProject,
  initialStep = 0,
  workspace,
  busy,
  readOnlyReason,
  readOnly = false,
  close,
  act,
  onReadWorkspace = async()=>{throw Error(t("Fermez et rouvrez ce document pour actualiser les règlements."));},
  onOpenSettlementHelp = ()=>{},
}: {
  entity: 'quotes' | 'invoices';
  item?: Quote | Invoice;
  quoteSource?: Quote;
  initialProject?: Project;
  initialStep?: 0 | 1 | 2 | 3;
  workspace: Workspace;
  busy: boolean;
  readOnlyReason?: string;
  readOnly?: boolean;
  close: () => void;
  act: ActionRunner;
  onReadWorkspace?:()=>Promise<Workspace>;
  onOpenSettlementHelp?:(destination:'accounts'|'periods'|'bank')=>void;
}) {
  useAppLanguage();
  const settings = workspace.settings!;
  const unitsId = useId();
  const terminology = projectTerminology(settings.business.nogaSection);
  const current = item ?? quoteSource;
  const currentInvoice = entity === 'invoices' ? (item as Invoice | undefined) : undefined;
  const hasCustomerCredit = Boolean(currentInvoice && currentInvoice.status !== 'draft' && workspace.invoices.some((invoice)=>invoice.customerCredit && (invoice.id===currentInvoice.id || invoice.originalInvoiceId===currentInvoice.id || invoice.creditSettlements?.some((event)=>event.invoiceId===currentInvoice.id))));
  const savedDepositPercentageBp = currentInvoice?.depositPercentageBp ?? null;
  const [lines, setLines] = useState<DocumentLine[]>(
    currentInvoice?.type === 'deposit' && savedDepositPercentageBp
      ? (
          currentInvoice.depositBasisLines?.length
            ? currentInvoice.depositBasisLines
            : restoreDepositBaseLines(currentInvoice.lines, savedDepositPercentageBp)
        ).map((line) => ({ ...line }))
      : current?.lines.map((line) => ({ ...line })) ?? [
      {
        id: createId(),
        catalogItemId: null,
        description: '',
        quantity: 0,
        unit: '',
        unitPriceCents: 0,
        discountBp: 0,
        vatRateBp: settings.organization.vatRegistered ? -1 : 0,
      },
    ],
  );
  const [savedLineIds] = useState(() => new Set(current ? lines.map(line => line.id) : []));
  const catalogItems = useMemo(
    () => activeCatalogItems(workspace.catalogItems),
    [workspace.catalogItems],
  );
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogItemId, setCatalogItemId] = useState('');
  const visibleCatalogItems = useMemo(
    () => searchableDocumentCatalogItems(catalogItems, catalogQuery),
    [catalogItems, catalogQuery],
  );
  const [selectedClientId, setSelectedClientId] = useState(
    item?.clientId ?? quoteSource?.clientId ?? initialProject?.clientId ?? '',
  );
  const [selectedProjectId, setSelectedProjectId] = useState(item?.projectId ?? quoteSource?.projectId ?? initialProject?.id ?? '');
  const [quickClientOpen, setQuickClientOpen] = useState(false);
  const [quickClient, setQuickClient] = useState({
    contactPerson: '',
    company: '',
    email: '',
    phone: '',
    street: '',
    buildingNumber: '',
    postalCode: '',
    city: '',
    canton: '',
    country: 'CH',
  });
  const [issueDate, setIssueDate] = useState(item?.issueDate || todayIso());
  const [dueDate, setDueDate] = useState(
    entity === 'quotes'
      ? (item as Quote | undefined)?.validUntil ||
          addDaysIso(issueDate, settings.billing.quoteValidityDays)
      : (item as Invoice | undefined)?.dueDate ||
          addDaysIso(issueDate, settings.billing.paymentTermsDays),
  );
  const [invoiceType, setInvoiceType] = useState<Invoice['type'] | ''>(
    entity === 'invoices' ? ((item as Invoice | undefined)?.type ?? '') : '',
  );
  const [depositPercentage, setDepositPercentage] = useState(
    savedDepositPercentageBp
      ? String(savedDepositPercentageBp / 100)
      : currentInvoice?.type === 'deposit'
        ? '100'
        : '30',
  );
  const [serviceDateFrom, setServiceDateFrom] = useState(
    (item as Invoice | undefined)?.serviceDateFrom ?? '',
  );
  const [serviceDateTo, setServiceDateTo] = useState(
    (item as Invoice | undefined)?.serviceDateTo ?? '',
  );
  const [originalInvoiceId, setOriginalInvoiceId] = useState(
    (item as Invoice | undefined)?.originalInvoiceId ?? '',
  );
  const creditOriginal = invoiceType === 'credit_note' ? workspace.invoices.find((invoice) => invoice.id === originalInvoiceId) : undefined;
  const documentVatRates = creditOriginal
    ? [...new Set(creditOriginal.lines.map((line) => line.vatRateBp))].filter((rate) => rate >= 0).sort((a, b) => a - b)
    : [...new Set([0, ...settings.billing.vatRatesBp])];
  const currency = creditOriginal?.currency || current?.currency || settings.billing.currency || 'CHF';
  const [footerText, setFooterText] = useState(
    item?.terms ?? quoteSource?.terms ?? settings.billing.defaultFooter,
  );
  const [footerTemplateId, setFooterTemplateId] = useState('');
  const [footerTemplateName, setFooterTemplateName] = useState('');
  const [localError, setLocalError] = useState('');
  const [numberErrors, setNumberErrors] = useState<Record<string, string>>({});
  const numberValidity = useCallback((id: string, error: string) => {
    setNumberErrors(previous => { if ((previous[id] || '') === error) return previous; const next = { ...previous }; if (error) next[id] = error; else delete next[id]; return next; });
  }, []);
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [step, setStep] = useState<number>(initialStep);
  const [documentTitle, setDocumentTitle] = useState(current?.title ?? '');
  const [documentNotes, setDocumentNotes] = useState(current?.notes ?? '');
  const formRef = useRef<HTMLFormElement>(null);
  const pendingFocus = useRef<HTMLElement | null>(null);
  const previousStep = useRef(step);
  const depositPercentageBp = Math.round(
    Number(depositPercentage.replace(',', '.')) * 100,
  );
  const depositLines =
    invoiceType === 'deposit' && validDepositPercentageBp(depositPercentageBp)
      ? buildDepositLines(lines, depositPercentageBp)
      : lines;
  const baseTotals = documentTotals(lines);
  const totals = documentTotals(depositLines);
  const totalsReady = !Object.keys(numberErrors).length && !documentLinesValidationError(lines);
  const isLocked = Boolean(
    item && (item.status !== 'draft' || readOnlyReason),
  );
  const originalInvoices = workspace.invoices.filter(
    (invoice) =>
      invoice.id !== item?.id &&
      invoice.type !== 'credit_note' &&
      invoice.status !== 'draft' &&
      invoice.status !== 'cancelled',
  );
  const documentLabel =
    entity === 'quotes'
      ? t('devis')
      : invoiceType === 'credit_note'
        ? t('avoir')
        : invoiceType === 'deposit'
          ? t('facture d’acompte')
          : t('facture');

  const steps = [t("Client"), t("Prestations"), t("Conditions"), t("Vérification")];
  const stepDescriptions = [t("Destinataire et projet"), t("Lignes et montants"), t("Dates et message"), t("Relecture du document")];
  const stepTitles = [t("Pour qui préparez-vous ce document ?"), t("Qu’allez-vous réaliser ?"), t("Les derniers détails."), t("Tout est prêt ?")];
  const stepHints = [t("Choisissez votre client et retrouvez tous ses documents dans le même projet."), t("Ajoutez vos prestations ou retrouvez-les dans votre catalogue."), t("Précisez les dates et le message qui accompagnera votre document."), t("Relisez votre document. Vous pourrez encore le modifier avant de l’émettre.")];

  useEffect(() => {
    const changed = previousStep.current !== step;
    previousStep.current = step;
    if (!changed && !pendingFocus.current) return;
    // Wait until the error banner has its final height before positioning the field.
    const frame = requestAnimationFrame(() => {
      const panel = formRef.current?.querySelector<HTMLElement>(`[data-document-step="${step}"]`);
      const scroller = formRef.current?.querySelector('.document-form');
      if (changed && scroller) scroller.scrollTop = 0;
      (pendingFocus.current || panel?.querySelector<HTMLElement>('h3'))?.focus({ preventScroll: true });
      pendingFocus.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
      pendingFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [step, saveAttempt]);

  function showStepError(index: number, message: string, field?: HTMLElement) {
    pendingFocus.current = field || null;
    setLocalError(message);
    setSaveAttempt((attempt) => attempt + 1);
    if (step !== index) setStep(index);
    return false;
  }

  function validateStep(index: number) {
    const fields = formRef.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-document-step="${index}"] input, [data-document-step="${index}"] select, [data-document-step="${index}"] textarea`);
    const invalid = [...(fields || [])].find((field) => !field.checkValidity());
    if (invalid) {
      const row = invalid.closest<HTMLElement>('[data-line-number]');
      const label = invalid.getAttribute('aria-label') || invalid.labels?.[0]?.querySelector('.field__label')?.firstChild?.textContent?.trim() || invalid.labels?.[0]?.textContent?.trim().split('\n')[0] || t("ce champ");
      const message = invalid.validity.customError ? invalid.validationMessage : invalid.validity.valueMissing ? t('Complétez « {field} » pour continuer.', {field: label.replace(/\s*\*$/, '')}) : t('Vérifiez « {field} » : la valeur saisie n’est pas valide.', {field: label});
      return showStepError(index, row ? t('Ligne {number} : {message}', {number: row.dataset.lineNumber || '', message}) : message, invalid);
    }
    if (index === 0 && quickClientOpen) return showStepError(0, t("Ajoutez le nouveau contact ou fermez sa fiche pour continuer."));
    if (index === 0 && !documentTitle.trim()) return showStepError(0, t("Donnez un titre à votre document."), formRef.current?.querySelector<HTMLInputElement>('[name="title"]') || undefined);
    if (index === 1) {
      const issue = documentLineIssue(lines);
      if (issue) return showStepError(1, issue.message, formRef.current?.querySelector<HTMLElement>(`[data-line-number="${issue.index + 1}"] [aria-label="${t(issue.field)}"]`) || undefined);
      const invalidVat = settings.organization.vatRegistered ? lines.findIndex(line => !documentVatRates.includes(line.vatRateBp)) : -1;
      if (invalidVat >= 0) return showStepError(1, `Ligne ${invalidVat + 1} : choisissez un taux de TVA disponible pour ce document.`, formRef.current?.querySelector<HTMLElement>(`[data-line-number="${invalidVat + 1}"] [aria-label="Taux TVA"]`) || undefined);
    }
    if (index === 2) {
      const error = entity === 'quotes' || invoiceType !== 'credit_note' ? salesDocumentDateError(entity, issueDate, dueDate) : '';
      if (error) return showStepError(2, t(error));
      if (entity === 'invoices' && (!serviceDateFrom || !serviceDateTo || serviceDateFrom > serviceDateTo)) return showStepError(2, t("Choisissez une période de prestation valide."));
      if (creditOriginal?.issueDate && issueDate < creditOriginal.issueDate) return showStepError(2, t("La date de l’avoir ne peut pas précéder celle de la facture originale."));
      if (invoiceType === 'deposit' && !validDepositPercentageBp(depositPercentageBp)) return showStepError(2, t("Saisissez un acompte compris entre 0,01 et 100 %."));
    }
    return true;
  }

  function goToStep(next: number) {
    if (busy) return;
    if (next > step) {
      for (let index = step; index < next; index += 1) if (!validateStep(index)) return;
    }
    setLocalError('');
    setStep(next);
  }

  function stepHeading(index: number) {
    return isLocked ? null : <header className="document-step__heading"><span className="eyebrow">{String(index + 1).padStart(2, '0')} / 04 · {steps[index]}</span><h3 tabIndex={-1}>{stepTitles[index]}</h3><p>{stepHints[index]}</p></header>;
  }

  function updateLine(id: string, patch: Partial<DocumentLine>) {
    setLines((currentLines) =>
      currentLines.map((line) =>
        line.id === id ? { ...line, ...patch } : line,
      ),
    );
  }

  function addCatalogItem() {
    if (currency !== 'CHF') return;
    const catalogItem = catalogItems.find(
      (candidate) => candidate.id === catalogItemId,
    );
    if (!catalogItem) return;
    setLines((currentLines) => {
      const catalogLine = catalogItemToDocumentLine(catalogItem);
      const replaceEmpty =
        currentLines.length === 1 &&
        !currentLines[0].description.trim() &&
        currentLines[0].quantity === 0;
      return replaceEmpty ? [catalogLine] : [...currentLines, catalogLine];
    });
    setCatalogItemId('');
  }

  async function createQuickClient() {
    setLocalError('');
    const id = createId();
    let client: ReturnType<typeof prepareDocumentQuickClient>;
    try {
      client = prepareDocumentQuickClient(quickClient, id);
    } catch (reason) {
      setLocalError(
        reason instanceof Error
          ? reason.message
          : t("Le nouveau client n’a pas pu être préparé."),
      );
      return;
    }
    const saved = await act(
      () => desktopApi.createEntity('clients', client),
      t('Le client {client} a été ajouté et sélectionné.', {client: client.company || client.contactPerson}),
      false,
    );
    if (!saved) return;
    setSelectedClientId(id);
    setSelectedProjectId('');
    setQuickClientOpen(false);
    setQuickClient({
      contactPerson: '',
      company: '',
      email: '',
      phone: '',
      street: '',
      buildingNumber: '',
      postalCode: '',
      city: '',
      canton: '',
      country: 'CH',
    });
  }

  async function saveFooterTemplate() {
    setLocalError('');
    const name = footerTemplateName.trim();
    const text = footerText.trim();
    if (!name || !text) {
      setLocalError(
        t("Saisissez un nom de modèle et un texte de bas de page avant de l’enregistrer."),
      );
      return;
    }
    let update: ReturnType<typeof upsertDocumentFooterTemplate>;
    try {
      update = upsertDocumentFooterTemplate(
        settings.billing.footerTemplates,
        footerTemplateId,
        name,
        text,
        createId,
      );
    } catch (reason) {
      setLocalError(
        reason instanceof Error
          ? reason.message
          : t("Le modèle de bas de page n’a pas pu être préparé."),
      );
      return;
    }
    const existing = settings.billing.footerTemplates.some(
      (template) => template.id === update.id,
    );
    const saved = await act(
      () =>
        desktopApi.saveSettings({
          ...settings,
          billing: { ...settings.billing, footerTemplates: update.templates },
        }),
      existing
        ? t('Le modèle « {name} » a été mis à jour.', {name: update.name})
        : t('Le modèle « {name} » a été enregistré.', {name: update.name}),
      false,
    );
    if (saved) {
      setFooterTemplateId(update.id);
      setFooterTemplateName(update.name);
    }
  }

  async function deleteFooterTemplate() {
    if (!footerTemplateId) return;
    const template = settings.billing.footerTemplates.find(
      (candidate) => candidate.id === footerTemplateId,
    );
    if (!template) return;
    const saved = await act(
      () =>
        desktopApi.saveSettings({
          ...settings,
          billing: {
            ...settings.billing,
            footerTemplates: settings.billing.footerTemplates.filter(
              (candidate) => candidate.id !== template.id,
            ),
          },
        }),
      t('Le modèle « {name} » a été supprimé.', {name: template.name}),
      false,
    );
    if (saved) {
      setFooterTemplateId('');
      setFooterTemplateName('');
    }
  }

  return (
    <Modal
      title={entity === 'quotes'
        ? item ? isLocked ? t('Consulter le devis') : t('Modifier le devis') : t('Nouveau devis')
        : invoiceType === 'credit_note'
          ? item ? isLocked ? t('Consulter l’avoir') : t('Modifier l’avoir') : t('Nouvel avoir')
          : item ? isLocked ? t('Consulter la facture') : t('Modifier la facture') : t('Nouvelle facture')}
      description={
        readOnlyReason
          ? readOnlyReason
          : isLocked
          ? t("Le document émis est verrouillé et ne peut pas être supprimé.")
          : t("Un document clair, en quatre étapes.")
      }
      onClose={close}
      dismissible={!busy}
      className={!isLocked ? "document-editor-dialog" : undefined}
      wide
    >
      {currentInvoice && currentInvoice.status !== 'draft' && <CustomerCreditPanel invoice={currentInvoice} workspace={workspace} busy={busy} readOnly={readOnly} act={act} onReadWorkspace={onReadWorkspace} onOpenHelp={onOpenSettlementHelp}/>}
      <CreditDocumentDetails collapse={hasCustomerCredit}>
      <form
        ref={formRef}
        className={!isLocked ? 'document-assistant' : undefined}
        noValidate={!isLocked}
        onChange={() => { if (localError) setLocalError(''); }}
        onSubmit={submitForm(async (form) => {
          if (busy || isLocked || readOnly) return;
          if (step < 3) { goToStep(step + 1); return; }
          for (let index = 0; index < 3; index += 1) if (!validateStep(index)) return;
          setSaveAttempt((attempt) => attempt + 1);
          setLocalError('');
          const lineError = documentLinesValidationError(lines);
          if (lineError) {
            setLocalError(lineError);
            return;
          }
          if (
            entity === 'invoices' &&
            (!invoiceType ||
              !serviceDateFrom ||
              !serviceDateTo ||
              serviceDateFrom > serviceDateTo)
          ) {
            setLocalError(
              t("Choisissez le type et une période de prestation valide avant l’enregistrement."),
            );
            return;
          }
          const dateError =
            entity === 'quotes' || invoiceType !== 'credit_note'
              ? salesDocumentDateError(entity, issueDate, dueDate)
              : '';
          if (dateError) {
            setLocalError(dateError);
            return;
          }
          if (invoiceType === 'credit_note' && !originalInvoiceId) {
            setLocalError(
              t("Un avoir doit référencer explicitement la facture originale."),
            );
            return;
          }
          if (creditOriginal?.issueDate && issueDate < creditOriginal.issueDate) {
            setLocalError(t("La date de l’avoir ne peut pas précéder celle de la facture originale."));
            return;
          }
          if (
            entity === 'invoices' &&
            invoiceType === 'deposit' &&
            !validDepositPercentageBp(depositPercentageBp)
          ) {
            setLocalError(
              t("Saisissez un acompte compris entre 0,01 et 100 % avant l’enregistrement."),
            );
            return;
          }
          const data: Record<string, unknown> = {
            clientId: creditOriginal?.clientId || selectedClientId,
            projectId: creditOriginal ? creditOriginal.projectId : selectedProjectId || null,
            title: String(form.get('title')),
            status: item?.status ?? 'draft',
            issueDate,
            currency,
            subtotalCents: totals.subtotalCents,
            discountCents: totals.discountCents,
            vatCents: totals.vatCents,
            totalCents: totals.totalCents,
            notes: String(form.get('notes')),
            terms: footerText,
          };
          if (entity === 'quotes') data.validUntil = dueDate;
          else {
            data.dueDate = invoiceType === 'credit_note' ? '' : dueDate;
            data.type = invoiceType;
            data.quoteId =
              quoteSource?.id ?? (item as Invoice | undefined)?.quoteId ?? null;
            data.originalInvoiceId =
              invoiceType === 'credit_note' ? originalInvoiceId : null;
            data.serviceDateFrom = serviceDateFrom;
            data.serviceDateTo = serviceDateTo;
            data.paidCents = item
              ? invoicePaid(item.id, workspace.payments)
              : 0;
            data.depositPercentageBp =
              invoiceType === 'deposit' ? depositPercentageBp : null;
            data.depositBasisLines = invoiceType === 'deposit' ? lines : null;
          }
          await act(
            () => desktopApi.saveDocument(entity, data, depositLines, item),
            item
              ? t("Le brouillon a été mis à jour.")
              : entity === 'quotes' ? t('Le devis a été enregistré en brouillon.') : invoiceType === 'credit_note' ? t('L’avoir a été enregistré en brouillon.') : t('La facture a été enregistrée en brouillon.'),
            true,
            reason => setLocalError(errorMessage(reason, t("Le document n’a pas pu être enregistré. Votre saisie est conservée."))),
          );
        })}
      >
        {!isLocked && <nav className="document-stepper" aria-label={t("Étapes de création")}>
          <div className="document-stepper__intro"><span>{t("Votre document")}</span><strong>{documentTitle.trim() || (entity === 'quotes' ? t("Nouveau devis") : invoiceType === 'credit_note' ? t("Nouvel avoir") : t("Nouvelle facture"))}</strong></div>
          <ol>{steps.map((label, index) => <li key={label}><button type="button" aria-label={`${index + 1}. ${label}`} aria-current={step === index ? 'step' : undefined} disabled={busy} onClick={() => goToStep(index)}><span className="document-stepper__number" aria-hidden="true">{index < step ? <Check size={14} /> : index + 1}</span><span className="document-stepper__label"><strong>{label}</strong><small>{stepDescriptions[index]}</small></span></button></li>)}</ol>
          <div className="document-stepper__track"><span style={{ transform: `scaleX(${(step + 1) / 4})` }} /></div>
          <p className="document-stepper__note">{t("Vous pourrez modifier le brouillon avant de l’émettre.")}</p>
        </nav>}
        {localError ? <ErrorPanel key={saveAttempt} title={t("Encore un détail")} message={localError} reveal /> : null}
        <fieldset disabled={busy || isLocked} className="document-form">
          <section className="document-step" data-document-step="0" hidden={!isLocked && step !== 0}>
            {stepHeading(0)}
          <div className="form-grid">
            <Field label={t("Titre du document")} required wide>
              <input
                name="title"
                placeholder={t("Ex. Aménagement du séjour")}
                value={documentTitle}
                onChange={(event) => setDocumentTitle(event.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label={t("Client")} required>
              <div className="document-client-picker">
                <select
                  name="clientId"
                  value={selectedClientId}
                  disabled={Boolean(creditOriginal)}
                  onChange={(event) => {
                    setSelectedClientId(event.target.value);
                    setSelectedProjectId('');
                  }}
                  required
                >
                  <option value="">{t("Choisir un client")}</option>
                  {workspace.clients
                    .filter(
                      (client) =>
                        !client.archivedAt ||
                        client.id === item?.clientId ||
                        client.id === quoteSource?.clientId ||
                        client.id === creditOriginal?.clientId,
                    )
                    .map((client) => (
                      <option value={client.id} key={client.id}>
                        {client.company || client.name}
                        {client.archivedAt ? t(" · archivé") : ''}
                      </option>
                    ))}
                </select>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={Boolean(creditOriginal)}
                  onClick={() => setQuickClientOpen((open) => !open)}
                  aria-expanded={quickClientOpen}
                >
                  {quickClientOpen ? <X size={14} /> : <UserPlus size={14} />}
                  {quickClientOpen ? t("Fermer") : t("Nouveau contact")}
                </Button>
              </div>
            </Field>
            <Field label={t(terminology.singularTitle)}>
              <select
                name="projectId"
                value={selectedProjectId}
                disabled={Boolean(creditOriginal)}
                onChange={(event) => setSelectedProjectId(event.target.value)}
              >
                <option value="">{t('Aucun projet lié')}</option>
                {workspace.projects.filter((project) => project.clientId === selectedClientId).map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
            {entity === 'invoices' ? (
              <Field label={t("Type de document")} required>
                <select
                  value={invoiceType}
                  onChange={(event) => {
                    setInvoiceType(event.target.value as Invoice['type'] | '');
                    if (event.target.value !== 'credit_note')
                      setOriginalInvoiceId('');
                  }}
                  required
                >
                  <option value="">{t("Choisir le type")}</option>
                  <option value="standard">{t("Facture standard")}</option>
                  <option value="deposit">{t("Facture d’acompte")}</option>
                  <option value="progress">{t("Facture de situation")}</option>
                  <option value="final">{t("Facture finale")}</option>
                  <option value="credit_note">{t("Avoir")}</option>
                </select>
              </Field>
            ) : null}
            <Field label={t("Devise")}><input value={currency} readOnly /></Field>
            {invoiceType === 'credit_note' ? (
              <Field label={t("Facture originale")} required wide>
                <select
                  value={originalInvoiceId}
                  onChange={(event) => {
                    setOriginalInvoiceId(event.target.value);
                    const original = workspace.invoices.find((invoice) => invoice.id === event.target.value);
                    if (original) {
                      setSelectedClientId(original.clientId);
                      setSelectedProjectId(original.projectId || '');
                      setQuickClientOpen(false);
                    }
                  }}
                  required
                >
                  <option value="">{t("Choisir la facture à corriger")}</option>
                  {originalInvoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.number} · {invoice.title}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
          {quickClientOpen ? (
            <section className="document-inline-card" aria-label={t("Ajouter un nouveau client")}>
              <header>
                <div>
                  <strong>{t("Nouveau client")}</strong>
                  <small>{t("Renseignez l’entreprise ou le nom du contact. Il sera enregistré puis sélectionné sans fermer le document.")}</small>
                </div>
              </header>
              <div className="form-grid">
                {([
                  ['contactPerson', t("Nom du contact"), false],
                  ['company', t("Entreprise"), false],
                  ['email', t("E-mail"), false],
                  ['phone', t("Téléphone"), false],
                  ['street', t("Rue / case postale"), true],
                  ['buildingNumber', t("Numéro"), false],
                  ['postalCode', t("NPA"), true],
                  ['city', t("Localité"), true],
                  ['canton', t("Canton"), false],
                  ['country', t("Pays (ISO)"), true],
                ] as const).map(([key, label, required]) => (
                  <Field key={String(key)} label={String(label)} required={Boolean(required)}>
                    <input
                      type={key === 'email' ? 'email' : 'text'}
                      value={quickClient[key as keyof typeof quickClient]}
                      maxLength={key === 'country' ? 2 : undefined}
                      onChange={(event) =>
                        setQuickClient((currentClient) => ({
                          ...currentClient,
                          [key]: event.target.value,
                        }))
                      }
                      required={Boolean(required)}
                    />
                  </Field>
                ))}
              </div>
              <div className="document-inline-card__actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void createQuickClient()}
                >
                  <Check size={15} />{t("Ajouter et sélectionner")}</Button>
              </div>
            </section>
          ) : null}
          {invoiceType === 'credit_note' ? (
            <div className="info-strip">
              <Receipt size={17} />
              <span>{t("L’avoir est lié à la facture originale, numéroté sur sa propre séquence et comptabilisé en montants négatifs à l’émission. Reprenez ses taux de TVA et ses montants encore créditables. Aucun encaissement n’est possible.")}</span>
            </div>
          ) : null}
          </section>
          <section className="document-step" data-document-step="1" hidden={!isLocked && step !== 1}>
            {stepHeading(1)}
          <section className="line-editor">
            <datalist id={unitsId}>{['h', 'jour', 'pièce', 'forfait', 'm', 'm²', 'm³', 'kg'].map(unit => <option key={unit} value={unit} />)}</datalist>
            <header>
              <details className="line-editor__guidance">
                <summary>{invoiceType === 'deposit' ? t("Base de calcul de l’acompte") : t("Lignes du document")}</summary>
                <small className={currency !== 'CHF' ? 'document-currency-hint' : undefined}>
                  {currency === 'CHF' ? (catalogItems.length ? t("Retrouvez une prestation du catalogue ou ajoutez une ligne libre.") : t("Décrivez vos prestations, leur quantité et leur prix.")) : t('Saisissez les prix en {currency}. Les prix du catalogue sont en CHF et ne sont pas convertis automatiquement.', {currency})}
                </small>
                <small>{settings.organization.vatRegistered ? t("Prix hors TVA. ") : ''}{t("Virgule ou point acceptés. Saisissez 0 pour une prestation offerte.")}</small>
              </details>
              <div className="line-editor__actions">
                {catalogItems.length > 0 && <details className="line-editor__catalog"><summary>{t("Ajouter depuis le catalogue")}</summary><div className="catalog-line-picker">
                  <Package size={15} />
                  <input
                    type="search"
                    value={catalogQuery}
                    onChange={(event) => {
                      setCatalogQuery(event.target.value);
                      setCatalogItemId('');
                    }}
                    placeholder={t("Référence ou désignation")}
                    aria-label={t("Rechercher une référence du catalogue")}
                    disabled={!catalogItems.length || currency !== 'CHF'}
                  />
                  <select
                    value={catalogItemId}
                    onChange={(event) => setCatalogItemId(event.target.value)}
                    aria-label={t("Référence du catalogue à ajouter")}
                    disabled={!catalogItems.length || currency !== 'CHF'}
                  >
                    <option value="">
                      {!catalogItems.length
                        ? t("Catalogue vide")
                        : visibleCatalogItems.length
                          ? t("Choisir une référence")
                          : t("Aucune référence trouvée")}
                    </option>
                    {visibleCatalogItems.map((catalogItem) => (
                      <option key={catalogItem.id} value={catalogItem.id}>
                        {catalogItem.sku ? `${catalogItem.sku} · ` : ''}
                        {catalogItem.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    disabled={!catalogItemId || currency !== 'CHF'}
                    onClick={addCatalogItem}
                  >{t("Ajouter depuis le catalogue")}</Button>
                  {catalogItems.length > DOCUMENT_CATALOG_RESULT_LIMIT && !catalogQuery.trim() ? (
                    <small className="catalog-line-picker__hint">
                      {t('Recherchez pour parcourir les {count} références.', {count: catalogItems.length})}
                    </small>
                  ) : null}
                </div></details>}
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  onClick={() =>
                    setLines((currentLines) => [
                      ...currentLines,
                      {
                        id: createId(),
                        catalogItemId: null,
                        description: '',
                        quantity: 0,
                        unit: '',
                        unitPriceCents: 0,
                        discountBp: 0,
                        vatRateBp: settings.organization.vatRegistered ? -1 : 0,
                      },
                    ])
                  }
                >
                  <Plus size={15} />{t("Ligne libre")}</Button>
              </div>
            </header>
            <div className="line-editor__head">
              <span>{t("Description")}</span>
              <span>{t("Quantité")}</span>
              <span>{t("Unité")}</span>
              <span>{t("Prix unitaire")}</span>
              <span>{t("Remise")}</span>
              <span>{t("TVA")}</span>
              <span />
            </div>
            {lines.map((line, index) => (
              <div className="line-editor__row" key={line.id} role="group" aria-label={t('Prestation {number}', {number: index + 1})} data-line-number={index + 1}>
                <label className="document-line-field" data-label={t("Description")}>
                <input
                  value={line.description}
                  onChange={(event) =>
                    updateLine(line.id, { description: event.target.value })
                  }
                  aria-label={t("Description")}
                  required
                />
                </label>
                <label className="document-line-field" data-label={t("Quantité")}>
                  <DocumentNumberInput id={`${line.id}-quantity`} kind="quantity" label={t("Quantité")} value={line.quantity} startEmpty={line.quantity === 0 && !savedLineIds.has(line.id)} onChange={quantity => updateLine(line.id, { quantity })} onValidityChange={numberValidity} />
                </label>
                <label className="document-line-field" data-label={t("Unité")}>
                <input
                  value={line.unit}
                  list={unitsId}
                  placeholder={t("h, pièce, forfait…")}
                  onChange={(event) =>
                    updateLine(line.id, { unit: event.target.value })
                  }
                  aria-label={t("Unité")}
                  required
                />
                </label>
                <label className="money-input" data-label={t("Prix unitaire")}>
                  <DocumentNumberInput id={`${line.id}-price`} kind="price" label={t("Prix unitaire")} value={line.unitPriceCents} startEmpty={!line.catalogItemId && !savedLineIds.has(line.id)} onChange={unitPriceCents => updateLine(line.id, { unitPriceCents })} onValidityChange={numberValidity} />
                  <span>{currency}</span>
                </label>
                <label className="percent-input" data-label={t("Remise")}>
                  <DocumentNumberInput id={`${line.id}-discount`} kind="discount" label={t("Remise en pour cent")} value={line.discountBp ?? 0} onChange={discountBp => updateLine(line.id, { discountBp })} onValidityChange={numberValidity} />
                  <span>%</span>
                </label>
                {settings.organization.vatRegistered ? (
                  <label className="document-line-field" data-label={t("TVA")}>
                  <select
                    value={line.vatRateBp < 0 ? '' : line.vatRateBp}
                    onChange={(event) =>
                      updateLine(line.id, {
                        vatRateBp: documentVatRateFromInput(event.target.value),
                      })
                    }
                    aria-label={t("Taux TVA")}
                    required
                  >
                    <option value="">{t("Choisir")}</option>
                    {line.vatRateBp >= 0 && !documentVatRates.includes(line.vatRateBp) ? (
                      <option value={line.vatRateBp} disabled>
                        {(line.vatRateBp / 100).toLocaleString(getAppLocale())} {t("% · Taux à corriger")}</option>
                    ) : null}
                    {documentVatRates
                      .map((rate) => (
                        <option value={rate} key={rate}>
                          {rate === 0 ? t('0 % · Hors TVA / taux 0') : `${(rate / 100).toLocaleString(getAppLocale())} %`}
                        </option>
                      ))}
                  </select>
                  </label>
                ) : (
                  <span className="no-vat">{t("Sans TVA")}</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setLines((currentLines) =>
                      currentLines.filter(
                        (candidate) => candidate.id !== line.id,
                      ),
                    )
                  }
                  disabled={lines.length === 1}
                  aria-label={t("Supprimer la ligne")}
                >
                  <Archive size={15} />
                </Button>
              </div>
            ))}
          </section>
          </section>
          <section className="document-step" data-document-step="2" hidden={!isLocked && step !== 2}>
            {stepHeading(2)}
          <div className="form-grid">
            <Field label={t("Date d’émission")} required>
              <input
                type="date"
                value={issueDate}
                min={creditOriginal?.issueDate || undefined}
                onChange={(event) => {
                  setIssueDate(event.target.value);
                  if (!item)
                    setDueDate(
                      addDaysIso(
                        event.target.value,
                        entity === 'quotes'
                          ? settings.billing.quoteValidityDays
                          : settings.billing.paymentTermsDays,
                      ),
                    );
                }}
                required
              />
            </Field>
            {entity === 'quotes' || invoiceType !== 'credit_note' ? (
              <Field
                label={entity === 'quotes' ? t("Valable jusqu’au") : t("Échéance")}
                required
              >
                <input
                  type="date"
                  min={issueDate}
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  required
                />
              </Field>
            ) : null}
            {entity === 'invoices' ? (
              <>
                <Field label={t("Début de la prestation")} required hint={t("Pour une journée, la même date est proposée en fin. Modifiez-la si la prestation dure plus longtemps.")}>
                  <input
                    type="date"
                    value={serviceDateFrom}
                    onChange={(event) => { const next = event.target.value; setServiceDateFrom(next); if (!serviceDateTo || serviceDateTo === serviceDateFrom) setServiceDateTo(next); }}
                    required
                  />
                </Field>
                <Field label={t("Fin de la prestation")} required>
                  <input
                    type="date"
                    min={serviceDateFrom}
                    value={serviceDateTo}
                    onChange={(event) => setServiceDateTo(event.target.value)}
                    required
                  />
                </Field>
              </>
            ) : null}
          </div>
          {invoiceType === 'deposit' ? (
            <section className="deposit-builder" aria-label={t("Calcul de l’acompte")}>
              <div className="deposit-builder__copy">
                <strong>{t("Calculer l’acompte sur vos prestations")}</strong>
                <small>{t("Saisissez la base complète. Zentra facture uniquement le pourcentage indiqué, par taux de TVA, sans déclencher de sortie de stock.")}</small>
              </div>
              <Field label={t("Pourcentage de l’acompte")} required>
                <label className="percent-input">
                  <DocumentNumberInput id="deposit-percentage" kind="deposit" label={t("Pourcentage de l’acompte")} value={depositPercentageBp} onChange={value => setDepositPercentage(String(value / 100))} onValidityChange={numberValidity} />
                  <span>%</span>
                </label>
              </Field>
              <div className="deposit-builder__summary" aria-live="polite">
                <span>{t("Base TTC")} <strong>{formatMoney(baseTotals.totalCents, currency)}</strong></span>
                <span>{t("Acompte TTC")} <strong>{totalsReady ? formatMoney(totals.totalCents, currency) : t("À compléter")}</strong></span>
              </div>
            </section>
          ) : null}
          <div className="document-bottom">
            <div className="document-copy-fields">
              <Field label={t("Notes / texte complémentaire")} hint={t("Entrée ajoute une nouvelle ligne. Les paragraphes sont conservés dans l’aperçu et le PDF.")}>
                <textarea
                  name="notes"
                  rows={4}
                  value={documentNotes}
                  onChange={(event) => setDocumentNotes(event.target.value)}
                />
              </Field>
              <Field
                label={t("Texte personnalisé en bas de page")}
                hint={t("Ce texte appartient à ce document et reste modifiable sur les devis existants.")}
              >
                <textarea
                  name="terms"
                  rows={4}
                  value={footerText}
                  onChange={(event) => setFooterText(event.target.value)}
                />
              </Field>
              <details className="document-templates-details">
                <summary>{t("Réutiliser un texte de bas de page")}</summary>
              <div className="document-footer-templates">
                <label>
                  <span>{t("Appliquer un modèle")}</span>
                  <select
                    value={footerTemplateId}
                    onChange={(event) => {
                      const id = event.target.value;
                      setFooterTemplateId(id);
                      const template = settings.billing.footerTemplates.find(
                        (candidate) => candidate.id === id,
                      );
                      setFooterTemplateName(template?.name ?? '');
                      if (template) setFooterText(template.text);
                    }}
                  >
                    <option value="">{t("Choisir un modèle")}</option>
                    {settings.billing.footerTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("Nom du nouveau modèle")}</span>
                  <input
                    value={footerTemplateName}
                    onChange={(event) => setFooterTemplateName(event.target.value)}
                    placeholder={t("Ex. Conditions devis standard")}
                  />
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={busy || !footerTemplateName.trim() || !footerText.trim()}
                  onClick={() => void saveFooterTemplate()}
                >
                  <Save size={14} />{t("Enregistrer le modèle")}</Button>
                {footerTemplateId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() => void deleteFooterTemplate()}
                  >
                    <Archive size={14} />{t("Supprimer le modèle")}</Button>
                ) : null}
              </div>
              </details>
            </div>
            <div className="document-totals">
              <div>
                <span>{t("Sous-total avant remise")}</span>
                <strong>{formatMoney(totals.subtotalCents, currency)}</strong>
              </div>
              {totals.discountCents ? (
                <div>
                  <span>{t("Remises")}</span>
                  <strong>− {formatMoney(totals.discountCents, currency)}</strong>
                </div>
              ) : null}
              <div>
                <span>{t("Total net")}</span>
                <strong>{formatMoney(totals.netCents, currency)}</strong>
              </div>
              <div>
                <span>{t("TVA")}</span>
                <strong>{formatMoney(totals.vatCents, currency)}</strong>
              </div>
              <div>
                <span>
                  {invoiceType === 'credit_note'
                    ? t("Montant de l’avoir")
                    : t("Total TTC")}
                </span>
                <strong>{formatMoney(totals.totalCents, currency)}</strong>
              </div>
            </div>
          </div>
          </section>
          {!isLocked && <section className="document-step" data-document-step="3" hidden={step !== 3}>
            {stepHeading(3)}
            <article className="document-review" aria-label={t("Récapitulatif du brouillon")}>
              <header className="document-review__header"><span>{settings.organization.legalName}</span><span className="document-review__draft">{t("Brouillon")}</span></header>
              <p className="document-review__kind">{documentLabel}</p>
              <h4>{documentTitle}</h4>
              <div className="document-review__parties">
                <div><span>{t("Préparé pour")}</span><strong>{workspace.clients.find(client => client.id === selectedClientId)?.company || workspace.clients.find(client => client.id === selectedClientId)?.name}</strong><p>{workspace.projects.find(project => project.id === selectedProjectId)?.name || t("Sans projet associé")}</p></div>
                <div><span>{t("Date du document")}</span><strong>{formatDate(issueDate)}</strong>{invoiceType !== 'credit_note' && <p>{entity === 'quotes' ? t("Valable jusqu’au") : t("À régler avant le")} {formatDate(dueDate)}</p>}</div>
              </div>
              {entity === 'invoices' && <p className="document-review__period">{t('Prestation du {from} au {to}', {from: formatDate(serviceDateFrom), to: formatDate(serviceDateTo)})}{creditOriginal ? ` · ${t('Avoir lié à {number}', {number: creditOriginal.number})}` : ''}</p>}
              {invoiceType === 'deposit' && <p className="document-review__period">{t('Acompte de {percentage} % sur une base TTC de {amount}', {percentage: depositPercentage, amount: formatMoney(baseTotals.totalCents, currency)})}</p>}
              <div className="document-review__lines">
                {depositLines.map(line => <div key={line.id}><div><strong>{line.description}</strong><small>{line.quantity.toLocaleString(getAppLocale())} {line.unit} × {formatMoney(line.unitPriceCents, currency)}{line.discountBp ? ` · ${t('Remise')} ${(line.discountBp / 100).toLocaleString(getAppLocale())} %` : ''} · {t('TVA')} {(line.vatRateBp / 100).toLocaleString(getAppLocale())} %</small></div><span>{formatMoney(documentTotals([line]).netCents, currency)}</span></div>)}
              </div>
              <dl className="document-review__totals"><div><dt>{t("Total net")}</dt><dd>{formatMoney(totals.netCents, currency)}</dd></div><div><dt>{t("TVA")}</dt><dd>{formatMoney(totals.vatCents, currency)}</dd></div><div><dt>{invoiceType === 'credit_note' ? t("Montant de l’avoir") : t("Total TTC")}</dt><dd>{formatMoney(totals.totalCents, currency)}</dd></div></dl>
              {(documentNotes || footerText) && <footer>{documentNotes && <p>{documentNotes}</p>}{footerText && <p>{footerText}</p>}</footer>}
            </article>
            <p className="document-review__hint">{t("Enregistrez le brouillon pour ouvrir son aperçu et exporter un PDF. Le numéro définitif sera attribué à l’émission.")}</p>
          </section>}
        </fieldset>
        {isLocked ? (
          <div className="warning-card">
            <ShieldCheck size={19} />
            <div>
              <strong>
                {readOnlyReason
                  ? t("Brouillon piloté depuis la commande")
                  : t("Document verrouillé")}
              </strong>
              <p>
                {readOnlyReason ||
                  t("Utilisez un avoir lié à la facture d’origine pour toute correction.")}
              </p>
            </div>
          </div>
        ) : (
          <div className="document-wizard-footer">
            <div className="document-wizard-footer__total"><span>{invoiceType === 'credit_note' ? t("Montant de l’avoir") : t("Total TTC")}</span><strong>{totalsReady ? formatMoney(totals.totalCents, currency) : t("À compléter")}</strong></div>
            <FormActions
              onCancel={step ? () => goToStep(step - 1) : close}
              cancelLabel={step ? t("Retour") : t("Annuler")}
              busy={busy}
              disabled={readOnly}
              submitLabel={step === 3 ? t("Enregistrer le brouillon") : t("Continuer")}
            />
          </div>
        )}
      </form>
      </CreditDocumentDetails>
    </Modal>
  );
}

function CreditDocumentDetails({collapse,children}: {collapse:boolean;children:ReactNode}) {
  return collapse ? <details className="customer-credit-document-details"><summary>{t("Détails du document émis")}</summary>{children}</details> : children;
}
