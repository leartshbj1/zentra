import { useMemo, useState } from 'react';
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
import { activeCatalogItems, catalogItemToDocumentLine } from './catalog';
import type { DocumentLine, Invoice, Quote, Workspace } from './types';
import {
  addDaysIso,
  createId,
  documentTotals,
  formatMoney,
  invoicePaid,
  todayIso,
} from './utils';
import { Button, Field, FormActions, Modal, submitForm } from './ui';
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
  workspace,
  busy,
  readOnlyReason,
  close,
  act,
}: {
  entity: 'quotes' | 'invoices';
  item?: Quote | Invoice;
  quoteSource?: Quote;
  workspace: Workspace;
  busy: boolean;
  readOnlyReason?: string;
  close: () => void;
  act: ActionRunner;
}) {
  const settings = workspace.settings!;
  const terminology = projectTerminology(settings.business.nogaSection);
  const current = item ?? quoteSource;
  const currentInvoice = entity === 'invoices' ? (item as Invoice | undefined) : undefined;
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
    item?.clientId ?? quoteSource?.clientId ?? '',
  );
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
  const [footerText, setFooterText] = useState(
    item?.terms ?? quoteSource?.terms ?? settings.billing.defaultFooter,
  );
  const [footerTemplateId, setFooterTemplateId] = useState('');
  const [footerTemplateName, setFooterTemplateName] = useState('');
  const [localError, setLocalError] = useState('');
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

  function updateLine(id: string, patch: Partial<DocumentLine>) {
    setLines((currentLines) =>
      currentLines.map((line) =>
        line.id === id ? { ...line, ...patch } : line,
      ),
    );
  }

  function addCatalogItem() {
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
          : 'Le numéro définitif est attribué uniquement lors de l’émission.'
      }
      onClose={close}
      wide
    >
      <form
        onSubmit={submitForm(async (form) => {
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
            clientId: String(form.get('clientId')),
            projectId: String(form.get('projectId')) || null,
            title: String(form.get('title')),
            status: item?.status ?? 'draft',
            issueDate,
            currency: 'CHF',
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
        <fieldset disabled={busy || isLocked} className="document-form">
          <div className="form-grid">
            <Field label="Titre du document" required wide>
              <input
                name="title"
                defaultValue={item?.title ?? quoteSource?.title}
                required
                autoFocus
              />
            </Field>
            <Field label="Client" required>
              <div className="document-client-picker">
                <select
                  name="clientId"
                  value={selectedClientId}
                  onChange={(event) => setSelectedClientId(event.target.value)}
                  required
                >
                  <option value="">Choisir un client</option>
                  {workspace.clients
                    .filter(
                      (client) =>
                        !client.archivedAt ||
                        client.id === item?.clientId ||
                        client.id === quoteSource?.clientId,
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
                defaultValue={item?.projectId ?? quoteSource?.projectId ?? ''}
              >
                <option value="">Aucun {terminology.singular} lié</option>
                {workspace.projects.map((project) => (
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
            <Field label="Date d’émission" required>
              <input
                type="date"
                value={issueDate}
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
            {invoiceType === 'credit_note' ? (
              <Field label="Facture originale" required wide>
                <select
                  value={originalInvoiceId}
                  onChange={(event) => setOriginalInvoiceId(event.target.value)}
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
                Aucun encaissement n’est possible.
              </span>
            </div>
          ) : null}
          {invoiceType === 'deposit' ? (
            <section className="deposit-builder" aria-label="Calcul de l’acompte">
              <div className="deposit-builder__copy">
                <strong>Calculer l’acompte sur les lignes ci-dessous</strong>
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
                <span>Base TTC <strong>{formatMoney(baseTotals.totalCents)}</strong></span>
                <span>Acompte TTC <strong>{formatMoney(totals.totalCents)}</strong></span>
              </div>
            </section>
          ) : null}
          {localError ? (
            <div className="warning-card">
              <ShieldCheck size={18} />
              <div>
                <strong>Enregistrement bloqué</strong>
                <p>{localError}</p>
              </div>
            </div>
          ) : null}
          <section className="line-editor">
            <header>
              <div>
                <strong>{invoiceType === 'deposit' ? 'Base de calcul de l’acompte' : 'Lignes du document'}</strong>
                <small>
                  Le catalogue accélère la saisie; chaque valeur reste
                  modifiable dans ce brouillon.
                </small>
              </div>
              <div className="line-editor__actions">
                <div className="catalog-line-picker">
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
                    disabled={!catalogItems.length}
                  />
                  <select
                    value={catalogItemId}
                    onChange={(event) => setCatalogItemId(event.target.value)}
                    aria-label="Référence du catalogue à ajouter"
                    disabled={!catalogItems.length}
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
                    disabled={!catalogItemId}
                    onClick={addCatalogItem}
                  >
                    Ajouter depuis le catalogue
                  </Button>
                  {catalogItems.length > DOCUMENT_CATALOG_RESULT_LIMIT && !catalogQuery.trim() ? (
                    <small className="catalog-line-picker__hint">
                      Recherchez pour parcourir les {catalogItems.length} références.
                    </small>
                  ) : null}
                </div>
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
                <input
                  value={line.description}
                  onChange={(event) =>
                    updateLine(line.id, { description: event.target.value })
                  }
                  aria-label="Description"
                  required
                />
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
                <input
                  value={line.unit}
                  onChange={(event) =>
                    updateLine(line.id, { unit: event.target.value })
                  }
                  aria-label="Unité"
                  required
                />
                <label className="money-input">
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
                  <span>CHF</span>
                </label>
                <label className="percent-input">
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
                    <option value={0}>0 % · Hors TVA / taux 0</option>
                    {settings.billing.vatRatesBp
                      .filter((rate) => rate !== 0)
                      .map((rate) => (
                        <option value={rate} key={rate}>
                          {(rate / 100).toLocaleString('fr-CH')} %
                        </option>
                      ))}
                  </select>
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
          <div className="document-bottom">
            <div className="document-copy-fields">
              <Field label="Notes / texte complémentaire">
                <textarea
                  name="notes"
                  rows={4}
                  defaultValue={item?.notes ?? quoteSource?.notes}
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
            </div>
            <div className="document-totals">
              <div>
                <span>Sous-total avant remise</span>
                <strong>{formatMoney(totals.subtotalCents)}</strong>
              </div>
              {totals.discountCents ? (
                <div>
                  <span>Remises</span>
                  <strong>− {formatMoney(totals.discountCents)}</strong>
                </div>
              ) : null}
              <div>
                <span>Total net</span>
                <strong>{formatMoney(totals.netCents)}</strong>
              </div>
              <div>
                <span>TVA</span>
                <strong>{formatMoney(totals.vatCents)}</strong>
              </div>
              <div>
                <span>
                  {invoiceType === 'credit_note'
                    ? 'Montant de l’avoir'
                    : 'Total TTC'}
                </span>
                <strong>{formatMoney(totals.totalCents)}</strong>
              </div>
            </div>
          </div>
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
          <FormActions
            onCancel={close}
            busy={busy}
            submitLabel="Enregistrer le brouillon"
          />
        )}
      </form>
    </Modal>
  );
}
