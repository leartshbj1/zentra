import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
) => Promise<boolean>;

export function DocumentEditor({
  entity,
  item,
  quoteSource,
  initialProject,
  workspace,
  busy,
  readOnlyReason,
  readOnly = false,
  close,
  act,
}: {
  entity: 'quotes' | 'invoices';
  item?: Quote | Invoice;
  quoteSource?: Quote;
  initialProject?: Project;
  workspace: Workspace;
  busy: boolean;
  readOnlyReason?: string;
  readOnly?: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const settings = workspace.settings!;
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
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [step, setStep] = useState(0);
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
      ? 'devis'
      : invoiceType === 'credit_note'
        ? 'avoir'
        : invoiceType === 'deposit'
          ? 'facture d’acompte'
          : 'facture';

  const steps = ['Client', 'Prestations', 'Conditions', 'Vérification'];
  const stepDescriptions = ['Destinataire et projet', 'Lignes et montants', 'Dates et message', 'Relecture du document'];
  const stepTitles = ['Pour qui préparez-vous ce document ?', 'Qu’allez-vous réaliser ?', 'Les derniers détails.', 'Tout est prêt ?'];
  const stepHints = ['Choisissez votre client et retrouvez tous ses documents dans le même projet.', 'Ajoutez vos prestations ou retrouvez-les dans votre catalogue.', 'Précisez les dates et le message qui accompagnera votre document.', 'Relisez votre document. Vous pourrez encore le modifier avant de l’émettre.'];

  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const panel = formRef.current?.querySelector<HTMLElement>(`[data-document-step="${step}"]`);
    const scroller = formRef.current?.querySelector('.document-form');
    if (scroller) scroller.scrollTop = 0;
    (pendingFocus.current || panel?.querySelector<HTMLElement>('h3'))?.focus({ preventScroll: true });
    pendingFocus.current?.scrollIntoView({ block: 'nearest' });
    pendingFocus.current = null;
  }, [step]);

  function showStepError(index: number, message: string, field?: HTMLElement) {
    setLocalError(message);
    setSaveAttempt((attempt) => attempt + 1);
    if (step !== index) {
      pendingFocus.current = field || null;
      setStep(index);
    } else if (field) {
      field.focus();
      field.scrollIntoView({ block: 'nearest' });
    }
    return false;
  }

  function validateStep(index: number) {
    const fields = formRef.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-document-step="${index}"] input, [data-document-step="${index}"] select, [data-document-step="${index}"] textarea`);
    const invalid = [...(fields || [])].find((field) => !field.checkValidity());
    if (invalid) return showStepError(index, 'Complétez le champ indiqué pour continuer.', invalid);
    if (index === 0 && quickClientOpen) return showStepError(0, 'Ajoutez le nouveau contact ou fermez sa fiche pour continuer.');
    if (index === 0 && !documentTitle.trim()) return showStepError(0, 'Donnez un titre à votre document.', formRef.current?.querySelector<HTMLInputElement>('[name="title"]') || undefined);
    if (index === 1) {
      const error = documentLinesValidationError(lines);
      if (error) return showStepError(1, error);
    }
    if (index === 2) {
      const error = entity === 'quotes' || invoiceType !== 'credit_note' ? salesDocumentDateError(entity, issueDate, dueDate) : '';
      if (error) return showStepError(2, error);
      if (entity === 'invoices' && (!serviceDateFrom || !serviceDateTo || serviceDateFrom > serviceDateTo)) return showStepError(2, 'Choisissez une période de prestation valide.');
      if (creditOriginal?.issueDate && issueDate < creditOriginal.issueDate) return showStepError(2, 'La date de l’avoir ne peut pas précéder celle de la facture originale.');
      if (invoiceType === 'deposit' && !validDepositPercentageBp(depositPercentageBp)) return showStepError(2, 'Saisissez un acompte compris entre 0,01 et 100 %.');
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
          : 'Le nouveau client n’a pas pu être préparé.',
      );
      return;
    }
    const saved = await act(
      () => desktopApi.createEntity('clients', client),
      `Le client ${client.company || client.contactPerson} a été ajouté et sélectionné.`,
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
        'Saisissez un nom de modèle et un texte de bas de page avant de l’enregistrer.',
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
          : 'Le modèle de bas de page n’a pas pu être préparé.',
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
        ? `Le modèle « ${update.name} » a été mis à jour.`
        : `Le modèle « ${update.name} » a été enregistré.`,
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
      `Le modèle « ${template.name} » a été supprimé.`,
      false,
    );
    if (saved) {
      setFooterTemplateId('');
      setFooterTemplateName('');
    }
  }

  return (
    <Modal
      title={`${item ? (isLocked ? 'Consulter' : 'Modifier') : entity === 'quotes' ? 'Nouveau' : 'Nouvelle'} ${documentLabel}`}
      description={
        readOnlyReason
          ? readOnlyReason
          : isLocked
          ? 'Le document émis est verrouillé et ne peut pas être supprimé.'
          : 'Un document clair, en quatre étapes.'
      }
      onClose={close}
      className={!isLocked ? "document-editor-dialog" : undefined}
      wide
    >
      {currentInvoice && currentInvoice.status !== 'draft' && <CustomerCreditPanel invoice={currentInvoice} workspace={workspace} busy={busy} readOnly={readOnly} act={act}/>}
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
              'Choisissez le type et une période de prestation valide avant l’enregistrement.',
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
              'Un avoir doit référencer explicitement la facture originale.',
            );
            return;
          }
          if (creditOriginal?.issueDate && issueDate < creditOriginal.issueDate) {
            setLocalError('La date de l’avoir ne peut pas précéder celle de la facture originale.');
            return;
          }
          if (
            entity === 'invoices' &&
            invoiceType === 'deposit' &&
            !validDepositPercentageBp(depositPercentageBp)
          ) {
            setLocalError(
              'Saisissez un acompte compris entre 0,01 et 100 % avant l’enregistrement.',
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
              ? 'Le brouillon a été mis à jour.'
              : `${entity === 'quotes' ? 'Le devis' : invoiceType === 'credit_note' ? 'L’avoir' : 'La facture'} a été enregistré en brouillon.`,
          );
        })}
      >
        {!isLocked && <nav className="document-stepper" aria-label="Étapes de création">
          <div className="document-stepper__intro"><span>Votre document</span><strong>{documentTitle.trim() || (entity === 'quotes' ? 'Nouveau devis' : invoiceType === 'credit_note' ? 'Nouvel avoir' : 'Nouvelle facture')}</strong></div>
          <ol>{steps.map((label, index) => <li key={label}><button type="button" aria-label={`${index + 1}. ${label}`} aria-current={step === index ? 'step' : undefined} disabled={busy} onClick={() => goToStep(index)}><span className="document-stepper__number" aria-hidden="true">{index < step ? <Check size={14} /> : index + 1}</span><span className="document-stepper__label"><strong>{label}</strong><small>{stepDescriptions[index]}</small></span></button></li>)}</ol>
          <div className="document-stepper__track"><span style={{ transform: `scaleX(${(step + 1) / 4})` }} /></div>
          <p className="document-stepper__note">Vous pourrez modifier le brouillon avant de l’émettre.</p>
        </nav>}
        {localError ? <ErrorPanel key={saveAttempt} title="Encore un détail" message={localError} /> : null}
        <fieldset disabled={busy || isLocked} className="document-form">
          <section className="document-step" data-document-step="0" hidden={!isLocked && step !== 0}>
            {stepHeading(0)}
          <div className="form-grid">
            <Field label="Titre du document" required wide>
              <input
                name="title"
                placeholder="Ex. Aménagement du séjour"
                value={documentTitle}
                onChange={(event) => setDocumentTitle(event.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label="Client" required>
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
                  <option value="">Choisir un client</option>
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
                        {client.archivedAt ? ' · archivé' : ''}
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
                  {quickClientOpen ? 'Fermer' : 'Nouveau contact'}
                </Button>
              </div>
            </Field>
            <Field label={terminology.singularTitle}>
              <select
                name="projectId"
                value={selectedProjectId}
                disabled={Boolean(creditOriginal)}
                onChange={(event) => setSelectedProjectId(event.target.value)}
              >
                <option value="">Aucun {terminology.singular} lié</option>
                {workspace.projects.filter((project) => project.clientId === selectedClientId).map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
            {entity === 'invoices' ? (
              <Field label="Type de document" required>
                <select
                  value={invoiceType}
                  onChange={(event) => {
                    setInvoiceType(event.target.value as Invoice['type'] | '');
                    if (event.target.value !== 'credit_note')
                      setOriginalInvoiceId('');
                  }}
                  required
                >
                  <option value="">Choisir le type</option>
                  <option value="standard">Facture standard</option>
                  <option value="deposit">Facture d’acompte</option>
                  <option value="progress">Facture de situation</option>
                  <option value="final">Facture finale</option>
                  <option value="credit_note">Avoir</option>
                </select>
              </Field>
            ) : null}
            <Field label="Devise"><input value={currency} readOnly /></Field>
            {invoiceType === 'credit_note' ? (
              <Field label="Facture originale" required wide>
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
                  <option value="">Choisir la facture à corriger</option>
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
            <section className="document-inline-card" aria-label="Ajouter un nouveau client">
              <header>
                <div>
                  <strong>Nouveau client</strong>
                  <small>
                    Renseignez l’entreprise ou le nom du contact. Il sera
                    enregistré puis sélectionné sans fermer le document.
                  </small>
                </div>
              </header>
              <div className="form-grid">
                {([
                  ['contactPerson', 'Nom du contact', false],
                  ['company', 'Entreprise', false],
                  ['email', 'E-mail', false],
                  ['phone', 'Téléphone', false],
                  ['street', 'Rue / case postale', true],
                  ['buildingNumber', 'Numéro', false],
                  ['postalCode', 'NPA', true],
                  ['city', 'Localité', true],
                  ['canton', 'Canton', false],
                  ['country', 'Pays (ISO)', true],
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
                  <Check size={15} /> Ajouter et sélectionner
                </Button>
              </div>
            </section>
          ) : null}
          {invoiceType === 'credit_note' ? (
            <div className="info-strip">
              <Receipt size={17} />
              <span>
                L’avoir est lié à la facture originale, numéroté sur sa propre
                séquence et comptabilisé en montants négatifs à l’émission.
                Reprenez ses taux de TVA et ses montants encore créditables.
                Aucun encaissement n’est possible.
              </span>
            </div>
          ) : null}
          </section>
          <section className="document-step" data-document-step="1" hidden={!isLocked && step !== 1}>
            {stepHeading(1)}
          <section className="line-editor">
            <header>
              <div>
                <strong>{invoiceType === 'deposit' ? 'Base de calcul de l’acompte' : 'Lignes du document'}</strong>
                <small className={currency !== 'CHF' ? 'document-currency-hint' : undefined}>
                  {currency === 'CHF' ? (catalogItems.length ? 'Retrouvez une prestation du catalogue ou ajoutez une ligne libre.' : 'Décrivez vos prestations, leur quantité et leur prix.') : `Saisissez les prix en ${currency}. Les prix du catalogue sont en CHF et ne sont pas convertis automatiquement.`}
                </small>
              </div>
              <div className="line-editor__actions">
                {catalogItems.length > 0 && <div className="catalog-line-picker">
                  <Package size={15} />
                  <input
                    type="search"
                    value={catalogQuery}
                    onChange={(event) => {
                      setCatalogQuery(event.target.value);
                      setCatalogItemId('');
                    }}
                    placeholder="Référence ou désignation"
                    aria-label="Rechercher une référence du catalogue"
                    disabled={!catalogItems.length || currency !== 'CHF'}
                  />
                  <select
                    value={catalogItemId}
                    onChange={(event) => setCatalogItemId(event.target.value)}
                    aria-label="Référence du catalogue à ajouter"
                    disabled={!catalogItems.length || currency !== 'CHF'}
                  >
                    <option value="">
                      {!catalogItems.length
                        ? 'Catalogue vide'
                        : visibleCatalogItems.length
                          ? 'Choisir une référence'
                          : 'Aucune référence trouvée'}
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
                  >
                    Ajouter depuis le catalogue
                  </Button>
                  {catalogItems.length > DOCUMENT_CATALOG_RESULT_LIMIT && !catalogQuery.trim() ? (
                    <small className="catalog-line-picker__hint">
                      Recherchez pour parcourir les {catalogItems.length} références.
                    </small>
                  ) : null}
                </div>}
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
                  <Plus size={15} /> Ligne libre
                </Button>
              </div>
            </header>
            <div className="line-editor__head">
              <span>Description</span>
              <span>Quantité</span>
              <span>Unité</span>
              <span>Prix unitaire</span>
              <span>Remise</span>
              <span>TVA</span>
              <span />
            </div>
            {lines.map((line) => (
              <div className="line-editor__row" key={line.id}>
                <label className="document-line-field" data-label="Description">
                <input
                  value={line.description}
                  onChange={(event) =>
                    updateLine(line.id, { description: event.target.value })
                  }
                  aria-label="Description"
                  required
                />
                </label>
                <label className="document-line-field" data-label="Quantité">
                <input
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  value={line.quantity || ''}
                  onChange={(event) =>
                    updateLine(line.id, {
                      quantity: event.target.valueAsNumber || 0,
                    })
                  }
                  aria-label="Quantité"
                  required
                />
                </label>
                <label className="document-line-field" data-label="Unité">
                <input
                  value={line.unit}
                  onChange={(event) =>
                    updateLine(line.id, { unit: event.target.value })
                  }
                  aria-label="Unité"
                  required
                />
                </label>
                <label className="money-input" data-label="Prix unitaire">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.unitPriceCents ? line.unitPriceCents / 100 : ''}
                    onChange={(event) =>
                      updateLine(line.id, {
                        unitPriceCents: Math.round(
                          (event.target.valueAsNumber || 0) * 100,
                        ),
                      })
                    }
                    aria-label="Prix unitaire"
                    required
                  />
                  <span>{currency}</span>
                </label>
                <label className="percent-input" data-label="Remise">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={(line.discountBp ?? 0) / 100}
                    onChange={(event) =>
                      updateLine(line.id, {
                        discountBp: Math.round(
                          (event.target.valueAsNumber || 0) * 100,
                        ),
                      })
                    }
                    aria-label="Remise en pour cent"
                  />
                  <span>%</span>
                </label>
                {settings.organization.vatRegistered ? (
                  <label className="document-line-field" data-label="TVA">
                  <select
                    value={line.vatRateBp < 0 ? '' : line.vatRateBp}
                    onChange={(event) =>
                      updateLine(line.id, {
                        vatRateBp: documentVatRateFromInput(event.target.value),
                      })
                    }
                    aria-label="Taux TVA"
                    required
                  >
                    <option value="">Choisir</option>
                    {line.vatRateBp >= 0 && !documentVatRates.includes(line.vatRateBp) ? (
                      <option value={line.vatRateBp} disabled>
                        {(line.vatRateBp / 100).toLocaleString('fr-CH')} % · Taux à corriger
                      </option>
                    ) : null}
                    {documentVatRates
                      .map((rate) => (
                        <option value={rate} key={rate}>
                          {rate === 0 ? '0 % · Hors TVA / taux 0' : `${(rate / 100).toLocaleString('fr-CH')} %`}
                        </option>
                      ))}
                  </select>
                  </label>
                ) : (
                  <span className="no-vat">Sans TVA</span>
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
                  aria-label="Supprimer la ligne"
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
            <Field label="Date d’émission" required>
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
                label={entity === 'quotes' ? 'Valable jusqu’au' : 'Échéance'}
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
                <Field label="Début de la prestation" required>
                  <input
                    type="date"
                    value={serviceDateFrom}
                    onChange={(event) => setServiceDateFrom(event.target.value)}
                    required
                  />
                </Field>
                <Field label="Fin de la prestation" required>
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
            <section className="deposit-builder" aria-label="Calcul de l’acompte">
              <div className="deposit-builder__copy">
                <strong>Calculer l’acompte sur vos prestations</strong>
                <small>
                  Saisissez la base complète. Zentra facture uniquement le pourcentage indiqué,
                  par taux de TVA, sans déclencher de sortie de stock.
                </small>
              </div>
              <Field label="Pourcentage de l’acompte" required>
                <label className="percent-input">
                  <input
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    value={depositPercentage}
                    onChange={(event) => setDepositPercentage(event.target.value)}
                    aria-label="Pourcentage de l’acompte"
                    required
                  />
                  <span>%</span>
                </label>
              </Field>
              <div className="deposit-builder__summary" aria-live="polite">
                <span>Base TTC <strong>{formatMoney(baseTotals.totalCents, currency)}</strong></span>
                <span>Acompte TTC <strong>{formatMoney(totals.totalCents, currency)}</strong></span>
              </div>
            </section>
          ) : null}
          <div className="document-bottom">
            <div className="document-copy-fields">
              <Field label="Notes / texte complémentaire" hint="Entrée ajoute une nouvelle ligne. Les paragraphes sont conservés dans l’aperçu et le PDF.">
                <textarea
                  name="notes"
                  rows={4}
                  value={documentNotes}
                  onChange={(event) => setDocumentNotes(event.target.value)}
                />
              </Field>
              <Field
                label="Texte personnalisé en bas de page"
                hint="Ce texte appartient à ce document et reste modifiable sur les devis existants."
              >
                <textarea
                  name="terms"
                  rows={4}
                  value={footerText}
                  onChange={(event) => setFooterText(event.target.value)}
                />
              </Field>
              <details className="document-templates-details">
                <summary>Réutiliser un texte de bas de page</summary>
              <div className="document-footer-templates">
                <label>
                  <span>Appliquer un modèle</span>
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
                    <option value="">Choisir un modèle</option>
                    {settings.billing.footerTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Nom du nouveau modèle</span>
                  <input
                    value={footerTemplateName}
                    onChange={(event) => setFooterTemplateName(event.target.value)}
                    placeholder="Ex. Conditions devis standard"
                  />
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={busy || !footerTemplateName.trim() || !footerText.trim()}
                  onClick={() => void saveFooterTemplate()}
                >
                  <Save size={14} /> Enregistrer le modèle
                </Button>
                {footerTemplateId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() => void deleteFooterTemplate()}
                  >
                    <Archive size={14} /> Supprimer le modèle
                  </Button>
                ) : null}
              </div>
              </details>
            </div>
            <div className="document-totals">
              <div>
                <span>Sous-total avant remise</span>
                <strong>{formatMoney(totals.subtotalCents, currency)}</strong>
              </div>
              {totals.discountCents ? (
                <div>
                  <span>Remises</span>
                  <strong>− {formatMoney(totals.discountCents, currency)}</strong>
                </div>
              ) : null}
              <div>
                <span>Total net</span>
                <strong>{formatMoney(totals.netCents, currency)}</strong>
              </div>
              <div>
                <span>TVA</span>
                <strong>{formatMoney(totals.vatCents, currency)}</strong>
              </div>
              <div>
                <span>
                  {invoiceType === 'credit_note'
                    ? 'Montant de l’avoir'
                    : 'Total TTC'}
                </span>
                <strong>{formatMoney(totals.totalCents, currency)}</strong>
              </div>
            </div>
          </div>
          </section>
          {!isLocked && <section className="document-step" data-document-step="3" hidden={step !== 3}>
            {stepHeading(3)}
            <article className="document-review" aria-label="Récapitulatif du brouillon">
              <header className="document-review__header"><span>{settings.organization.legalName}</span><span className="document-review__draft">Brouillon</span></header>
              <p className="document-review__kind">{documentLabel}</p>
              <h4>{documentTitle}</h4>
              <div className="document-review__parties">
                <div><span>Préparé pour</span><strong>{workspace.clients.find(client => client.id === selectedClientId)?.company || workspace.clients.find(client => client.id === selectedClientId)?.name}</strong><p>{workspace.projects.find(project => project.id === selectedProjectId)?.name || 'Sans projet associé'}</p></div>
                <div><span>Date du document</span><strong>{formatDate(issueDate)}</strong>{invoiceType !== 'credit_note' && <p>{entity === 'quotes' ? 'Valable jusqu’au' : 'À régler avant le'} {formatDate(dueDate)}</p>}</div>
              </div>
              {entity === 'invoices' && <p className="document-review__period">Prestation du {formatDate(serviceDateFrom)} au {formatDate(serviceDateTo)}{creditOriginal ? ` · Avoir lié à ${creditOriginal.number}` : ''}</p>}
              {invoiceType === 'deposit' && <p className="document-review__period">Acompte de {depositPercentage} % sur une base TTC de {formatMoney(baseTotals.totalCents, currency)}</p>}
              <div className="document-review__lines">
                {depositLines.map(line => <div key={line.id}><div><strong>{line.description}</strong><small>{line.quantity.toLocaleString('fr-CH')} {line.unit} × {formatMoney(line.unitPriceCents, currency)}{line.discountBp ? ` · Remise ${(line.discountBp / 100).toLocaleString('fr-CH')} %` : ''} · TVA {(line.vatRateBp / 100).toLocaleString('fr-CH')} %</small></div><span>{formatMoney(documentTotals([line]).netCents, currency)}</span></div>)}
              </div>
              <dl className="document-review__totals"><div><dt>Total net</dt><dd>{formatMoney(totals.netCents, currency)}</dd></div><div><dt>TVA</dt><dd>{formatMoney(totals.vatCents, currency)}</dd></div><div><dt>{invoiceType === 'credit_note' ? 'Montant de l’avoir' : 'Total TTC'}</dt><dd>{formatMoney(totals.totalCents, currency)}</dd></div></dl>
              {(documentNotes || footerText) && <footer>{documentNotes && <p>{documentNotes}</p>}{footerText && <p>{footerText}</p>}</footer>}
            </article>
            <p className="document-review__hint">Enregistrez le brouillon pour ouvrir son aperçu et exporter un PDF. Le numéro définitif sera attribué à l’émission.</p>
          </section>}
        </fieldset>
        {isLocked ? (
          <div className="warning-card">
            <ShieldCheck size={19} />
            <div>
              <strong>
                {readOnlyReason
                  ? 'Brouillon piloté depuis la commande'
                  : 'Document verrouillé'}
              </strong>
              <p>
                {readOnlyReason ||
                  'Utilisez un avoir lié à la facture d’origine pour toute correction.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="document-wizard-footer">
            <div className="document-wizard-footer__total"><span>{invoiceType === 'credit_note' ? 'Montant de l’avoir' : 'Total TTC'}</span><strong>{formatMoney(totals.totalCents, currency)}</strong></div>
            <FormActions
              onCancel={step ? () => goToStep(step - 1) : close}
              cancelLabel={step ? 'Retour' : 'Annuler'}
              busy={busy}
              disabled={readOnly}
              submitLabel={step === 3 ? 'Enregistrer le brouillon' : 'Continuer'}
            />
          </div>
        )}
      </form>
      </CreditDocumentDetails>
    </Modal>
  );
}

function CreditDocumentDetails({collapse,children}: {collapse:boolean;children:ReactNode}) {
  return collapse ? <details className="customer-credit-document-details"><summary>Détails du document émis</summary>{children}</details> : children;
}
