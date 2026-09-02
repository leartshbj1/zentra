import { useMemo, useState } from 'react';
import { Archive, Banknote, Building2, CheckCircle2, Clock3, Eye, FileCheck2, FolderOpen, Mail, Paperclip, Pencil, Phone, Plus, ReceiptText, RotateCcw, Search, ShieldCheck, Trash2, Upload, WalletCards } from 'lucide-react';
import { desktopApi } from './bridge';
import {
  filterPurchaseExpenses,
  filterSupplierInvoices,
  filterSuppliers,
  isExpenseOverdue,
  isSupplierInvoiceOverdue,
  purchaseSummary,
  selectableSuppliers,
  supplierSnapshotForDraft,
  supplierDueDate,
  type PurchaseTab,
  type SupplierVisibility,
} from './purchases';
import { projectTerminology } from './terminology';
import type { Attachment, Expense, Supplier, SupplierInvoice, Workspace } from './types';
import { centsFromInput, createId, errorMessage, formatDate, formatMoney, numberFromInput, todayIso } from './utils';
import { Button, EmptyState, Field, FormActions, Modal, SectionHeading, StatusBadge, submitForm } from './ui';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>;

export function PurchasesScreen({
  workspace,
  query,
  onQueryChange,
  busy,
  onCreateSupplierInvoice,
  onOpenSupplierInvoice,
  onEditSupplierInvoice,
  onValidateSupplierInvoice,
  onDeleteSupplierInvoiceDraft,
  onRecordSupplierPayment,
  onOpenLegacyExpense,
  onEditLegacyExpense,
  onArchiveLegacyExpense,
  onMarkLegacyExpensePaid,
  onCreateSupplier,
  onEditSupplier,
  onArchiveSupplier,
  onRestoreSupplier,
  onOpenAccounting,
}: {
  workspace: Workspace;
  query: string;
  onQueryChange: (query: string) => void;
  busy: boolean;
  onCreateSupplierInvoice: () => void;
  onOpenSupplierInvoice: (invoice: SupplierInvoice) => void;
  onEditSupplierInvoice: (invoice: SupplierInvoice) => void;
  onValidateSupplierInvoice: (invoice: SupplierInvoice) => void;
  onDeleteSupplierInvoiceDraft: (invoice: SupplierInvoice) => void;
  onRecordSupplierPayment: (invoice: SupplierInvoice) => void;
  onOpenLegacyExpense: (expense: Expense) => void;
  onEditLegacyExpense: (expense: Expense) => void;
  onArchiveLegacyExpense: (expense: Expense) => void;
  onMarkLegacyExpensePaid: (expense: Expense) => void;
  onCreateSupplier: () => void;
  onEditSupplier: (supplier: Supplier) => void;
  onArchiveSupplier: (supplier: Supplier) => void;
  onRestoreSupplier: (supplier: Supplier) => void;
  onOpenAccounting: () => void;
}) {
  const [tab, setTab] = useState<PurchaseTab>('pending');
  const [supplierVisibility, setSupplierVisibility] = useState<SupplierVisibility>('active');
  const today = todayIso();
  const summary = useMemo(
    () => purchaseSummary(workspace.expenses, today, workspace.supplierInvoices),
    [workspace.expenses, workspace.supplierInvoices, today],
  );
  const invoiceStatus = tab === 'suppliers' ? null : tab;
  const supplierInvoices = useMemo(
    () => invoiceStatus ? filterSupplierInvoices(workspace.supplierInvoices, workspace.projects, query, invoiceStatus) : [],
    [workspace.supplierInvoices, workspace.projects, query, invoiceStatus],
  );
  const legacyExpenses = useMemo(
    () => tab === 'pending' || tab === 'paid'
      ? filterPurchaseExpenses(workspace.expenses, workspace.projects, query, tab)
      : [],
    [workspace.expenses, workspace.projects, query, tab],
  );
  const suppliers = useMemo(
    () => filterSuppliers(workspace.suppliers, query, supplierVisibility),
    [workspace.suppliers, query, supplierVisibility],
  );
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const invoiceBlockReason = !workspace.suppliers.some((supplier) => !supplier.archivedAt)
    ? 'Ajoutez d’abord un fournisseur actif.'
    : !workspace.settings!.work.costCategories.length
      ? 'Ajoutez d’abord une catégorie de coûts dans Paramètres.'
      : '';
  const accountingEnabled = Boolean(workspace.accountingSettings?.enabled);
  const accounting = workspace.accountingSettings;
  const supplierPaymentReady = Boolean(accounting?.enabled && accounting.bankAccountId);
  const supplierAccountingReady = Boolean(accounting?.enabled && [
    accounting.arAccountId,
    accounting.revenueAccountId,
    accounting.vatPayableAccountId,
    accounting.bankAccountId,
    accounting.expenseAccountId,
    accounting.vatReceivableAccountId,
    accounting.wagesExpenseAccountId,
    accounting.wagesPayableAccountId,
    accounting.socialExpenseAccountId,
    accounting.socialPayableAccountId,
    accounting.supplierPayableAccountId,
  ].every(Boolean));
  const tabCounts = {
    draft: workspace.supplierInvoices.filter((invoice) => invoice.documentStatus === 'draft').length,
    pending: workspace.supplierInvoices.filter((invoice) => invoice.paymentStatus === 'pending').length + workspace.expenses.filter((expense) => expense.paymentStatus === 'pending').length,
    partial: workspace.supplierInvoices.filter((invoice) => invoice.paymentStatus === 'partial').length,
    paid: workspace.supplierInvoices.filter((invoice) => invoice.paymentStatus === 'paid').length + workspace.expenses.filter((expense) => expense.paymentStatus === 'paid').length,
  };

  return <div className="stack-layout purchases-screen">
    <div className="summary-strip purchase-summary" aria-label="Résumé des achats">
      <div><span>À payer · {summary.pendingCount}</span><strong>{formatMoney(summary.pendingCents)}</strong></div>
      <div><span>Échu · {summary.overdueCount}</span><strong className={summary.overdueCount ? 'is-negative' : ''}>{formatMoney(summary.overdueCents)}</strong></div>
      <div><span>Déjà payé · {summary.paidCount}</span><strong>{formatMoney(summary.paidCents)}</strong></div>
    </div>
    {!supplierAccountingReady && (summary.pendingCount > 0 || summary.draftCount > 0) ? <div className="report-callout is-warning"><WalletCards size={20} /><div><strong>Terminez la liaison des dettes fournisseurs</strong><p>La validation et le paiement restent bloqués tant que la comptabilité et le compte « Dettes fournisseurs » ne sont pas prêts. Les brouillons restent modifiables.</p></div><Button variant="secondary" onClick={onOpenAccounting}>Ouvrir Plan & liaisons</Button></div> : null}

    <section className="panel purchase-panel">
      <SectionHeading
        eyebrow="Données locales"
        title="Factures fournisseurs"
        description="Préparez, validez puis réglez vos factures. Chaque validation et paiement crée son écriture locale sans envoyer d’ordre bancaire."
        action={<Button disabled={tab !== 'suppliers' && Boolean(invoiceBlockReason)} title={tab === 'suppliers' ? 'Ajouter un fournisseur' : invoiceBlockReason || 'Créer une facture fournisseur'} onClick={tab === 'suppliers' ? onCreateSupplier : onCreateSupplierInvoice}><Plus size={16} /> {tab === 'suppliers' ? 'Nouveau fournisseur' : 'Nouvelle facture fournisseur'}</Button>}
      />
      <div className="purchase-toolbar">
        <div className="tab-strip" role="tablist" aria-label="Sections des achats">
          <button type="button" role="tab" aria-selected={tab === 'draft'} className={tab === 'draft' ? 'is-active' : ''} onClick={() => setTab('draft')}><ReceiptText size={15} /> Brouillons <em>{tabCounts.draft}</em></button>
          <button type="button" role="tab" aria-selected={tab === 'pending'} className={tab === 'pending' ? 'is-active' : ''} onClick={() => setTab('pending')}><Clock3 size={15} /> À payer <em>{tabCounts.pending}</em></button>
          <button type="button" role="tab" aria-selected={tab === 'partial'} className={tab === 'partial' ? 'is-active' : ''} onClick={() => setTab('partial')}><Banknote size={15} /> Partiels <em>{tabCounts.partial}</em></button>
          <button type="button" role="tab" aria-selected={tab === 'paid'} className={tab === 'paid' ? 'is-active' : ''} onClick={() => setTab('paid')}><CheckCircle2 size={15} /> Payés <em>{tabCounts.paid}</em></button>
          <button type="button" role="tab" aria-selected={tab === 'suppliers'} className={tab === 'suppliers' ? 'is-active' : ''} onClick={() => setTab('suppliers')}><Building2 size={15} /> Fournisseurs <em>{workspace.suppliers.filter((supplier) => !supplier.archivedAt).length}</em></button>
        </div>
        <label className="purchase-search"><Search size={15} /><span className="sr-only">Rechercher</span><input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={tab === 'suppliers' ? 'Nom, contact, IDE, IBAN…' : 'Fournisseur, projet, référence…'} /></label>
        {tab === 'suppliers' ? <label className="supplier-visibility"><span>État</span><select value={supplierVisibility} onChange={(event) => setSupplierVisibility(event.target.value as SupplierVisibility)}><option value="active">Actifs</option><option value="archived">Archivés</option><option value="all">Tous</option></select></label> : null}
      </div>

      {tab === 'suppliers' ? suppliers.length ? <div className="supplier-list" role="list">
        {suppliers.map((supplier) => <article className={`supplier-card ${supplier.archivedAt ? 'is-archived' : ''}`} key={supplier.id} role="listitem">
          <div className="supplier-card__icon"><Building2 size={19} /></div>
          <div className="supplier-card__identity"><div><strong>{supplier.name}</strong><StatusBadge status={supplier.archivedAt ? 'incomplete' : 'validated'} label={supplier.archivedAt ? 'Archivé' : 'Actif'} /></div><p>{supplier.contactName || 'Aucun contact renseigné'}</p>{supplier.address ? <small>{supplier.address}</small> : null}</div>
          <div className="supplier-card__contact">{supplier.email ? <a href={`mailto:${supplier.email}`}><Mail size={13} /> {supplier.email}</a> : <span>Pas d’e-mail</span>}{supplier.phone ? <a href={`tel:${supplier.phone}`}><Phone size={13} /> {supplier.phone}</a> : null}</div>
          <div className="supplier-card__terms"><span>Conditions</span><strong>{supplier.paymentTermsDays ? `${supplier.paymentTermsDays} jours` : 'Paiement immédiat'}</strong><small>{supplier.iban || 'IBAN non renseigné'}</small></div>
          <div className="supplier-card__actions"><Button variant="ghost" size="small" onClick={() => onEditSupplier(supplier)}><Pencil size={14} /> Modifier</Button>{supplier.archivedAt ? <Button variant="secondary" size="small" onClick={() => onRestoreSupplier(supplier)}><RotateCcw size={14} /> Réactiver</Button> : <Button variant="ghost" size="small" onClick={() => onArchiveSupplier(supplier)}><Archive size={14} /> Archiver</Button>}</div>
        </article>)}
      </div> : <EmptyState icon={<Building2 size={25} />} title={supplierVisibility === 'archived' ? 'Aucun fournisseur archivé' : 'Aucun fournisseur'} text={query.trim() ? 'Aucun fournisseur ne correspond à cette recherche.' : 'Ajoutez un fournisseur pour réutiliser ses coordonnées et ses conditions de paiement.'} actionLabel="Ajouter un fournisseur" onAction={onCreateSupplier} />
        : supplierInvoices.length || legacyExpenses.length ? <div className="table-panel purchase-table"><table><thead><tr><th>Document</th><th>Fournisseur</th><th>{terminology.singularTitle}</th><th>Échéance / paiement</th><th>Total / solde</th><th>Statut</th><th aria-label="Actions" /></tr></thead><tbody>
          {supplierInvoices.map((invoice) => {
            const project = workspace.projects.find((candidate) => candidate.id === invoice.projectId);
            const overdue = isSupplierInvoiceOverdue(invoice, today);
            const validationReason = !invoice.reference.trim() ? 'Ajoutez le numéro fournisseur avant validation.' : !supplierAccountingReady ? 'Configurez toutes les liaisons comptables, dont les dettes fournisseurs.' : '';
            return <tr key={`supplier-${invoice.id}`}><td>{formatDate(invoice.documentDate)}<small>{invoice.reference || 'Référence requise avant validation'}</small></td><td><strong>{invoice.supplierName}</strong><small>Facture fournisseur · {invoice.lines.length} ligne{invoice.lines.length > 1 ? 's' : ''} · {invoice.attachments.length} justificatif{invoice.attachments.length > 1 ? 's' : ''}</small></td><td>{project?.name || `Aucun ${terminology.singular}`}</td><td><strong className={overdue ? 'is-negative' : ''}>{formatDate(invoice.dueDate)}</strong>{invoice.paidCents > 0 ? <small>Payé {formatMoney(invoice.paidCents)}</small> : null}</td><td><strong>{formatMoney(invoice.totalCents)}</strong>{invoice.documentStatus === 'validated' ? <small>Solde {formatMoney(invoice.balanceCents)}</small> : <small>TVA {formatMoney(invoice.vatCents)}</small>}</td><td><StatusBadge status={overdue ? 'expired' : invoice.documentStatus === 'draft' ? 'draft' : invoice.paymentStatus === 'partial' ? 'partially_paid' : invoice.paymentStatus || 'draft'} label={overdue ? 'Échu' : undefined} /></td><td><div className="row-actions">{invoice.documentStatus === 'draft' ? <><Button variant="secondary" size="small" disabled={busy || Boolean(validationReason)} title={validationReason || 'Valider et comptabiliser'} onClick={() => onValidateSupplierInvoice(invoice)}><FileCheck2 size={14} /> Valider</Button><Button variant="ghost" size="icon" onClick={() => onEditSupplierInvoice(invoice)} title="Modifier le brouillon et ses justificatifs" aria-label={`Modifier la facture ${invoice.reference || invoice.supplierName}`}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onDeleteSupplierInvoiceDraft(invoice)} title="Supprimer le brouillon" aria-label={`Supprimer la facture ${invoice.reference || invoice.supplierName}`}><Trash2 size={15} /></Button></> : <><Button variant="ghost" size="small" onClick={() => onOpenSupplierInvoice(invoice)}><Eye size={14} /> Consulter</Button>{invoice.paymentStatus !== 'paid' ? <Button variant="secondary" size="small" disabled={busy || !supplierPaymentReady} title={supplierPaymentReady ? 'Enregistrer un règlement local' : 'Configurez le compte bancaire dans Plan & liaisons'} onClick={() => onRecordSupplierPayment(invoice)}><Banknote size={14} /> Paiement</Button> : null}</>}</div></td></tr>;
          })}
          {legacyExpenses.map((expense) => {
            const project = workspace.projects.find((candidate) => candidate.id === expense.projectId);
            const overdue = isExpenseOverdue(expense, today);
            return <tr key={`legacy-${expense.id}`}><td>{formatDate(expense.date)}<small>{expense.reference || 'Sans référence'}</small></td><td><strong>{expense.supplier || 'Fournisseur non renseigné'}</strong><small>Achat historique · montant saisi directement</small></td><td>{project?.name || `Aucun ${terminology.singular}`}</td><td><strong className={overdue ? 'is-negative' : ''}>{expense.paymentStatus === 'paid' && !expense.paidAt ? 'Date inconnue' : formatDate(expense.paymentStatus === 'pending' ? expense.dueDate : expense.paidAt)}</strong></td><td><strong>{formatMoney(expense.totalCents)}</strong><small>TVA {formatMoney(expense.vatCents)}</small></td><td><StatusBadge status={overdue ? 'expired' : expense.paymentStatus === 'paid' ? 'paid' : 'draft'} label={overdue ? 'Échu' : expense.paymentStatus === 'paid' ? 'Payé' : 'À payer'} /></td><td><div className="row-actions">{expense.paymentStatus === 'pending' ? <><Button variant="secondary" size="small" disabled={busy || !accountingEnabled} onClick={() => onMarkLegacyExpensePaid(expense)} title={accountingEnabled ? 'Marquer payé aujourd’hui et comptabiliser' : 'Activez d’abord la comptabilité'}><Banknote size={14} /> Marquer payé</Button><Button variant="ghost" size="icon" onClick={() => onEditLegacyExpense(expense)} title="Modifier" aria-label={`Modifier l’achat ${expense.supplier}`}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onArchiveLegacyExpense(expense)} title="Supprimer" aria-label={`Supprimer l’achat ${expense.supplier}`}><Archive size={15} /></Button></> : <Button variant="ghost" size="small" onClick={() => onOpenLegacyExpense(expense)}><Eye size={14} /> Consulter</Button>}</div></td></tr>;
          })}
        </tbody></table></div> : <EmptyState icon={tab === 'draft' ? <ReceiptText /> : tab === 'paid' ? <CheckCircle2 /> : <Clock3 />} title={query.trim() ? 'Aucun résultat' : tab === 'draft' ? 'Aucun brouillon' : tab === 'partial' ? 'Aucun paiement partiel' : tab === 'pending' ? 'Aucune facture à payer' : 'Aucune facture payée'} text={query.trim() ? 'Aucun achat ne correspond à cette recherche.' : invoiceBlockReason || (tab === 'draft' ? 'Créez une facture fournisseur, vérifiez-la, puis validez-la pour figer son écriture.' : 'Les documents réels apparaîtront ici au fil de leur traitement.')} actionLabel={invoiceBlockReason ? undefined : 'Créer une facture fournisseur'} onAction={invoiceBlockReason ? undefined : onCreateSupplierInvoice} />}
    </section>
  </div>;
}

export type SupplierInvoiceDraftLine = {
  id: string;
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceCents: number;
  discountBp: number;
  vatBp: number;
  category: string;
  expenseAccountId: string;
  projectId: string;
};

function newSupplierInvoiceLine(workspace: Workspace, projectId = ''): SupplierInvoiceDraftLine {
  const vatRates = workspace.settings!.organization.vatRegistered
    ? workspace.settings!.billing.vatRatesBp
    : [0];
  return {
    id: createId(),
    description: '',
    quantityMilli: 1_000,
    unit: 'unité',
    unitPriceCents: 0,
    discountBp: 0,
    vatBp: vatRates[0] ?? 0,
    category: workspace.settings!.work.costCategories[0] ?? '',
    expenseAccountId: '',
    projectId,
  };
}

export function supplierInvoiceLineTotals(line: SupplierInvoiceDraftLine) {
  const baseCents = Math.round((line.quantityMilli * line.unitPriceCents) / 1_000);
  const discountCents = Math.round((baseCents * line.discountBp) / 10_000);
  const netCents = Math.max(0, baseCents - discountCents);
  const vatCents = Math.round((netCents * line.vatBp) / 10_000);
  return { netCents, vatCents, totalCents: netCents + vatCents };
}

function supplierPaymentMethodLabel(method: string): string {
  return ({ bank_transfer: 'Virement bancaire', card: 'Carte', cash: 'Espèces', other: 'Autre' } as Record<string, string>)[method] ?? method;
}

export function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} o`;
  if (sizeBytes < 1_024 * 1_024) return `${(sizeBytes / 1_024).toLocaleString('fr-CH', { maximumFractionDigits: 1 })} Ko`;
  return `${(sizeBytes / (1_024 * 1_024)).toLocaleString('fr-CH', { maximumFractionDigits: 1 })} Mo`;
}

function attachmentTypeLabel(attachment: Attachment): string {
  return ({ 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP' } as Record<string, string>)[attachment.mimeType] ?? 'Document';
}

function SupplierInvoiceAttachments({ invoice, canEdit, busy, act }: { invoice?: SupplierInvoice; canEdit: boolean; busy: boolean; act?: ActionRunner }) {
  const [localError, setLocalError] = useState('');

  async function addAttachment() {
    if (!invoice || !act) return;
    setLocalError('');
    try {
      const sourcePath = await desktopApi.chooseSupplierInvoiceAttachment();
      if (!sourcePath) return;
      await act(
        () => desktopApi.addSupplierInvoiceAttachment(invoice.id, sourcePath),
        'Le justificatif a été copié et vérifié dans les données locales Zentra.',
        false,
      );
    } catch (reason) {
      setLocalError(errorMessage(reason, 'Le justificatif n’a pas pu être ajouté.'));
    }
  }

  async function openAttachment(attachment: Attachment) {
    setLocalError('');
    try {
      await desktopApi.openAttachment(attachment.id);
    } catch (reason) {
      setLocalError(errorMessage(reason, 'Le justificatif local n’a pas pu être ouvert.'));
    }
  }

  async function deleteAttachment(attachment: Attachment) {
    if (!invoice || !act || !window.confirm(`Supprimer le justificatif « ${attachment.originalName} » ?`)) return;
    await act(
      () => desktopApi.deleteSupplierInvoiceAttachment(attachment.id),
      'Le justificatif a été supprimé du stockage local.',
      false,
    );
  }

  return <section className="supplier-attachments">
    <header><div><strong><Paperclip size={16} /> Justificatifs</strong><small>PDF ou image · 25 Mio maximum · conservé uniquement sur cet ordinateur</small></div>{canEdit && invoice ? <Button type="button" variant="secondary" size="small" disabled={busy || invoice.attachments.length >= 20} onClick={() => void addAttachment()}><Upload size={14} /> Ajouter un justificatif</Button> : null}</header>
    {!invoice ? <div className="supplier-attachments__empty"><Paperclip size={20} /><span>Enregistrez d’abord le brouillon pour joindre le document original.</span></div> : invoice.attachments.length ? <div className="supplier-attachments__list">{invoice.attachments.map((attachment) => <article key={attachment.id}><span className="supplier-attachments__icon"><ReceiptText size={17} /></span><div><strong>{attachment.originalName}</strong><small>{attachmentTypeLabel(attachment)} · {formatAttachmentSize(attachment.sizeBytes)}</small><em title={attachment.sha256}>Empreinte SHA-256 vérifiée localement · {attachment.sha256.slice(0, 12)}…</em></div><div className="row-actions"><Button type="button" variant="ghost" size="small" onClick={() => void openAttachment(attachment)}><FolderOpen size={14} /> Ouvrir</Button>{canEdit ? <Button type="button" variant="ghost" size="icon" disabled={busy} onClick={() => void deleteAttachment(attachment)} title="Supprimer le justificatif" aria-label={`Supprimer ${attachment.originalName}`}><Trash2 size={15} /></Button> : null}</div></article>)}</div> : <div className="supplier-attachments__empty"><Paperclip size={20} /><span>Aucun justificatif joint.{canEdit ? ' Vous pourrez valider sans pièce après une confirmation explicite.' : ''}</span></div>}
    {invoice && invoice.attachments.length >= 20 && canEdit ? <div className="info-strip"><ShieldCheck size={16} /><span>La limite de 20 justificatifs pour cette facture est atteinte.</span></div> : null}
    {localError ? <p className="field-error" role="alert">{localError}</p> : null}
  </section>;
}

export function SupplierInvoiceForm({ item, workspace, busy, close, act }: { item?: SupplierInvoice; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const settings = workspace.settings!;
  const terminology = projectTerminology(settings.business.nogaSection);
  const supplierChoices = selectableSuppliers(workspace.suppliers, item?.supplierId);
  const initialSupplier = supplierChoices.find((supplier) => supplier.id === item?.supplierId) ?? supplierChoices[0];
  const [draftId] = useState(() => item?.id ?? createId());
  const [supplierId, setSupplierId] = useState(initialSupplier?.id ?? '');
  const [documentDate, setDocumentDate] = useState(item?.documentDate ?? todayIso());
  const [dueDate, setDueDate] = useState(item?.dueDate ?? supplierDueDate(todayIso(), initialSupplier, settings.billing.paymentTermsDays));
  const [projectId, setProjectId] = useState(item?.projectId ?? '');
  const [lines, setLines] = useState<SupplierInvoiceDraftLine[]>(() => item?.lines.length
    ? item.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantityMilli: line.quantityMilli,
      unit: line.unit,
      unitPriceCents: line.unitPriceCents,
      discountBp: line.discountBp,
      vatBp: line.vatBp,
      category: line.category,
      expenseAccountId: line.expenseAccountId ?? '',
      projectId: line.projectId ?? '',
    }))
    : [newSupplierInvoiceLine(workspace)]);
  const currentInvoice = workspace.supplierInvoices.find((invoice) => invoice.id === draftId);
  const vatRates = Array.from(new Set(settings.organization.vatRegistered ? [0, ...settings.billing.vatRatesBp] : [0]));
  const totals = lines.reduce((sum, line) => {
    const amount = supplierInvoiceLineTotals(line);
    return {
      netCents: sum.netCents + amount.netCents,
      vatCents: sum.vatCents + amount.vatCents,
      totalCents: sum.totalCents + amount.totalCents,
    };
  }, { netCents: 0, vatCents: 0, totalCents: 0 });

  function patchLine(id: string, patch: Partial<SupplierInvoiceDraftLine>) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line));
  }

  function chooseSupplier(nextId: string) {
    setSupplierId(nextId);
    const supplier = supplierChoices.find((candidate) => candidate.id === nextId);
    setDueDate(supplierDueDate(documentDate, supplier, settings.billing.paymentTermsDays));
  }

  return <Modal title={item ? 'Modifier le brouillon fournisseur' : 'Nouvelle facture fournisseur'} description="Enregistrez d’abord un brouillon. La validation comptable se fait ensuite, après votre contrôle." onClose={close} wide>
    <form onSubmit={submitForm(async (form) => {
      await act(
        () => desktopApi.saveSupplierInvoiceDraft({
          id: draftId,
          supplierId,
          projectId: projectId || null,
          date: documentDate,
          dueDate,
          reference: String(form.get('reference')).trim(),
          note: String(form.get('note')).trim(),
          items: lines.map((line) => ({
            id: line.id,
            description: line.description,
            quantityMilli: line.quantityMilli,
            unit: line.unit,
            unitPriceCents: line.unitPriceCents,
            discountBp: line.discountBp,
            vatBp: line.vatBp,
            category: line.category,
            expenseAccountId: line.expenseAccountId || null,
            projectId: line.projectId || null,
          })),
        }),
        item || currentInvoice ? 'Le brouillon fournisseur a été mis à jour.' : 'Le brouillon fournisseur a été enregistré. Vous pouvez maintenant joindre le document original.',
        false,
      );
    })}>
      <div className="form-grid">
        <Field label="Fournisseur" required wide><select value={supplierId} onChange={(event) => chooseSupplier(event.target.value)} required autoFocus><option value="">Choisir un fournisseur</option>{supplierChoices.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.archivedAt ? ' · archivé (historique)' : ''}</option>)}</select></Field>
        <Field label="Numéro / référence fournisseur" hint="Le brouillon peut être enregistré sans numéro; celui-ci devient obligatoire avant validation."><input name="reference" defaultValue={item?.reference} maxLength={200} /></Field>
        <Field label={terminology.singularTitle} hint="Facultatif; peut aussi être défini ligne par ligne."><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Aucun {terminology.singular}</option>{workspace.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
        <Field label="Date de facture" required><input type="date" value={documentDate} onChange={(event) => { const nextDate = event.target.value; setDocumentDate(nextDate); if (!item) { const supplier = supplierChoices.find((candidate) => candidate.id === supplierId); setDueDate(supplierDueDate(nextDate, supplier, settings.billing.paymentTermsDays)); } }} required /></Field>
        <Field label="Échéance" required><input type="date" min={documentDate} value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></Field>
        <Field label="Devise"><output className="field-output">CHF</output></Field>
      </div>

      <section className="supplier-invoice-lines">
        <header><div><strong>Lignes de la facture</strong><small>Les montants sont recalculés et recontrôlés localement lors de l’enregistrement.</small></div><Button type="button" variant="secondary" size="small" onClick={() => setLines((current) => [...current, newSupplierInvoiceLine(workspace)])}><Plus size={14} /> Ajouter une ligne</Button></header>
        <div className="supplier-invoice-lines__list">{lines.map((line, index) => {
          const amount = supplierInvoiceLineTotals(line);
          return <article className="supplier-invoice-line" key={line.id}>
            <div className="supplier-invoice-line__title"><strong>Ligne {index + 1}</strong><span>{formatMoney(amount.totalCents)}</span></div>
            <div className="supplier-invoice-line__grid">
              <Field label="Description" required wide><input value={line.description} onChange={(event) => patchLine(line.id, { description: event.target.value })} maxLength={1_000} required /></Field>
              <Field label="Quantité" required><input type="number" min="0.001" max="1000000" step="0.001" value={line.quantityMilli / 1_000} onChange={(event) => patchLine(line.id, { quantityMilli: Math.round(numberFromInput(event.target.value) * 1_000) })} required /></Field>
              <Field label="Unité" required><input value={line.unit} onChange={(event) => patchLine(line.id, { unit: event.target.value })} maxLength={50} required /></Field>
              <Field label="Prix unitaire net (CHF)" required><input type="number" min="0" step="0.01" value={line.unitPriceCents ? line.unitPriceCents / 100 : ''} onChange={(event) => patchLine(line.id, { unitPriceCents: centsFromInput(event.target.value) })} required /></Field>
              <Field label="Remise (%)"><input type="number" min="0" max="100" step="0.01" value={line.discountBp / 100} onChange={(event) => patchLine(line.id, { discountBp: Math.round(numberFromInput(event.target.value) * 100) })} /></Field>
              <Field label="TVA" required><select value={line.vatBp} onChange={(event) => patchLine(line.id, { vatBp: Number(event.target.value) })} required>{vatRates.map((rate) => <option key={rate} value={rate}>{(rate / 100).toLocaleString('fr-CH', { maximumFractionDigits: 2 })} %</option>)}</select></Field>
              <Field label="Catégorie" required><select value={line.category} onChange={(event) => patchLine(line.id, { category: event.target.value })} required><option value="">Choisir</option>{settings.work.costCategories.map((category) => <option key={category} value={category}>{category}</option>)}</select></Field>
              <Field label={terminology.singularTitle}><select value={line.projectId} onChange={(event) => patchLine(line.id, { projectId: event.target.value })}><option value="">Reprendre le document</option>{workspace.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
            </div>
            <div className="supplier-invoice-line__footer"><span>Net {formatMoney(amount.netCents)}</span><span>TVA {formatMoney(amount.vatCents)}</span>{lines.length > 1 ? <Button type="button" variant="ghost" size="small" onClick={() => setLines((current) => current.filter((candidate) => candidate.id !== line.id))}><Trash2 size={14} /> Retirer</Button> : null}</div>
          </article>;
        })}</div>
      </section>

      <div className="supplier-invoice-total"><div><span>Net</span><strong>{formatMoney(totals.netCents)}</strong></div><div><span>TVA</span><strong>{formatMoney(totals.vatCents)}</strong></div><div><span>Total TTC</span><strong>{formatMoney(totals.totalCents)}</strong></div></div>
      <div className="form-grid"><Field label="Note interne" wide><textarea name="note" rows={3} defaultValue={item?.note} maxLength={10_000} /></Field></div>
      <SupplierInvoiceAttachments invoice={currentInvoice} canEdit busy={busy} act={act} />
      <div className="info-strip"><ReceiptText size={17} /><span>Un brouillon reste modifiable et n’entre pas dans les comptes. Après validation, le document et ses montants seront figés.</span></div>
      <FormActions onCancel={close} busy={busy} disabled={!supplierId || totals.totalCents <= 0} submitLabel={currentInvoice ? 'Mettre à jour le brouillon' : 'Enregistrer le brouillon'} />
    </form>
  </Modal>;
}

export function SupplierInvoiceDetail({ invoice, workspace, busy, close, onPayment }: { invoice: SupplierInvoice; workspace: Workspace; busy: boolean; close: () => void; onPayment: () => void }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const currentInvoice = workspace.supplierInvoices.find((candidate) => candidate.id === invoice.id) ?? invoice;
  const project = workspace.projects.find((candidate) => candidate.id === currentInvoice.projectId);
  const paymentReady = Boolean(workspace.accountingSettings?.enabled && workspace.accountingSettings.bankAccountId);
  return <Modal title={`Facture fournisseur ${currentInvoice.reference || 'sans référence'}`} description="Document validé, justificatifs et historique des règlements conservés localement." onClose={close} wide>
    <div className="supplier-document-summary">
      <div><span>Fournisseur</span><strong>{currentInvoice.supplierName}</strong></div>
      <div><span>Date</span><strong>{formatDate(currentInvoice.documentDate)}</strong></div>
      <div><span>Échéance</span><strong>{formatDate(currentInvoice.dueDate)}</strong></div>
      <div><span>{terminology.singularTitle}</span><strong>{project?.name || `Aucun ${terminology.singular}`}</strong></div>
    </div>
    <div className="table-panel supplier-document-lines"><table><thead><tr><th>Description</th><th>Qté</th><th>Catégorie</th><th>Net</th><th>TVA</th><th>TTC</th></tr></thead><tbody>{currentInvoice.lines.map((line) => <tr key={line.id}><td><strong>{line.description}</strong><small>{line.unit}</small></td><td>{(line.quantityMilli / 1_000).toLocaleString('fr-CH')}</td><td>{line.category}</td><td>{formatMoney(line.netCents)}</td><td>{formatMoney(line.vatCents)}</td><td><strong>{formatMoney(line.totalCents)}</strong></td></tr>)}</tbody></table></div>
    <div className="supplier-invoice-total"><div><span>Total</span><strong>{formatMoney(currentInvoice.totalCents)}</strong></div><div><span>Déjà payé</span><strong>{formatMoney(currentInvoice.paidCents)}</strong></div><div><span>Solde</span><strong>{formatMoney(currentInvoice.balanceCents)}</strong></div></div>
    <SupplierInvoiceAttachments invoice={currentInvoice} canEdit={false} busy={busy} />
    <section className="supplier-payment-history"><header><strong>Historique des paiements</strong>{currentInvoice.paymentStatus !== 'paid' ? <Button size="small" disabled={!paymentReady} title={paymentReady ? 'Enregistrer un règlement local' : 'Configurez le compte bancaire dans Plan & liaisons'} onClick={onPayment}><Banknote size={14} /> Enregistrer un paiement</Button> : <StatusBadge status="paid" />}</header>{currentInvoice.payments.length ? <div>{currentInvoice.payments.map((payment) => <article key={payment.id}><div><strong>{formatMoney(payment.amountCents)}</strong><span>{formatDate(payment.date)}</span></div><small>{[supplierPaymentMethodLabel(payment.method), payment.reference].filter(Boolean).join(' · ') || 'Sans détail de paiement'}</small>{payment.notes ? <p>{payment.notes}</p> : null}</article>)}</div> : <EmptyState icon={<Banknote size={22} />} title="Aucun paiement" text="Le premier règlement apparaîtra ici avec sa date et sa référence." />}</section>
    {currentInvoice.note ? <div className="info-strip"><ReceiptText size={17} /><span>{currentInvoice.note}</span></div> : null}
    <div className="form-actions"><Button type="button" variant="secondary" onClick={close}>Fermer</Button></div>
  </Modal>;
}

export function SupplierPaymentForm({ invoice, busy, close, act }: { invoice: SupplierInvoice; busy: boolean; close: () => void; act: ActionRunner }) {
  const [requestId] = useState(() => createId());
  const [amountCents, setAmountCents] = useState(invoice.balanceCents);
  const defaultPaymentDate = todayIso() < invoice.documentDate ? invoice.documentDate : todayIso();
  return <Modal title="Enregistrer un paiement fournisseur" description={`Facture ${invoice.reference} · solde ${formatMoney(invoice.balanceCents)}`} onClose={close}>
    <form onSubmit={submitForm(async (form) => {
      await act(
        () => desktopApi.recordSupplierPayment({
          requestId,
          supplierInvoiceId: invoice.id,
          amountCents,
          date: String(form.get('date')),
          method: String(form.get('method')),
          reference: String(form.get('reference')).trim(),
          notes: String(form.get('notes')).trim(),
        }),
        amountCents === invoice.balanceCents ? 'La facture fournisseur est entièrement payée.' : 'Le paiement partiel a été enregistré.',
      );
    })}>
      <div className="payment-summary"><div><span>Total</span><strong>{formatMoney(invoice.totalCents)}</strong></div><div><span>Déjà payé</span><strong>{formatMoney(invoice.paidCents)}</strong></div><div><span>Solde disponible</span><strong>{formatMoney(invoice.balanceCents)}</strong></div></div>
      <div className="form-grid">
        <Field label="Montant payé (CHF)" required><input type="number" min="0.01" max={invoice.balanceCents / 100} step="0.01" value={amountCents / 100} onChange={(event) => setAmountCents(centsFromInput(event.target.value))} required autoFocus /></Field>
        <Field label="Date du paiement" required><input name="date" type="date" min={invoice.documentDate} defaultValue={defaultPaymentDate} required /></Field>
        <Field label="Mode de paiement" required><select name="method" defaultValue="bank_transfer" required><option value="bank_transfer">Virement bancaire</option><option value="card">Carte</option><option value="cash">Espèces</option><option value="other">Autre</option></select></Field>
        <Field label="Référence"><input name="reference" maxLength={200} /></Field>
        <Field label="Note" wide><textarea name="notes" rows={3} maxLength={2_000} /></Field>
      </div>
      <div className="info-strip"><WalletCards size={17} /><span>Zentra enregistre le règlement et l’écriture comptable ensemble. Aucun virement n’est envoyé à la banque.</span></div>
      <FormActions onCancel={close} busy={busy} disabled={amountCents <= 0 || amountCents > invoice.balanceCents} submitLabel={amountCents === invoice.balanceCents ? 'Enregistrer et solder' : 'Enregistrer le paiement partiel'} />
    </form>
  </Modal>;
}

export function LegacyExpenseDetail({ expense, workspace, close }: { expense: Expense; workspace: Workspace; close: () => void }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const project = workspace.projects.find((candidate) => candidate.id === expense.projectId);
  return <Modal title="Achat historique" description="Ancienne dépense conservée en lecture seule pour préserver l’historique." onClose={close}>
    <div className="supplier-document-summary">
      <div><span>Fournisseur</span><strong>{expense.supplier || 'Non renseigné'}</strong></div>
      <div><span>Date</span><strong>{formatDate(expense.date)}</strong></div>
      <div><span>Référence</span><strong>{expense.reference || '—'}</strong></div>
      <div><span>{terminology.singularTitle}</span><strong>{project?.name || `Aucun ${terminology.singular}`}</strong></div>
      <div><span>Catégorie</span><strong>{expense.category || 'Non classé'}</strong></div>
      <div><span>Paiement</span><strong>{expense.paidAt ? formatDate(expense.paidAt) : 'Date inconnue'}</strong></div>
    </div>
    <div className="supplier-invoice-total"><div><span>Net</span><strong>{formatMoney(expense.netCents)}</strong></div><div><span>TVA</span><strong>{formatMoney(expense.vatCents)}</strong></div><div><span>Total</span><strong>{formatMoney(expense.totalCents)}</strong></div></div>
    {expense.note ? <div className="info-strip"><ReceiptText size={17} /><span>{expense.note}</span></div> : null}
    <div className="form-actions"><Button type="button" variant="secondary" onClick={close}>Fermer</Button></div>
  </Modal>;
}

export function SupplierForm({ item, busy, close, act }: { item?: Supplier; busy: boolean; close: () => void; act: ActionRunner }) {
  return <Modal title={item ? `Modifier ${item.name}` : 'Nouveau fournisseur'} description="Ces coordonnées restent dans la base locale Zentra et servent à accélérer la saisie des achats." onClose={close} wide>
    <form onSubmit={submitForm(async (form) => {
      const data = {
        name: String(form.get('name')).trim(),
        contactName: String(form.get('contactName')).trim(),
        email: String(form.get('email')).trim(),
        phone: String(form.get('phone')).trim(),
        address: String(form.get('address')).trim(),
        uidNumber: String(form.get('uidNumber')).trim(),
        iban: String(form.get('iban')).trim(),
        currency: 'CHF',
        paymentTermsDays: Math.round(numberFromInput(form.get('paymentTermsDays'))),
        notes: String(form.get('notes')).trim(),
      };
      await act(
        () => item ? desktopApi.updateEntity('suppliers', item.id, data) : desktopApi.createEntity('suppliers', data),
        item ? 'Le fournisseur a été mis à jour.' : 'Le fournisseur a été ajouté.',
      );
    })}>
      <div className="form-grid">
        <Field label="Raison sociale / nom" required wide><input name="name" defaultValue={item?.name} maxLength={200} required autoFocus /></Field>
        <Field label="Personne de contact"><input name="contactName" defaultValue={item?.contactName} maxLength={200} /></Field>
        <Field label="E-mail"><input name="email" type="email" defaultValue={item?.email} maxLength={254} /></Field>
        <Field label="Téléphone"><input name="phone" type="tel" defaultValue={item?.phone} maxLength={80} /></Field>
        <Field label="Numéro IDE"><input name="uidNumber" defaultValue={item?.uidNumber} maxLength={80} /></Field>
        <Field label="Adresse" wide><textarea name="address" rows={3} defaultValue={item?.address} maxLength={1_000} /></Field>
        <Field label="IBAN CH / LI" hint="Facultatif; il n’est utilisé pour aucun paiement automatique."><input name="iban" defaultValue={item?.iban} autoCapitalize="characters" /></Field>
        <Field label="Devise"><output className="field-output">CHF</output></Field>
        <Field label="Délai de paiement (jours)" required><input name="paymentTermsDays" type="number" min="0" step="1" defaultValue={item?.paymentTermsDays ?? 30} required /></Field>
        <Field label="Notes internes" wide><textarea name="notes" rows={3} defaultValue={item?.notes} maxLength={10_000} /></Field>
      </div>
      {item?.archivedAt ? <div className="info-strip"><Archive size={17} /><span>Ce fournisseur est archivé. Il reste visible dans l’historique, mais n’est plus proposé pour les nouveaux achats.</span></div> : null}
      <FormActions onCancel={close} busy={busy} submitLabel={item ? 'Enregistrer les modifications' : 'Ajouter le fournisseur'} />
    </form>
  </Modal>;
}

export function ExpenseForm({ item, workspace, busy, close, act, onOpenAccounting }: { item?: Expense; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner; onOpenAccounting: () => void }) {
  const settings = workspace.settings!;
  const terminology = projectTerminology(settings.business.nogaSection);
  const linkedSupplier = item?.supplierId ? workspace.suppliers.find((supplier) => supplier.id === item.supplierId) : undefined;
  const supplierChoices = selectableSuppliers(workspace.suppliers, item?.supplierId);
  const initialDate = item?.date || todayIso();
  const initialStatus = item?.paymentStatus ?? 'pending';
  const [supplierChoice, setSupplierChoice] = useState(item?.supplierId && linkedSupplier ? item.supplierId : item?.supplier ? '__manual__' : '');
  const [manualSupplier, setManualSupplier] = useState(item?.supplier ?? '');
  const [expenseDate, setExpenseDate] = useState(initialDate);
  const [paymentStatus, setPaymentStatus] = useState<Expense['paymentStatus']>(initialStatus);
  const [dueDate, setDueDate] = useState(item?.dueDate ?? (initialStatus === 'pending' ? supplierDueDate(initialDate, linkedSupplier, settings.billing.paymentTermsDays) : ''));
  const [paidAt, setPaidAt] = useState(item?.paidAt ?? (initialStatus === 'paid' && !item ? todayIso() : ''));
  const [netCents, setNetCents] = useState(item?.netCents ?? 0);
  const [vatCents, setVatCents] = useState(item?.vatCents ?? 0);
  const legacyPaidWithoutDate = Boolean(item?.paymentStatus === 'paid' && !item.paidAt);
  const accountingEnabled = Boolean(workspace.accountingSettings?.enabled);
  const paidTransitionBlocked = paymentStatus === 'paid' && initialStatus !== 'paid' && !accountingEnabled;
  const expenseCategories = item?.category && !settings.work.costCategories.includes(item.category) ? [item.category, ...settings.work.costCategories] : settings.work.costCategories;

  function chooseSupplier(value: string) {
    setSupplierChoice(value);
    const supplier = supplierChoices.find((candidate) => candidate.id === value);
    if (supplier && paymentStatus === 'pending') setDueDate(supplierDueDate(expenseDate, supplier, settings.billing.paymentTermsDays));
  }

  function choosePaymentStatus(value: Expense['paymentStatus']) {
    setPaymentStatus(value);
    if (value === 'paid') setPaidAt((current) => current || todayIso());
    else {
      setPaidAt('');
      const supplier = supplierChoices.find((candidate) => candidate.id === supplierChoice);
      setDueDate((current) => current || supplierDueDate(expenseDate, supplier, settings.billing.paymentTermsDays));
    }
  }

  return <Modal title={item ? 'Modifier l’achat' : 'Nouvel achat'} description="Saisissez les montants réels. Le fournisseur, l’échéance et l’état de paiement restent explicites." onClose={close} wide>
    <form onSubmit={submitForm(async (form) => {
      const selectedSupplier = supplierChoices.find((supplier) => supplier.id === supplierChoice);
      const supplierSnapshot = supplierSnapshotForDraft(item, selectedSupplier, manualSupplier);
      if (!supplierSnapshot) return;
      const data = {
        projectId: String(form.get('projectId')) || null,
        supplierId: selectedSupplier?.id ?? null,
        date: expenseDate,
        dueDate: dueDate || null,
        supplier: supplierSnapshot,
        category: String(form.get('category')),
        reference: String(form.get('reference')).trim(),
        currency: 'CHF',
        netCents,
        vatCents,
        totalCents: netCents + vatCents,
        paymentStatus,
        paidAt: paymentStatus === 'paid' ? paidAt : null,
        reimbursable: form.get('reimbursable') === 'yes',
        note: String(form.get('note')).trim(),
      };
      await act(
        () => item ? desktopApi.updateEntity('expenses', item.id, data) : desktopApi.createEntity('expenses', data),
        item ? 'L’achat a été mis à jour.' : 'L’achat a été enregistré.',
      );
    })}>
      <div className="form-grid">
        <Field label="Fournisseur" required wide><select value={supplierChoice} onChange={(event) => chooseSupplier(event.target.value)} required autoFocus><option value="">Choisir un fournisseur</option>{supplierChoices.map((supplier) => <option value={supplier.id} key={supplier.id}>{supplier.name}{supplier.archivedAt ? ' · archivé (historique)' : ''}</option>)}<option value="__manual__">Saisie libre / fournisseur non enregistré</option></select></Field>
        {supplierChoice === '__manual__' ? <Field label="Nom du fournisseur à conserver" required wide hint="Ce texte restera le snapshot de cette dépense."><input value={manualSupplier} onChange={(event) => setManualSupplier(event.target.value)} maxLength={500} required /></Field> : null}
        <Field label={terminology.singularTitle} wide hint="Facultatif; lie l’achat à sa rentabilité."><select name="projectId" defaultValue={item?.projectId ?? ''}><option value="">Aucun {terminology.singular}</option>{workspace.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field>
        <Field label="Date de l’achat" required><input type="date" value={expenseDate} onChange={(event) => { const nextDate = event.target.value; setExpenseDate(nextDate); if (!item && paymentStatus === 'pending') { const supplier = supplierChoices.find((candidate) => candidate.id === supplierChoice); setDueDate(supplierDueDate(nextDate, supplier, settings.billing.paymentTermsDays)); } }} required /></Field>
        <Field label="État du paiement" required><select value={paymentStatus} onChange={(event) => choosePaymentStatus(event.target.value as Expense['paymentStatus'])} required><option value="pending">À payer</option><option value="paid" disabled={!accountingEnabled && initialStatus !== 'paid'}>Déjà payé{!accountingEnabled && initialStatus !== 'paid' ? ' · activez la comptabilité' : ''}</option></select></Field>
        {paymentStatus === 'pending' ? <Field label="Échéance" required><input type="date" min={expenseDate} value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></Field> : <Field label="Date de paiement" required={!legacyPaidWithoutDate} hint={legacyPaidWithoutDate ? 'Date inconnue sur cette ancienne dépense; laissez vide pour préserver l’historique.' : undefined}><input type="date" value={paidAt} onChange={(event) => setPaidAt(event.target.value)} required={!legacyPaidWithoutDate} /></Field>}
        <Field label="Catégorie" required><select name="category" defaultValue={item?.category} required><option value="">Choisir une catégorie</option>{expenseCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select></Field>
        <Field label="Référence"><input name="reference" defaultValue={item?.reference} maxLength={200} /></Field>
        <Field label="Remboursable ?" required><select name="reimbursable" defaultValue={item ? item.reimbursable ? 'yes' : 'no' : 'no'} required><option value="no">Non, charge de l’entreprise</option><option value="yes">Oui, à rembourser</option></select></Field>
        <Field label="Montant net (CHF)" required><input type="number" min="0" step="0.01" value={netCents ? netCents / 100 : ''} onChange={(event) => setNetCents(centsFromInput(event.target.value))} required /></Field>
        <Field label="Montant TVA (CHF)" required><input type="number" min="0" step="0.01" value={vatCents / 100} onChange={(event) => setVatCents(centsFromInput(event.target.value))} required /></Field>
        <Field label="Total calculé"><output className="field-output">{formatMoney(netCents + vatCents)}</output></Field>
        <Field label="Note" wide><textarea name="note" rows={3} defaultValue={item?.note} maxLength={2_000} /></Field>
      </div>
      {accountingEnabled ? <div className="info-strip"><WalletCards size={17} /><span>Un achat payé et son écriture comptable sont enregistrés ensemble, ou entièrement annulés en cas d’erreur. Aucun ordre bancaire n’est envoyé.</span></div> : <div className="report-callout is-warning"><WalletCards size={18} /><div><strong>Paiement protégé</strong><p>Enregistrez l’achat « À payer » ou activez d’abord la comptabilité pour créer paiement et écriture ensemble.</p></div><Button type="button" variant="secondary" onClick={onOpenAccounting}>Ouvrir Plan & liaisons</Button></div>}
      <FormActions onCancel={close} busy={busy} disabled={paidTransitionBlocked} submitLabel={item ? 'Enregistrer les modifications' : 'Enregistrer l’achat'} />
    </form>
  </Modal>;
}
