import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  FileCheck2,
  FilePenLine,
  FilePlus2,
  PackageCheck,
  Pencil,
  Plus,
  ReceiptText,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { SupplierEmailIntake } from './SupplierEmailIntake';
import { formatCatalogQuantity } from './catalog';
import {
  supplierInvoiceOrderMatchAmountMismatch,
  supplierOrderDisplayStatus,
  supplierOrderLineMatchableMilli,
  supplierOrderLineProgress,
  supplierOrderNextAction,
  supplierOrderProgress,
  supplierReceiptDateValidationError,
  supplierThreeWayMatchStatus,
} from './purchaseOrderFlow';
import type {
  Account,
  CatalogItem,
  Expense,
  Supplier,
  SupplierCreditAllocation,
  SupplierCreditNote,
  SupplierInvoice,
  SupplierOrder,
  SupplierOrderFulfillmentMode,
  SupplierReceipt,
  Workspace,
} from './types';
import {
  createId,
  errorMessage,
  formatDate,
  formatMoney,
  todayIso,
} from './utils';
import {
  Button,
  EmptyState,
  ErrorPanel,
  Field,
  FormActions,
  Modal,
  SectionHeading,
  StatusBadge,
} from './ui';

type PurchaseWorkspaceAction = (
  action: () => Promise<Workspace>,
  successMessage: string,
  close?: boolean,
) => Promise<boolean>;

type PurchaseSection =
  | 'inbox'
  | 'orders'
  | 'receipts'
  | 'documents'
  | 'suppliers';

type PurchaseModal =
  | { type: 'order'; order?: SupplierOrder }
  | { type: 'confirm_order'; order: SupplierOrder }
  | { type: 'cancel_remainder'; order: SupplierOrder }
  | { type: 'receipt'; order: SupplierOrder; receipt?: SupplierReceipt }
  | { type: 'issue_receipt'; receipt: SupplierReceipt }
  | { type: 'reverse_receipt'; receipt: SupplierReceipt }
  | { type: 'match'; order: SupplierOrder; invoice?: SupplierInvoice }
  | { type: 'credit'; invoice?: SupplierInvoice; credit?: SupplierCreditNote }
  | { type: 'validate_credit'; credit: SupplierCreditNote }
  | { type: 'apply_credit'; credit: SupplierCreditNote }
  | {
      type: 'reverse_credit';
      credit: SupplierCreditNote;
      allocation: SupplierCreditAllocation;
    }
  | { type: 'reclassify'; invoice: SupplierInvoice }
  | null;

type OrderDraftLine = {
  id: string;
  catalogItemId: string;
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceCents: number;
  discountBp: number;
  vatBp: number;
  category: string;
  expenseAccountId: string;
  projectId: string;
  fulfillmentMode: SupplierOrderFulfillmentMode;
};

type CreditDraftLine = Omit<
  OrderDraftLine,
  'fulfillmentMode' | 'catalogItemId'
>;

const sectionLabels: Array<{
  id: PurchaseSection;
  label: string;
  icon: typeof ClipboardCheck;
}> = [
  { id: 'inbox', label: 'À traiter', icon: ClipboardCheck },
  { id: 'orders', label: 'Commandes', icon: FilePenLine },
  { id: 'receipts', label: 'Réceptions', icon: PackageCheck },
  { id: 'documents', label: 'Factures & avoirs', icon: ReceiptText },
  { id: 'suppliers', label: 'Fournisseurs', icon: Building2 },
];

function includesQuery(
  query: string,
  values: Array<string | null | undefined>,
) {
  const needle = query.trim().toLocaleLowerCase('fr-CH');
  if (!needle) return true;
  return values.some((value) =>
    (value ?? '').toLocaleLowerCase('fr-CH').includes(needle),
  );
}

function milliFromNumber(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 1_000)) : 0;
}

function centsFromNumber(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function basisPointsFromNumber(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

export function supplierDraftLineTotals(line: {
  quantityMilli: number;
  unitPriceCents: number;
  discountBp: number;
  vatBp: number;
}) {
  const grossCents = Math.round(
    (line.quantityMilli * line.unitPriceCents) / 1_000,
  );
  const discountCents = Math.round((grossCents * line.discountBp) / 10_000);
  const netCents = grossCents - discountCents;
  const vatCents = Math.round((netCents * line.vatBp) / 10_000);
  return {
    grossCents,
    discountCents,
    netCents,
    vatCents,
    totalCents: netCents + vatCents,
  };
}

export function allocateSupplierReceiptQuantity(
  quantityMilli: number,
  receiptLines: Array<{ id: string; quantityMilli: number }>,
  existingAllocations: Array<{
    supplierReceiptLineId: string | null;
    quantityMilli: number;
  }>,
) {
  let remainingMilli = Math.max(0, Math.trunc(quantityMilli));
  const allocations: Array<{
    supplierReceiptLineId: string;
    quantityMilli: number;
  }> = [];
  for (const receiptLine of receiptLines) {
    if (remainingMilli === 0) break;
    const alreadyAllocatedMilli = existingAllocations
      .filter(
        (allocation) => allocation.supplierReceiptLineId === receiptLine.id,
      )
      .reduce((total, allocation) => total + allocation.quantityMilli, 0);
    const availableMilli = Math.max(
      0,
      receiptLine.quantityMilli - alreadyAllocatedMilli,
    );
    const allocatedMilli = Math.min(remainingMilli, availableMilli);
    if (allocatedMilli > 0) {
      allocations.push({
        supplierReceiptLineId: receiptLine.id,
        quantityMilli: allocatedMilli,
      });
      remainingMilli -= allocatedMilli;
    }
  }
  return { allocations, remainingMilli };
}

export function receiptAllocationUsageOutsideInvoice(
  allocations: Array<{
    supplierInvoiceId: string;
    supplierReceiptLineId: string | null;
    quantityMilli: number;
  }>,
  replacedInvoiceId: string,
) {
  return allocations
    .filter((allocation) => allocation.supplierInvoiceId !== replacedInvoiceId)
    .map((allocation) => ({
      supplierReceiptLineId: allocation.supplierReceiptLineId,
      quantityMilli: allocation.quantityMilli,
    }));
}

export function existingInvoiceItemMatchDraft(
  allocations: Array<{
    supplierInvoiceId: string;
    supplierInvoiceItemId: string;
    supplierOrderId: string;
    supplierOrderLineId: string;
    quantityMilli: number;
  }>,
  supplierInvoiceId: string,
  supplierInvoiceItemId: string,
  supplierOrderId: string,
) {
  const matches = allocations.filter(
    (match) =>
      match.supplierInvoiceId === supplierInvoiceId &&
      match.supplierInvoiceItemId === supplierInvoiceItemId &&
      match.supplierOrderId === supplierOrderId,
  );
  const lineIds = new Set(matches.map((match) => match.supplierOrderLineId));
  if (!matches.length || lineIds.size !== 1) return null;
  return {
    supplierOrderLineId: matches[0].supplierOrderLineId,
    quantityMilli: matches.reduce(
      (total, match) => total + match.quantityMilli,
      0,
    ),
  };
}

export function existingInvoiceItemMultiOrderMatchDraft(
  allocations: Array<{
    supplierInvoiceId: string;
    supplierInvoiceItemId: string;
    supplierOrderId: string;
    supplierOrderLineId: string;
    quantityMilli: number;
  }>,
  supplierInvoiceId: string,
  supplierInvoiceItemId: string,
) {
  const matches = allocations.filter(
    (match) =>
      match.supplierInvoiceId === supplierInvoiceId &&
      match.supplierInvoiceItemId === supplierInvoiceItemId,
  );
  const links = new Set(
    matches.map(
      (match) => `${match.supplierOrderId}\0${match.supplierOrderLineId}`,
    ),
  );
  if (!matches.length || links.size !== 1) return null;
  return {
    supplierOrderId: matches[0].supplierOrderId,
    supplierOrderLineId: matches[0].supplierOrderLineId,
    quantityMilli: matches.reduce(
      (total, match) => total + match.quantityMilli,
      0,
    ),
  };
}

export function invoiceItemHasMultipleOrderLineMatches(
  allocations: Array<{
    supplierInvoiceId: string;
    supplierInvoiceItemId: string;
    supplierOrderId: string;
    supplierOrderLineId: string;
  }>,
  supplierInvoiceId: string,
  supplierInvoiceItemId: string,
) {
  return (
    new Set(
      allocations
        .filter(
          (match) =>
            match.supplierInvoiceId === supplierInvoiceId &&
            match.supplierInvoiceItemId === supplierInvoiceItemId,
        )
        .map((match) =>
          JSON.stringify([
            match.supplierOrderId,
            match.supplierOrderLineId,
          ]),
        ),
    ).size > 1
  );
}

export function supplierInvoiceMatchPreviewAmountDifference(
  invoice: SupplierInvoice,
  orders: SupplierOrder[],
  allocations: Array<{
    supplierInvoiceItemId: string;
    supplierOrderId?: string;
    supplierOrderLineId: string;
    quantityMilli: number;
  }>,
  fallbackOrderId: string,
) {
  const invoiceItemById = new Map(invoice.lines.map((item) => [item.id, item]));
  const orderLineById = new Map(
    orders.flatMap((order) =>
      order.lines.map((line) => [
        JSON.stringify([order.id, line.id]),
        line,
      ] as const),
    ),
  );
  const quantityByInvoiceItem = new Map<string, number>();
  let expectedNetCents = 0;
  let expectedVatCents = 0;
  let expectedTotalCents = 0;
  let invalid = false;
  for (const allocation of allocations) {
    const item = invoiceItemById.get(allocation.supplierInvoiceItemId);
    const orderId = allocation.supplierOrderId || fallbackOrderId;
    const line = orderLineById.get(
      JSON.stringify([orderId, allocation.supplierOrderLineId]),
    );
    if (!item || !line || allocation.quantityMilli <= 0) {
      invalid = true;
      continue;
    }
    quantityByInvoiceItem.set(
      item.id,
      (quantityByInvoiceItem.get(item.id) || 0) + allocation.quantityMilli,
    );
    expectedNetCents += Math.round(
      (line.lineNetCents * allocation.quantityMilli) / line.quantityMilli,
    );
    expectedVatCents += Math.round(
      (line.lineVatCents * allocation.quantityMilli) / line.quantityMilli,
    );
    expectedTotalCents += Math.round(
      (line.lineTotalCents * allocation.quantityMilli) / line.quantityMilli,
    );
  }
  let actualNetCents = 0;
  let actualVatCents = 0;
  let actualTotalCents = 0;
  for (const [itemId, quantityMilli] of quantityByInvoiceItem) {
    const item = invoiceItemById.get(itemId);
    if (!item || item.quantityMilli <= 0 || quantityMilli > item.quantityMilli) {
      invalid = true;
      continue;
    }
    const allocatedNetCents = Math.round(
      (item.netCents * quantityMilli) / item.quantityMilli,
    );
    const allocatedVatCents = Math.round(
      (item.vatCents * quantityMilli) / item.quantityMilli,
    );
    actualNetCents += allocatedNetCents;
    actualVatCents += allocatedVatCents;
    actualTotalCents += allocatedNetCents + allocatedVatCents;
  }
  return {
    invalid,
    netCents: actualNetCents - expectedNetCents,
    vatCents: actualVatCents - expectedVatCents,
    totalCents: actualTotalCents - expectedTotalCents,
  };
}

export function supplierOrderLineLinkValue(
  supplierOrderId: string,
  supplierOrderLineId: string,
) {
  return JSON.stringify([supplierOrderId, supplierOrderLineId]);
}

export function parseSupplierOrderLineLink(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      !parsed[0] ||
      !parsed[1]
    )
      return null;
    return { supplierOrderId: parsed[0], supplierOrderLineId: parsed[1] };
  } catch {
    return null;
  }
}

export function replacementMatchableQuantity(
  baseMatchableMilli: number,
  currentInvoiceMatchedMilli: number,
  effectiveQuantityMilli: number,
  receivedQuantityMilli: number,
  fulfillmentMode: SupplierOrderFulfillmentMode,
) {
  const capacity =
    fulfillmentMode === 'direct'
      ? effectiveQuantityMilli
      : Math.min(effectiveQuantityMilli, receivedQuantityMilli);
  return Math.max(
    0,
    Math.min(capacity, baseMatchableMilli + currentInvoiceMatchedMilli),
  );
}

function orderDraftTotals(lines: OrderDraftLine[] | CreditDraftLine[]) {
  return lines.reduce(
    (totals, line) => {
      const next = supplierDraftLineTotals(line);
      return {
        netCents: totals.netCents + next.netCents,
        vatCents: totals.vatCents + next.vatCents,
        totalCents: totals.totalCents + next.totalCents,
      };
    },
    { netCents: 0, vatCents: 0, totalCents: 0 },
  );
}

export function purchaseVatOptions(
  vatRegistered: boolean,
  configuredRatesBp: number[],
) {
  if (!vatRegistered) return [0];
  const rates = configuredRatesBp.filter(
    (rate) => Number.isInteger(rate) && rate >= 0 && rate <= 10_000,
  );
  return [...new Set(rates.length ? rates : [0])];
}

function emptyOrderLine(workspace: Workspace, projectId = ''): OrderDraftLine {
  const vatRates = purchaseVatOptions(
    Boolean(workspace.settings?.organization.vatRegistered),
    workspace.settings?.billing.vatRatesBp || [],
  );
  return {
    id: createId(),
    catalogItemId: '',
    description: '',
    quantityMilli: 1_000,
    unit: 'unité',
    unitPriceCents: 0,
    discountBp: 0,
    vatBp: vatRates[0] || 0,
    category: workspace.settings?.work.costCategories[0] || 'Achats',
    expenseAccountId: workspace.accountingSettings?.expenseAccountId || '',
    projectId,
    fulfillmentMode: 'untracked_receipt',
  };
}

function emptyCreditLine(workspace: Workspace): CreditDraftLine {
  const {
    catalogItemId: _catalogItemId,
    fulfillmentMode: _mode,
    ...line
  } = emptyOrderLine(workspace);
  return line;
}

function supplierName(workspace: Workspace, supplierId: string) {
  return (
    workspace.suppliers.find((supplier) => supplier.id === supplierId)?.name ||
    'Fournisseur inconnu'
  );
}

function orderName(order: SupplierOrder) {
  return order.number || order.title || 'Commande brouillon';
}

function receiptName(receipt: SupplierReceipt) {
  return receipt.number || 'Réception brouillon';
}

function nextActionLabel(action: ReturnType<typeof supplierOrderNextAction>) {
  if (action === 'confirm') return 'Contrôler et confirmer';
  if (action === 'issue_receipt') return 'Contrôler la réception';
  if (action === 'create_receipt') return 'Saisir la réception';
  if (action === 'match_invoice') return 'Rapprocher une facture';
  return '';
}

function invoiceMatchLabel(invoice: SupplierInvoice) {
  if (invoice.matchStatus === 'matched') return 'Rapprochée';
  if (invoice.matchStatus === 'partial') return 'Partiellement rapprochée';
  if (invoice.matchStatus === 'mismatch') return 'Écart à corriger';
  return 'À rapprocher';
}

export function supplierInvoiceNeedsAttention(
  invoice: Pick<
    SupplierInvoice,
    'id' | 'documentStatus' | 'matchStatus' | 'paymentStatus' | 'dueDate'
  >,
  matches: Array<
    Pick<
      Workspace['supplierInvoiceMatches'][number],
      'supplierInvoiceId' | 'supplierOrderId'
    >
  >,
  orders: Array<Pick<SupplierOrder, 'id' | 'status'>>,
  today: string,
) {
  const invoiceMatches = matches.filter(
    (match) => match.supplierInvoiceId === invoice.id,
  );
  const linkedOrderIds = [
    ...new Set(invoiceMatches.map((match) => match.supplierOrderId)),
  ];
  const everyLinkedOrderIsClosed =
    linkedOrderIds.length > 0 &&
    linkedOrderIds.every(
      (orderId) =>
        orders.find((order) => order.id === orderId)?.status === 'closed',
    );
  return (
    invoice.documentStatus === 'draft' ||
    (invoiceMatches.length > 0 && invoice.matchStatus === 'mismatch') ||
    (invoiceMatches.length > 0 &&
      invoice.matchStatus === 'partial' &&
      !everyLinkedOrderIsClosed) ||
    (invoice.documentStatus === 'validated' &&
      invoice.paymentStatus !== 'paid' &&
      invoice.dueDate < today)
  );
}

export function nextMatchClearConfirmation(
  event: 'request' | 'selection-change',
) {
  return event === 'request';
}

export function PurchaseOrdersScreen({
  workspace,
  query,
  onQueryChange,
  busy,
  readOnly,
  runAction,
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
  onQueryChange: (value: string) => void;
  busy: boolean;
  readOnly: boolean;
  runAction: PurchaseWorkspaceAction;
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
  const [section, setSection] = useState<PurchaseSection>('inbox');
  const [modal, setModal] = useState<PurchaseModal>(null);
  const today = todayIso();
  const activeSuppliers = workspace.suppliers.filter(
    (supplier) => !supplier.archivedAt,
  );
  const orders = workspace.supplierOrders.filter((order) =>
    includesQuery(query, [
      order.number,
      order.title,
      supplierName(workspace, order.supplierId),
    ]),
  );
  const receipts = workspace.supplierReceipts.filter((receipt) => {
    const order = workspace.supplierOrders.find(
      (candidate) => candidate.id === receipt.supplierOrderId,
    );
    return includesQuery(query, [
      receipt.number,
      receipt.reference,
      order?.number,
      order ? supplierName(workspace, order.supplierId) : '',
    ]);
  });
  const invoices = workspace.supplierInvoices.filter((invoice) =>
    includesQuery(query, [invoice.reference, invoice.supplierName]),
  );
  const credits = workspace.supplierCreditNotes.filter((credit) =>
    includesQuery(query, [
      credit.number,
      credit.reference,
      credit.supplierName,
    ]),
  );
  const suppliers = workspace.suppliers.filter((supplier) =>
    includesQuery(query, [
      supplier.name,
      supplier.contactName,
      supplier.email,
      supplier.uidNumber,
      supplier.iban,
    ]),
  );
  const actionableOrders = workspace.supplierOrders.filter(
    (order) => supplierOrderNextAction(order, workspace) !== 'none',
  );
  const documentActions = workspace.supplierInvoices.filter((invoice) =>
    supplierInvoiceNeedsAttention(
      invoice,
      workspace.supplierInvoiceMatches,
      workspace.supplierOrders,
      today,
    ),
  );
  const draftCredits = workspace.supplierCreditNotes.filter(
    (credit) => credit.status === 'draft',
  );
  const inboxCount =
    actionableOrders.length + documentActions.length + draftCredits.length;
  const receiptDraftCount = workspace.supplierReceipts.filter(
    (receipt) => receipt.status === 'draft',
  ).length;
  const unpaidCents = workspace.supplierInvoices.reduce(
    (total, invoice) =>
      total +
      (invoice.documentStatus === 'validated' ? invoice.balanceCents : 0),
    0,
  );
  const accountingReady = Boolean(
    workspace.accountingSettings?.enabled &&
    workspace.accountingSettings.supplierPayableAccountId &&
    workspace.accountingSettings.expenseAccountId &&
    workspace.accountingSettings.vatReceivableAccountId,
  );

  function openNextAction(order: SupplierOrder) {
    const action = supplierOrderNextAction(order, workspace);
    if (action === 'confirm') setModal({ type: 'confirm_order', order });
    if (action === 'create_receipt') setModal({ type: 'receipt', order });
    if (action === 'issue_receipt') {
      const receipt = workspace.supplierReceipts.find(
        (candidate) =>
          candidate.supplierOrderId === order.id &&
          candidate.status === 'draft',
      );
      if (receipt) setModal({ type: 'issue_receipt', receipt });
    }
    if (action === 'match_invoice') {
      const draftInvoice = workspace.supplierInvoices.find(
        (invoice) =>
          invoice.supplierId === order.supplierId &&
          invoice.documentStatus === 'draft' &&
          invoice.matchStatus !== 'matched',
      );
      if (draftInvoice)
        setModal({ type: 'match', order, invoice: draftInvoice });
      else onCreateSupplierInvoice();
    }
  }

  async function completeLocalAction(
    action: () => Promise<Workspace>,
    message: string,
  ) {
    if (await runAction(action, message, false)) setModal(null);
  }

  const sectionCount = (id: PurchaseSection) => {
    if (id === 'inbox') return inboxCount;
    if (id === 'orders') return workspace.supplierOrders.length;
    if (id === 'receipts') return workspace.supplierReceipts.length;
    if (id === 'documents')
      return (
        workspace.supplierInvoices.length + workspace.supplierCreditNotes.length
      );
    return activeSuppliers.length;
  };

  const primaryAction =
    section === 'orders' || section === 'inbox' ? (
      <Button
        disabled={busy || readOnly || !activeSuppliers.length}
        title={
          activeSuppliers.length
            ? 'Créer une commande fournisseur'
            : 'Ajoutez d’abord un fournisseur actif.'
        }
        onClick={() => setModal({ type: 'order' })}
      >
        <Plus size={16} /> Nouvelle commande
      </Button>
    ) : section === 'documents' ? (
      <div className="purchase-workflow__header-actions">
        <Button
          variant="secondary"
          disabled={busy || readOnly || !activeSuppliers.length}
          onClick={() => setModal({ type: 'credit' })}
        >
          <FilePlus2 size={16} /> Nouvel avoir
        </Button>
        <Button disabled={busy || readOnly} onClick={onCreateSupplierInvoice}>
          <Plus size={16} /> Nouvelle facture
        </Button>
      </div>
    ) : section === 'suppliers' ? (
      <Button disabled={busy || readOnly} onClick={onCreateSupplier}>
        <Plus size={16} /> Nouveau fournisseur
      </Button>
    ) : null;

  return (
    <div className="stack-layout purchase-workflow">
      <div
        className="purchase-workflow__summary"
        aria-label="Résumé des achats fournisseurs"
      >
        <div>
          <span>À traiter</span>
          <strong>{inboxCount}</strong>
          <small>prochaine action claire</small>
        </div>
        <div>
          <span>Commandes actives</span>
          <strong>
            {
              workspace.supplierOrders.filter(
                (order) => order.status === 'confirmed',
              ).length
            }
          </strong>
          <small>hors brouillons et clôturées</small>
        </div>
        <div>
          <span>Réceptions à émettre</span>
          <strong>{receiptDraftCount}</strong>
          <small>le stock ne bouge qu’à l’émission</small>
        </div>
        <div>
          <span>Solde fournisseurs</span>
          <strong>{formatMoney(unpaidCents)}</strong>
          <small>factures moins paiements et avoirs</small>
        </div>
      </div>

      {!accountingReady &&
      (workspace.supplierInvoices.length ||
        workspace.supplierCreditNotes.length) ? (
        <div className="report-callout is-warning">
          <ShieldCheck size={20} />
          <div>
            <strong>Comptabilité fournisseurs à terminer</strong>
            <p>
              Les brouillons restent accessibles, mais la validation, les avoirs
              et les corrections d’imputation exigent les comptes de charges, de
              TVA préalable et de dettes fournisseurs.
            </p>
          </div>
          <Button variant="secondary" onClick={onOpenAccounting}>
            Ouvrir Plan & liaisons
          </Button>
        </div>
      ) : null}

      <section className="panel purchase-workflow__panel">
        <SectionHeading
          eyebrow="Cycle fournisseur local"
          title="Achats & fournisseurs"
          description="Commandes, réceptions, factures et paiements réunis au même endroit."
          action={primaryAction}
        />
        <div className="purchase-workflow__toolbar">
          <label className="purchase-workflow__mobile-section">
            <span>Section des achats</span>
            <select aria-label="Section des achats" value={section} onChange={(event) => setSection(event.target.value as PurchaseSection)}>
              {sectionLabels.map(({ id, label }) => <option key={id} value={id}>{label} ({sectionCount(id)})</option>)}
            </select>
          </label>
          <div
            className="purchase-workflow__tabs"
            role="tablist"
            aria-label="Sections des achats fournisseurs"
          >
            {sectionLabels.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                id={`purchase-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={section === id}
                aria-controls="purchase-panel"
                tabIndex={section === id ? 0 : -1}
                className={section === id ? 'is-active' : ''}
                onClick={() => setSection(id)}
                onKeyDown={(event) => {
                  const currentIndex = sectionLabels.findIndex(
                    (item) => item.id === id,
                  );
                  let nextIndex = currentIndex;
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
                    nextIndex = (currentIndex + 1) % sectionLabels.length;
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
                    nextIndex =
                      (currentIndex - 1 + sectionLabels.length) %
                      sectionLabels.length;
                  if (event.key === 'Home') nextIndex = 0;
                  if (event.key === 'End') nextIndex = sectionLabels.length - 1;
                  const isNavigationKey = [
                    'ArrowRight',
                    'ArrowDown',
                    'ArrowLeft',
                    'ArrowUp',
                    'Home',
                    'End',
                  ].includes(event.key);
                  if (!isNavigationKey) return;
                  event.preventDefault();
                  if (nextIndex === currentIndex) return;
                  const nextSection = sectionLabels[nextIndex].id;
                  setSection(nextSection);
                  requestAnimationFrame(() =>
                    document
                      .getElementById(`purchase-tab-${nextSection}`)
                      ?.focus(),
                  );
                }}
              >
                <Icon size={16} /> <span>{label}</span>
                <em>{sectionCount(id)}</em>
              </button>
            ))}
          </div>
          <label className="purchase-search">
            <Search size={15} />
            <span className="sr-only">Rechercher dans les achats</span>
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="N°, fournisseur, référence…"
            />
          </label>
        </div>

        <div
          id="purchase-panel"
          role="tabpanel"
          aria-labelledby={`purchase-tab-${section}`}
        >
          {section === 'inbox' ? (
            <>
              <SupplierEmailIntake
                workspace={workspace}
                busy={busy}
                readOnly={readOnly}
                runAction={runAction}
              />
              <PurchaseInbox
                workspace={workspace}
                orders={actionableOrders.filter((order) =>
                  includesQuery(query, [
                    order.number,
                    order.title,
                    supplierName(workspace, order.supplierId),
                  ]),
                )}
                invoices={documentActions.filter((invoice) =>
                  includesQuery(query, [invoice.reference, invoice.supplierName]),
                )}
                credits={draftCredits.filter((credit) =>
                  includesQuery(query, [
                    credit.number,
                    credit.reference,
                    credit.supplierName,
                  ]),
                )}
                busy={busy || readOnly}
                accountingReady={accountingReady}
                onNext={openNextAction}
                onOpenInvoice={onOpenSupplierInvoice}
                onValidateInvoice={onValidateSupplierInvoice}
                onMatchInvoice={(invoice, order) =>
                  setModal({ type: 'match', invoice, order })
                }
                onValidateCredit={(credit) =>
                  setModal({ type: 'validate_credit', credit })
                }
                onCreateOrder={() => setModal({ type: 'order' })}
              />
            </>
          ) : null}

          {section === 'orders' ? (
            orders.length ? (
              <div className="purchase-order-list" role="list">
                {orders.map((order) => (
                  <SupplierOrderCard
                    key={order.id}
                    order={order}
                    workspace={workspace}
                    busy={busy || readOnly}
                    onNext={() => openNextAction(order)}
                    onEdit={() => setModal({ type: 'order', order })}
                    onCancelRemainder={() =>
                      setModal({ type: 'cancel_remainder', order })
                    }
                    onMatchInvoice={(invoice) =>
                      setModal({ type: 'match', order, invoice })
                    }
                    onOpenInvoice={onOpenSupplierInvoice}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<FilePenLine />}
                title={
                  query.trim()
                    ? 'Aucune commande trouvée'
                    : 'Aucune commande fournisseur'
                }
                text={
                  query.trim()
                    ? 'Modifiez votre recherche.'
                    : activeSuppliers.length
                      ? 'Créez un brouillon, contrôlez ses lignes, puis confirmez-le.'
                      : 'Ajoutez d’abord un fournisseur actif.'
                }
                actionLabel={
                  activeSuppliers.length
                    ? 'Créer une commande'
                    : 'Ajouter un fournisseur'
                }
                onAction={
                  activeSuppliers.length
                    ? () => setModal({ type: 'order' })
                    : onCreateSupplier
                }
                disabled={busy || readOnly}
              />
            )
          ) : null}

          {section === 'receipts' ? (
            <ReceiptsSection
              workspace={workspace}
              receipts={receipts}
              busy={busy || readOnly}
              onEdit={(receipt, order) =>
                setModal({ type: 'receipt', receipt, order })
              }
              onIssue={(receipt) =>
                setModal({ type: 'issue_receipt', receipt })
              }
              onReverse={(receipt) =>
                setModal({ type: 'reverse_receipt', receipt })
              }
            />
          ) : null}

          {section === 'documents' ? (
            <DocumentsSection
              workspace={workspace}
              invoices={invoices}
              credits={credits}
              expenses={workspace.expenses.filter((expense) =>
                includesQuery(query, [expense.reference, expense.supplier]),
              )}
              busy={busy || readOnly}
              accountingReady={accountingReady}
              onOpenInvoice={onOpenSupplierInvoice}
              onEditInvoice={onEditSupplierInvoice}
              onValidateInvoice={onValidateSupplierInvoice}
              onDeleteInvoice={onDeleteSupplierInvoiceDraft}
              onPayInvoice={onRecordSupplierPayment}
              onMatch={(invoice, order) =>
                setModal({ type: 'match', invoice, order })
              }
              onCredit={(invoice) => setModal({ type: 'credit', invoice })}
              onEditCredit={(credit) => setModal({ type: 'credit', credit })}
              onValidateCredit={(credit) =>
                setModal({ type: 'validate_credit', credit })
              }
              onDeleteCredit={(credit) =>
                void completeLocalAction(
                  () => desktopApi.deleteSupplierCreditNoteDraft(credit.id),
                  'Le brouillon d’avoir a été supprimé.',
                )
              }
              onApplyCredit={(credit) =>
                setModal({ type: 'apply_credit', credit })
              }
              onReverseCredit={(credit, allocation) =>
                setModal({ type: 'reverse_credit', credit, allocation })
              }
              onReclassify={(invoice) =>
                setModal({ type: 'reclassify', invoice })
              }
              onOpenExpense={onOpenLegacyExpense}
              onEditExpense={onEditLegacyExpense}
              onArchiveExpense={onArchiveLegacyExpense}
              onPayExpense={onMarkLegacyExpensePaid}
            />
          ) : null}

          {section === 'suppliers' ? (
            <SuppliersSection
              suppliers={suppliers}
              busy={busy || readOnly}
              onCreate={onCreateSupplier}
              onEdit={onEditSupplier}
              onArchive={onArchiveSupplier}
              onRestore={onRestoreSupplier}
            />
          ) : null}
        </div>
      </section>

      {modal?.type === 'order' ? (
        <SupplierOrderForm
          workspace={workspace}
          order={modal.order}
          busy={busy}
          onClose={() => setModal(null)}
          onSave={(input) =>
            completeLocalAction(
              () => desktopApi.saveSupplierOrderDraft(input),
              modal.order
                ? 'Le brouillon de commande a été mis à jour.'
                : 'Le brouillon de commande a été créé. Contrôlez-le avant confirmation.',
            )
          }
        />
      ) : null}
      {modal?.type === 'confirm_order' ? (
        <ConfirmOrderModal
          workspace={workspace}
          order={modal.order}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={() =>
            completeLocalAction(
              () => desktopApi.confirmSupplierOrder(createId(), modal.order.id),
              'La commande fournisseur est confirmée. Les quantités attendent maintenant une réception ou un rapprochement direct.',
            )
          }
        />
      ) : null}
      {modal?.type === 'cancel_remainder' ? (
        <CancelSupplierRemainderModal
          workspace={workspace}
          order={modal.order}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={(reason, lines) =>
            completeLocalAction(
              () =>
                desktopApi.cancelSupplierOrderRemainder(
                  createId(),
                  modal.order.id,
                  reason,
                  lines,
                ),
              'Le reliquat non reçu et non rapproché a été annulé avec son motif.',
            )
          }
        />
      ) : null}
      {modal?.type === 'receipt' ? (
        <SupplierReceiptForm
          workspace={workspace}
          order={modal.order}
          receipt={modal.receipt}
          busy={busy}
          onClose={() => setModal(null)}
          onSave={(input) =>
            completeLocalAction(
              () => desktopApi.saveSupplierReceiptDraft(input),
              modal.receipt
                ? 'Le brouillon de réception a été mis à jour.'
                : 'La réception est enregistrée en brouillon. Contrôlez-la avant émission.',
            )
          }
        />
      ) : null}
      {modal?.type === 'issue_receipt' ? (
        <IssueReceiptModal
          workspace={workspace}
          receipt={modal.receipt}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={() =>
            completeLocalAction(
              () =>
                desktopApi.issueSupplierReceipt(createId(), modal.receipt.id),
              'La réception est émise. Les entrées de stock concernées ont été enregistrées localement.',
            )
          }
        />
      ) : null}
      {modal?.type === 'reverse_receipt' ? (
        <ReverseReceiptModal
          workspace={workspace}
          receipt={modal.receipt}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={(reason) =>
            completeLocalAction(
              () =>
                desktopApi.reverseSupplierReceipt(
                  createId(),
                  modal.receipt.id,
                  reason,
                ),
              'La réception a été extournée avec son motif. Les mouvements de stock inverses ont été enregistrés.',
            )
          }
        />
      ) : null}
      {modal?.type === 'match' ? (
        <SupplierInvoiceMatchModal
          workspace={workspace}
          order={modal.order}
          initialInvoice={modal.invoice}
          busy={busy}
          onClose={() => setModal(null)}
          onSave={(input) =>
            completeLocalAction(
              () => desktopApi.saveSupplierInvoiceMatch(input),
              input.allocations.length
                ? 'Le rapprochement multi-commandes a été enregistré atomiquement. Contrôlez puis validez la facture : chaque commande complète sera clôturée.'
                : 'Tous les rapprochements de cette facture ont été retirés. Les réceptions peuvent maintenant être corrigées et la facture reste en brouillon.',
            )
          }
        />
      ) : null}
      {modal?.type === 'credit' ? (
        <SupplierCreditNoteForm
          workspace={workspace}
          invoice={modal.invoice}
          credit={modal.credit}
          busy={busy}
          onClose={() => setModal(null)}
          onSave={(input) =>
            completeLocalAction(
              () => desktopApi.saveSupplierCreditNoteDraft(input),
              modal.credit
                ? 'Le brouillon d’avoir a été mis à jour.'
                : 'L’avoir est enregistré en brouillon. Contrôlez-le avant validation.',
            )
          }
        />
      ) : null}
      {modal?.type === 'validate_credit' ? (
        <ValidateCreditNoteModal
          credit={modal.credit}
          workspace={workspace}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={() =>
            completeLocalAction(
              () =>
                desktopApi.validateSupplierCreditNote(
                  createId(),
                  modal.credit.id,
                ),
              'L’avoir fournisseur a été validé et comptabilisé. Ses allocations réduisent les soldes liés.',
            )
          }
        />
      ) : null}
      {modal?.type === 'apply_credit' ? (
        <ApplySupplierCreditModal
          credit={modal.credit}
          workspace={workspace}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={(invoiceId, amountCents) =>
            completeLocalAction(
              () =>
                desktopApi.applySupplierCredit(
                  createId(),
                  modal.credit.id,
                  invoiceId,
                  amountCents,
                ),
              'L’avoir a été imputé sur la facture sélectionnée.',
            )
          }
        />
      ) : null}
      {modal?.type === 'reverse_credit' ? (
        <ReverseSupplierCreditAllocationModal
          credit={modal.credit}
          allocation={modal.allocation}
          workspace={workspace}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={(reason) =>
            completeLocalAction(
              () =>
                desktopApi.reverseSupplierCreditAllocation(
                  createId(),
                  modal.allocation.id,
                  reason,
                ),
              'L’imputation de l’avoir a été extournée avec son motif.',
            )
          }
        />
      ) : null}
      {modal?.type === 'reclassify' ? (
        <SupplierExpenseReclassificationModal
          workspace={workspace}
          invoice={modal.invoice}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={(input) =>
            completeLocalAction(
              () => desktopApi.reclassifySupplierInvoiceExpense(input),
              'L’imputation de charge a été corrigée par une nouvelle écriture traçable.',
            )
          }
        />
      ) : null}
    </div>
  );
}

function PurchaseInbox({
  workspace,
  orders,
  invoices,
  credits,
  busy,
  accountingReady,
  onNext,
  onOpenInvoice,
  onValidateInvoice,
  onMatchInvoice,
  onValidateCredit,
  onCreateOrder,
}: {
  workspace: Workspace;
  orders: SupplierOrder[];
  invoices: SupplierInvoice[];
  credits: SupplierCreditNote[];
  busy: boolean;
  accountingReady: boolean;
  onNext: (order: SupplierOrder) => void;
  onOpenInvoice: (invoice: SupplierInvoice) => void;
  onValidateInvoice: (invoice: SupplierInvoice) => void;
  onMatchInvoice: (invoice: SupplierInvoice, order: SupplierOrder) => void;
  onValidateCredit: (credit: SupplierCreditNote) => void;
  onCreateOrder: () => void;
}) {
  if (!orders.length && !invoices.length && !credits.length)
    return (
      <EmptyState
        icon={<CheckCircle2 />}
        title="Tout est traité"
        text="Aucune commande, facture ou avoir ne requiert d’action pour le moment."
        actionLabel="Créer une commande"
        onAction={onCreateOrder}
        disabled={busy}
      />
    );
  return (
    <div
      className="purchase-inbox"
      role="list"
      aria-label="Actions achats à traiter"
    >
      {orders.map((order) => {
        const action = supplierOrderNextAction(order, workspace);
        const hasDraftInvoice = workspace.supplierInvoices.some(
          (invoice) =>
            invoice.supplierId === order.supplierId &&
            invoice.documentStatus === 'draft' &&
            invoice.matchStatus !== 'matched',
        );
        const actionLabel =
          action === 'match_invoice' && !hasDraftInvoice
            ? 'Créer la facture fournisseur'
            : nextActionLabel(action);
        return (
          <article
            className="purchase-inbox__item"
            key={`order-${order.id}`}
            role="listitem"
          >
            <div className="purchase-inbox__icon">
              <FilePenLine size={18} />
            </div>
            <div>
              <small>
                Commande · {supplierName(workspace, order.supplierId)}
              </small>
              <strong>{orderName(order)}</strong>
              <p>{actionLabel}</p>
            </div>
            <Button size="small" disabled={busy} onClick={() => onNext(order)}>
              Continuer <ArrowRight size={15} />
            </Button>
          </article>
        );
      })}
      {invoices.map((invoice) => {
        const linkedMatch = workspace.supplierInvoiceMatches.find(
          (match) => match.supplierInvoiceId === invoice.id,
        );
        const linkedOrder = linkedMatch
          ? workspace.supplierOrders.find(
              (candidate) => candidate.id === linkedMatch.supplierOrderId,
            )
          : undefined;
        const order =
          linkedOrder ||
          workspace.supplierOrders.find(
            (candidate) =>
              candidate.supplierId === invoice.supplierId &&
              candidate.status === 'confirmed',
          );
        const validationMismatch =
          invoice.matchStatus === 'mismatch' ||
          Boolean(
            linkedOrder &&
            supplierInvoiceOrderMatchAmountMismatch(
              invoice.id,
              linkedOrder,
              workspace,
            ),
          );
        const overdue =
          invoice.documentStatus === 'validated' &&
          invoice.paymentStatus !== 'paid' &&
          invoice.dueDate < todayIso();
        return (
          <article
            className="purchase-inbox__item"
            key={`invoice-${invoice.id}`}
            role="listitem"
          >
            <div
              className={`purchase-inbox__icon ${invoice.matchStatus === 'mismatch' || overdue ? 'is-danger' : ''}`}
            >
              <ReceiptText size={18} />
            </div>
            <div>
              <small>Facture · {invoice.supplierName}</small>
              <strong>{invoice.reference || 'Référence à compléter'}</strong>
              <p>
                {invoice.documentStatus === 'draft'
                  ? 'Contrôler et valider le brouillon'
                  : overdue
                    ? `Échue depuis le ${formatDate(invoice.dueDate)}`
                    : invoice.matchStatus !== 'matched'
                      ? 'Déjà validée · rapprochement non modifiable'
                      : invoiceMatchLabel(invoice)}
              </p>
            </div>
            {invoice.documentStatus === 'draft' &&
            order &&
            invoice.matchStatus !== 'matched' ? (
              <Button
                size="small"
                disabled={busy}
                onClick={() => onMatchInvoice(invoice, order)}
              >
                Rapprocher <ArrowRight size={15} />
              </Button>
            ) : invoice.documentStatus === 'draft' ? (
              <Button
                size="small"
                disabled={busy || !accountingReady || validationMismatch}
                title={
                  !accountingReady
                    ? 'Configurez d’abord les comptes fournisseurs et de TVA.'
                    : validationMismatch
                      ? 'Corrigez l’écart global de quantité, de prix ou de TVA avant validation.'
                      : 'Valider et comptabiliser'
                }
                onClick={() => onValidateInvoice(invoice)}
              >
                Valider <ArrowRight size={15} />
              </Button>
            ) : (
              <Button
                size="small"
                variant="secondary"
                onClick={() => onOpenInvoice(invoice)}
              >
                Consulter <Eye size={15} />
              </Button>
            )}
          </article>
        );
      })}
      {credits.map((credit) => (
        <article
          className="purchase-inbox__item"
          key={`credit-${credit.id}`}
          role="listitem"
        >
          <div className="purchase-inbox__icon">
            <FilePlus2 size={18} />
          </div>
          <div>
            <small>Avoir brouillon · {credit.supplierName}</small>
            <strong>
              {credit.reference || credit.number || 'Sans référence'}
            </strong>
            <p>Contrôler les montants et allocations avant validation</p>
          </div>
          <Button
            size="small"
            disabled={busy || !accountingReady}
            title={
              accountingReady
                ? 'Contrôler puis valider'
                : 'Configurez d’abord les comptes fournisseurs et de TVA.'
            }
            onClick={() => onValidateCredit(credit)}
          >
            Contrôler <ArrowRight size={15} />
          </Button>
        </article>
      ))}
    </div>
  );
}

function SupplierOrderCard({
  order,
  workspace,
  busy,
  onNext,
  onEdit,
  onCancelRemainder,
  onMatchInvoice,
  onOpenInvoice,
}: {
  order: SupplierOrder;
  workspace: Workspace;
  busy: boolean;
  onNext: () => void;
  onEdit: () => void;
  onCancelRemainder: () => void;
  onMatchInvoice: (invoice: SupplierInvoice) => void;
  onOpenInvoice: (invoice: SupplierInvoice) => void;
}) {
  const progress = supplierOrderProgress(order, workspace);
  const display = supplierOrderDisplayStatus(order, workspace);
  const match = supplierThreeWayMatchStatus(order, workspace);
  const next = supplierOrderNextAction(order, workspace);
  const linkedInvoiceIds = new Set(
    workspace.supplierInvoiceMatches
      .filter((row) => row.supplierOrderId === order.id)
      .map((row) => row.supplierInvoiceId),
  );
  const linkedInvoices = workspace.supplierInvoices.filter((invoice) =>
    linkedInvoiceIds.has(invoice.id),
  );
  const potentialInvoices = workspace.supplierInvoices.filter(
    (invoice) =>
      invoice.supplierId === order.supplierId &&
      invoice.documentStatus === 'draft',
  );
  const cancelable = order.lines.some((line) => {
    const progress = supplierOrderLineProgress(order, line, workspace);
    return (
      progress.effectiveQuantityMilli -
        Math.max(
          progress.receivedQuantityMilli,
          progress.matchedQuantityMilli,
        ) >
      0
    );
  });
  return (
    <article className="supplier-order-card" role="listitem">
      <header>
        <div>
          <small>
            {formatDate(order.orderDate)} ·{' '}
            {supplierName(workspace, order.supplierId)}
          </small>
          <h3>{orderName(order)}</h3>
          <p>{order.title}</p>
        </div>
        <div className="supplier-order-card__statuses">
          <StatusBadge status={display.status} label={display.label} />
          <span className={`match-pill match-pill--${match.status}`}>
            {match.label}
          </span>
        </div>
      </header>
      <div className="supplier-order-card__progress">
        <div>
          <span>
            <strong>Réception</strong>
            <small>
              {progress.receiptLineCount
                ? `${progress.receiptCompletedLines}/${progress.receiptLineCount} lignes`
                : 'Prestations directes'}
            </small>
          </span>
          <progress
            aria-label="Progression de la réception"
            max="100"
            value={progress.receiptPercent}
          >
            {progress.receiptPercent}%
          </progress>
        </div>
        <div>
          <span>
            <strong>Rapprochement</strong>
            <small>
              {progress.matchCompletedLines}/{progress.matchLineCount} lignes
            </small>
          </span>
          <progress
            aria-label="Progression du rapprochement"
            max="100"
            value={progress.matchPercent}
          >
            {progress.matchPercent}%
          </progress>
        </div>
      </div>
      <div className="supplier-order-card__lines">
        {order.lines.map((line) => {
          const row = supplierOrderLineProgress(order, line, workspace);
          return (
            <div key={line.id}>
              <span>
                <strong>{line.description}</strong>
                <small>
                  {line.fulfillmentMode === 'direct'
                    ? 'Prestation directe'
                    : line.fulfillmentMode === 'stocked_receipt'
                      ? 'Réception avec stock'
                      : 'Réception sans stock'}
                </small>
              </span>
              <span>
                <strong>
                  {formatCatalogQuantity(row.effectiveQuantityMilli)}{' '}
                  {line.unit}
                </strong>
                <small>
                  reçu {formatCatalogQuantity(row.receivedQuantityMilli)} ·
                  rapproché {formatCatalogQuantity(row.matchedQuantityMilli)}
                </small>
              </span>
            </div>
          );
        })}
      </div>
      {match.issues.length ? (
        <div className="supplier-order-card__issues" role="alert">
          <AlertTriangle size={16} />
          <div>
            {match.issues.map((issue) => (
              <p key={issue}>{issue}</p>
            ))}
          </div>
        </div>
      ) : null}
      {linkedInvoices.length ? (
        <div className="supplier-order-card__links">
          <span>Factures liées</span>
          {linkedInvoices.map((invoice) => (
            <Button
              key={invoice.id}
              variant="ghost"
              size="small"
              onClick={() => onOpenInvoice(invoice)}
            >
              <Eye size={14} /> {invoice.reference || invoice.id}
            </Button>
          ))}
        </div>
      ) : null}
      <footer>
        <div>
          <strong>{formatMoney(order.totalCents)}</strong>
          <small>{order.currency}</small>
        </div>
        <div className="row-actions">
          {order.status === 'draft' ? (
            <Button
              variant="ghost"
              size="small"
              disabled={busy}
              onClick={onEdit}
            >
              <Pencil size={14} /> Modifier
            </Button>
          ) : null}
          {order.status === 'confirmed' && cancelable ? (
            <Button
              variant="ghost"
              size="small"
              disabled={busy}
              onClick={onCancelRemainder}
            >
              Corriger le reliquat
            </Button>
          ) : null}
          {next === 'match_invoice' && potentialInvoices.length ? (
            <Button
              variant="secondary"
              size="small"
              disabled={busy}
              onClick={() => onMatchInvoice(potentialInvoices[0])}
            >
              <ReceiptText size={14} /> Rapprocher
            </Button>
          ) : null}
          {next !== 'none' ? (
            <Button size="small" disabled={busy} onClick={onNext}>
              {next === 'match_invoice' && !potentialInvoices.length
                ? 'Créer la facture fournisseur'
                : nextActionLabel(next)}{' '}
              <ArrowRight size={14} />
            </Button>
          ) : null}
        </div>
      </footer>
    </article>
  );
}

function ReceiptsSection({
  workspace,
  receipts,
  busy,
  onEdit,
  onIssue,
  onReverse,
}: {
  workspace: Workspace;
  receipts: SupplierReceipt[];
  busy: boolean;
  onEdit: (receipt: SupplierReceipt, order: SupplierOrder) => void;
  onIssue: (receipt: SupplierReceipt) => void;
  onReverse: (receipt: SupplierReceipt) => void;
}) {
  if (!receipts.length)
    return (
      <EmptyState
        icon={<PackageCheck />}
        title="Aucune réception"
        text="Une commande confirmée proposera ici une réception partielle ou complète. Les prestations directes n’en créent pas."
      />
    );
  return (
    <div className="receipt-card-list" role="list">
      {receipts.map((receipt) => {
        const order = workspace.supplierOrders.find(
          (candidate) => candidate.id === receipt.supplierOrderId,
        );
        const receiptLineIds = new Set(receipt.lines.map((line) => line.id));
        const linkedMatches = workspace.supplierInvoiceMatches.filter(
          (match) =>
            match.supplierReceiptLineId &&
            receiptLineIds.has(match.supplierReceiptLineId),
        );
        const linkedInvoices = linkedMatches
          .map((match) =>
            workspace.supplierInvoices.find(
              (invoice) => invoice.id === match.supplierInvoiceId,
            ),
          )
          .filter((invoice): invoice is SupplierInvoice => Boolean(invoice));
        const hasLinkedMatch = linkedMatches.length > 0;
        const allLinkedInvoicesAreDraft =
          linkedInvoices.length > 0 &&
          linkedInvoices.every((invoice) => invoice.documentStatus === 'draft');
        return (
          <article className="receipt-card" key={receipt.id} role="listitem">
            <div className="receipt-card__icon">
              <PackageCheck size={20} />
            </div>
            <div>
              <small>
                {formatDate(receipt.receiptDate)} ·{' '}
                {order
                  ? supplierName(workspace, order.supplierId)
                  : 'Commande introuvable'}
              </small>
              <strong>{receiptName(receipt)}</strong>
              <p>
                {order ? orderName(order) : receipt.supplierOrderId} ·{' '}
                {receipt.lines.length} ligne
                {receipt.lines.length > 1 ? 's' : ''}
              </p>
              {receipt.reversalReason ? (
                <small className="is-negative">
                  Motif : {receipt.reversalReason}
                </small>
              ) : null}
            </div>
            <StatusBadge
              status={receipt.status}
              label={receipt.status === 'reversed' ? 'Extournée' : undefined}
            />
            <div className="row-actions">
              {receipt.status === 'draft' && order ? (
                <>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() => onEdit(receipt, order)}
                  >
                    <Pencil size={14} /> Modifier
                  </Button>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => onIssue(receipt)}
                  >
                    Contrôler et émettre
                  </Button>
                </>
              ) : null}
              {receipt.status === 'issued' && !hasLinkedMatch ? (
                <Button
                  variant="ghost"
                  size="small"
                  disabled={busy}
                  onClick={() => onReverse(receipt)}
                >
                  <RotateCcw size={14} /> Extourner
                </Button>
              ) : null}
              {receipt.status === 'issued' && hasLinkedMatch ? (
                <small className="receipt-card__lock-reason">
                  {allLinkedInvoicesAreDraft
                    ? 'Rapprochée à une facture : retirez d’abord le lien brouillon.'
                    : 'Liée à une facture validée : la réception ne peut plus être extournée.'}
                </small>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function DocumentsSection({
  workspace,
  invoices,
  credits,
  expenses,
  busy,
  accountingReady,
  onOpenInvoice,
  onEditInvoice,
  onValidateInvoice,
  onDeleteInvoice,
  onPayInvoice,
  onMatch,
  onCredit,
  onEditCredit,
  onValidateCredit,
  onDeleteCredit,
  onApplyCredit,
  onReverseCredit,
  onReclassify,
  onOpenExpense,
  onEditExpense,
  onArchiveExpense,
  onPayExpense,
}: {
  workspace: Workspace;
  invoices: SupplierInvoice[];
  credits: SupplierCreditNote[];
  expenses: Expense[];
  busy: boolean;
  accountingReady: boolean;
  onOpenInvoice: (invoice: SupplierInvoice) => void;
  onEditInvoice: (invoice: SupplierInvoice) => void;
  onValidateInvoice: (invoice: SupplierInvoice) => void;
  onDeleteInvoice: (invoice: SupplierInvoice) => void;
  onPayInvoice: (invoice: SupplierInvoice) => void;
  onMatch: (invoice: SupplierInvoice, order: SupplierOrder) => void;
  onCredit: (invoice: SupplierInvoice) => void;
  onEditCredit: (credit: SupplierCreditNote) => void;
  onValidateCredit: (credit: SupplierCreditNote) => void;
  onDeleteCredit: (credit: SupplierCreditNote) => void;
  onApplyCredit: (credit: SupplierCreditNote) => void;
  onReverseCredit: (
    credit: SupplierCreditNote,
    allocation: SupplierCreditAllocation,
  ) => void;
  onReclassify: (invoice: SupplierInvoice) => void;
  onOpenExpense: (expense: Expense) => void;
  onEditExpense: (expense: Expense) => void;
  onArchiveExpense: (expense: Expense) => void;
  onPayExpense: (expense: Expense) => void;
}) {
  if (!invoices.length && !credits.length && !expenses.length)
    return (
      <EmptyState
        icon={<ReceiptText />}
        title="Aucune facture ni avoir"
        text="Ajoutez un document fournisseur réel. Aucun exemple n’est créé automatiquement."
      />
    );
  return (
    <div className="purchase-document-list">
      {invoices.map((invoice) => {
        const linkedMatch = workspace.supplierInvoiceMatches.find(
          (match) => match.supplierInvoiceId === invoice.id,
        );
        const linkedOrder = linkedMatch
          ? workspace.supplierOrders.find(
              (candidate) => candidate.id === linkedMatch.supplierOrderId,
            )
          : undefined;
        const order =
          linkedOrder ||
          workspace.supplierOrders.find(
            (candidate) =>
              candidate.supplierId === invoice.supplierId &&
              candidate.status === 'confirmed' &&
              candidate.lines.some(
                (line) =>
                  supplierOrderLineMatchableMilli(line, workspace, candidate) >
                  0,
              ),
          );
        const validationMismatch =
          invoice.matchStatus === 'mismatch' ||
          Boolean(
            linkedOrder &&
            supplierInvoiceOrderMatchAmountMismatch(
              invoice.id,
              linkedOrder,
              workspace,
            ),
          );
        const overdue =
          invoice.documentStatus === 'validated' &&
          invoice.paymentStatus !== 'paid' &&
          invoice.dueDate < todayIso();
        const shouldOfferMatching = Boolean(
          order && (invoice.matchStatus !== 'matched' || Boolean(linkedMatch)),
        );
        return (
          <article className="purchase-document-card" key={invoice.id}>
            <div>
              <small>
                Facture fournisseur · {formatDate(invoice.documentDate)}
              </small>
              <h3>{invoice.reference || 'Référence à compléter'}</h3>
              <p>
                {invoice.supplierName} · échéance {formatDate(invoice.dueDate)}
              </p>
              {invoice.documentStatus === 'validated' &&
              invoice.matchStatus !== 'matched' ? (
                <small className="purchase-document-card__warning">
                  Facture déjà validée : le rapprochement n’est plus modifiable.
                  Corrigez par avoir et nouveau brouillon si nécessaire.
                </small>
              ) : null}
              {invoice.documentStatus === 'draft' && shouldOfferMatching ? (
                <small className="purchase-document-card__warning">
                  {linkedMatch
                    ? 'Le rapprochement reste modifiable jusqu’à la validation.'
                    : 'Une commande ouverte de ce fournisseur peut être rapprochée avant validation.'}
                </small>
              ) : null}
            </div>
            <div>
              <strong>{formatMoney(invoice.totalCents)}</strong>
              <small>
                Solde {formatMoney(invoice.balanceCents)}
                {invoice.creditedCents
                  ? ` · avoirs ${formatMoney(invoice.creditedCents)}`
                  : ''}
              </small>
            </div>
            <div className="purchase-document-card__status">
              <StatusBadge
                status={
                  overdue
                    ? 'expired'
                    : invoice.documentStatus === 'draft'
                      ? 'draft'
                      : invoice.paymentStatus || 'validated'
                }
                label={overdue ? 'En retard' : undefined}
              />
              <span
                className={`match-pill match-pill--${invoice.matchStatus === 'matched' ? 'green' : invoice.matchStatus === 'mismatch' ? 'red' : 'orange'}`}
              >
                {invoiceMatchLabel(invoice)}
              </span>
            </div>
            <div className="row-actions">
              {invoice.documentStatus === 'draft' ? (
                <>
                  {shouldOfferMatching && order ? (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy}
                      onClick={() => onMatch(invoice, order)}
                    >
                      <ClipboardCheck size={14} />{' '}
                      {linkedMatch
                        ? 'Modifier le rapprochement'
                        : 'Rapprocher avant validation'}
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    variant={
                      shouldOfferMatching && !linkedMatch ? 'ghost' : 'primary'
                    }
                    disabled={busy || !accountingReady || validationMismatch}
                    title={
                      !accountingReady
                        ? 'Configurez d’abord les comptes fournisseurs et de TVA.'
                        : validationMismatch
                          ? 'Corrigez l’écart de quantité, de prix ou de TVA avant validation.'
                          : shouldOfferMatching && !linkedMatch
                            ? 'Valider volontairement cette facture comme autonome : elle ne pourra plus être rapprochée.'
                            : 'Valider et comptabiliser'
                    }
                    onClick={() => onValidateInvoice(invoice)}
                  >
                    <FileCheck2 size={14} />{' '}
                    {shouldOfferMatching && !linkedMatch
                      ? 'Valider comme autonome'
                      : 'Valider'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy || Boolean(linkedMatch)}
                    title={
                      linkedMatch
                        ? 'Retirez d’abord le rapprochement avant de modifier la facture.'
                        : 'Modifier le brouillon'
                    }
                    onClick={() => onEditInvoice(invoice)}
                  >
                    <Pencil size={14} /> Modifier
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label={`Supprimer la facture ${invoice.reference || invoice.id}`}
                    onClick={() => onDeleteInvoice(invoice)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => onOpenInvoice(invoice)}
                  >
                    <Eye size={14} /> Consulter
                  </Button>
                  {invoice.balanceCents > 0 ? (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy}
                      onClick={() => onPayInvoice(invoice)}
                    >
                      <Banknote size={14} /> Paiement
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() => onCredit(invoice)}
                  >
                    Créer un avoir
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy || !accountingReady}
                    title={
                      accountingReady
                        ? 'Corriger par une écriture traçable'
                        : 'Configurez d’abord les comptes fournisseurs et de TVA.'
                    }
                    onClick={() => onReclassify(invoice)}
                  >
                    Corriger l’imputation
                  </Button>
                </>
              )}
            </div>
          </article>
        );
      })}
      {credits.map((credit) => (
        <SupplierCreditDocumentCard
          key={credit.id}
          credit={credit}
          workspace={workspace}
          busy={busy}
          validationDisabled={!accountingReady}
          onEdit={() => onEditCredit(credit)}
          onValidate={() => onValidateCredit(credit)}
          onDelete={() => onDeleteCredit(credit)}
          onApply={() => onApplyCredit(credit)}
          onReverse={(allocation) => onReverseCredit(credit, allocation)}
        />
      ))}
      {expenses.map((expense) => (
        <article className="purchase-document-card is-legacy" key={expense.id}>
          <div>
            <small>Achat historique · {formatDate(expense.date)}</small>
            <h3>{expense.reference || expense.supplier || 'Achat'}</h3>
            <p>
              {expense.supplier || 'Fournisseur non renseigné'} · saisie directe
              antérieure
            </p>
          </div>
          <div>
            <strong>{formatMoney(expense.totalCents)}</strong>
            <small>TVA {formatMoney(expense.vatCents)}</small>
          </div>
          <StatusBadge
            status={expense.paymentStatus === 'paid' ? 'paid' : 'draft'}
            label={expense.paymentStatus === 'paid' ? 'Payé' : 'À payer'}
          />
          <div className="row-actions">
            {expense.paymentStatus === 'pending' ? (
              <>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onClick={() => onPayExpense(expense)}
                >
                  Marquer payé
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={busy}
                  onClick={() => onEditExpense(expense)}
                >
                  <Pencil size={14} /> Modifier
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  aria-label={`Supprimer l’achat ${expense.reference || expense.id}`}
                  onClick={() => onArchiveExpense(expense)}
                >
                  <Trash2 size={14} />
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="small"
                onClick={() => onOpenExpense(expense)}
              >
                <Eye size={14} /> Consulter
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function SupplierCreditDocumentCard({
  credit,
  workspace,
  busy,
  validationDisabled,
  onEdit,
  onValidate,
  onDelete,
  onApply,
  onReverse,
}: {
  credit: SupplierCreditNote;
  workspace: Workspace;
  busy: boolean;
  validationDisabled: boolean;
  onEdit: () => void;
  onValidate: () => void;
  onDelete: () => void;
  onApply: () => void;
  onReverse: (allocation: SupplierCreditAllocation) => void;
}) {
  const availableCents = Math.max(0, credit.totalCents - credit.allocatedCents);
  const reversedIds = new Set(
    credit.allocations
      .filter((allocation) => allocation.eventType === 'reverse')
      .map((allocation) => allocation.reversesAllocationId)
      .filter(Boolean),
  );
  const activeApplications = credit.allocations.filter(
    (allocation) =>
      allocation.eventType === 'apply' && !reversedIds.has(allocation.id),
  );
  return (
    <article className="purchase-document-card purchase-document-card--credit">
      <div>
        <small>Avoir fournisseur · {formatDate(credit.documentDate)}</small>
        <h3>{credit.number || credit.reference || 'Avoir brouillon'}</h3>
        <p>
          {credit.supplierName} · imputé {formatMoney(credit.allocatedCents)} ·
          disponible {formatMoney(availableCents)}
        </p>
        {activeApplications.length ? (
          <div className="credit-application-list">
            {activeApplications.map((allocation) => {
              const invoice = workspace.supplierInvoices.find(
                (row) => row.id === allocation.supplierInvoiceId,
              );
              return (
                <span key={allocation.id}>
                  <small>
                    {invoice?.reference || allocation.supplierInvoiceId} ·{' '}
                    {formatMoney(allocation.amountCents)}
                  </small>
                  {credit.status === 'validated' ? (
                    <Button
                      variant="ghost"
                      size="small"
                      disabled={busy}
                      onClick={() => onReverse(allocation)}
                    >
                      <RotateCcw size={13} /> Extourner
                    </Button>
                  ) : (
                    <small>Modifiable dans le brouillon</small>
                  )}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
      <div>
        <strong>− {formatMoney(credit.totalCents)}</strong>
        <small>TVA {formatMoney(credit.vatCents)}</small>
      </div>
      <StatusBadge status={credit.status} />
      <div className="row-actions">
        {credit.status === 'draft' ? (
          <>
            <Button
              size="small"
              disabled={busy || validationDisabled}
              title={
                validationDisabled
                  ? 'Configurez d’abord les comptes fournisseurs et de TVA.'
                  : 'Contrôler puis valider'
              }
              onClick={onValidate}
            >
              Contrôler et valider
            </Button>
            <Button
              variant="ghost"
              size="small"
              disabled={busy}
              onClick={onEdit}
            >
              <Pencil size={14} /> Modifier
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={`Supprimer l’avoir ${credit.reference || credit.id}`}
              onClick={onDelete}
            >
              <Trash2 size={14} />
            </Button>
          </>
        ) : availableCents > 0 ? (
          <Button size="small" disabled={busy} onClick={onApply}>
            Imputer sur une facture
          </Button>
        ) : (
          <StatusBadge status="closed" label="Entièrement imputé" />
        )}
      </div>
    </article>
  );
}

function SuppliersSection({
  suppliers,
  busy,
  onCreate,
  onEdit,
  onArchive,
  onRestore,
}: {
  suppliers: Supplier[];
  busy: boolean;
  onCreate: () => void;
  onEdit: (supplier: Supplier) => void;
  onArchive: (supplier: Supplier) => void;
  onRestore: (supplier: Supplier) => void;
}) {
  if (!suppliers.length)
    return (
      <EmptyState
        icon={<Building2 />}
        title="Aucun fournisseur"
        text="Ajoutez les coordonnées réelles du premier fournisseur."
        actionLabel="Ajouter un fournisseur"
        onAction={onCreate}
        disabled={busy}
      />
    );
  return (
    <div className="supplier-workflow-list" role="list">
      {suppliers.map((supplier) => (
        <article
          key={supplier.id}
          role="listitem"
          className={supplier.archivedAt ? 'is-archived' : ''}
        >
          <div className="supplier-workflow-list__icon">
            <Building2 size={19} />
          </div>
          <div>
            <strong>{supplier.name}</strong>
            <p>
              {supplier.contactName || 'Aucun contact'} ·{' '}
              {supplier.email || 'Aucun e-mail'}
            </p>
            <small>
              {supplier.iban || 'IBAN non renseigné'} ·{' '}
              {supplier.paymentTermsDays
                ? `${supplier.paymentTermsDays} jours`
                : 'Paiement immédiat'}
            </small>
          </div>
          <StatusBadge
            status={supplier.archivedAt ? 'incomplete' : 'validated'}
            label={supplier.archivedAt ? 'Archivé' : 'Actif'}
          />
          <div className="row-actions">
            <Button
              variant="ghost"
              size="small"
              disabled={busy}
              onClick={() => onEdit(supplier)}
            >
              <Pencil size={14} /> Modifier
            </Button>
            {supplier.archivedAt ? (
              <Button
                variant="secondary"
                size="small"
                disabled={busy}
                onClick={() => onRestore(supplier)}
              >
                Réactiver
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="small"
                disabled={busy}
                onClick={() => onArchive(supplier)}
              >
                Archiver
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function SupplierOrderForm({
  workspace,
  order,
  busy,
  onClose,
  onSave,
}: {
  workspace: Workspace;
  order?: SupplierOrder;
  busy: boolean;
  onClose: () => void;
  onSave: (
    input: Parameters<typeof desktopApi.saveSupplierOrderDraft>[0],
  ) => void;
}) {
  const [supplierId, setSupplierId] = useState(
    order?.supplierId ||
      workspace.suppliers.find((supplier) => !supplier.archivedAt)?.id ||
      '',
  );
  const [projectId, setProjectId] = useState(order?.projectId || '');
  const [title, setTitle] = useState(order?.title || 'Commande fournisseur');
  const [orderDate, setOrderDate] = useState(order?.orderDate || todayIso());
  const [notes, setNotes] = useState(order?.notes || '');
  const [terms, setTerms] = useState(order?.terms || '');
  const [lines, setLines] = useState<OrderDraftLine[]>(
    () =>
      order?.lines.map((line) => ({
        id: line.id,
        catalogItemId: line.catalogItemId || '',
        description: line.description,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPriceCents: line.unitPriceCents,
        discountBp: line.discountBp,
        vatBp: line.vatBp,
        category: line.category,
        expenseAccountId: line.expenseAccountId || '',
        projectId: line.projectId || '',
        fulfillmentMode: line.fulfillmentMode,
      })) || [emptyOrderLine(workspace)],
  );
  const [error, setError] = useState('');
  const totals = orderDraftTotals(lines);
  const catalog = workspace.catalogItems.filter((item) => !item.archivedAt);
  const vatOptions = purchaseVatOptions(
    Boolean(workspace.settings?.organization.vatRegistered),
    workspace.settings?.billing.vatRatesBp || [],
  );
  const patchLine = (id: string, patch: Partial<OrderDraftLine>) =>
    setLines((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  function chooseCatalog(line: OrderDraftLine, catalogItemId: string) {
    const item = catalog.find((candidate) => candidate.id === catalogItemId);
    if (!item) return patchLine(line.id, { catalogItemId });
    patchLine(line.id, {
      catalogItemId,
      description: item.name,
      unit: item.unit || 'unité',
      unitPriceCents: item.purchaseCostCents,
      vatBp: item.vatBp,
      fulfillmentMode:
        item.kind === 'service'
          ? 'direct'
          : item.trackStock
            ? 'stocked_receipt'
            : 'untracked_receipt',
    });
  }
  function submit() {
    if (!supplierId || !title.trim())
      return setError(
        'Choisissez un fournisseur et donnez un titre à la commande.',
      );
    if (
      !lines.length ||
      lines.some(
        (line) =>
          !line.description.trim() ||
          line.quantityMilli <= 0 ||
          line.unitPriceCents < 0 ||
          !line.category.trim(),
      )
    )
      return setError(
        'Chaque ligne doit avoir une description, une quantité positive et une catégorie.',
      );
    if (
      lines.some((line) => {
        if (line.fulfillmentMode !== 'stocked_receipt') return false;
        const item = catalog.find(
          (candidate) => candidate.id === line.catalogItemId,
        );
        return !item || item.kind !== 'product' || !item.trackStock;
      })
    )
      return setError(
        'Une ligne « Réception + stock » doit viser un produit du catalogue dont le suivi de stock est activé.',
      );
    setError('');
    onSave({
      id: order?.id,
      supplierId,
      projectId: projectId || null,
      title: title.trim(),
      orderDate,
      currency: 'CHF',
      notes,
      terms,
      lines: lines.map((line, position) => ({
        id: order?.lines.some((candidate) => candidate.id === line.id)
          ? line.id
          : undefined,
        catalogItemId: line.catalogItemId || null,
        position,
        description: line.description.trim(),
        quantityMilli: line.quantityMilli,
        unit: line.unit.trim() || 'unité',
        unitPriceCents: line.unitPriceCents,
        discountBp: line.discountBp,
        vatBp: line.vatBp,
        category: line.category.trim(),
        expenseAccountId: line.expenseAccountId || null,
        projectId: line.projectId || projectId || null,
        fulfillmentMode: line.fulfillmentMode,
      })),
    });
  }
  return (
    <Modal
      wide
      title={
        order
          ? 'Modifier la commande fournisseur'
          : 'Nouvelle commande fournisseur'
      }
      description="Enregistrez un brouillon modifiable. La confirmation se fait ensuite dans un écran de contrôle séparé."
      onClose={onClose}
    >
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Fournisseur" required>
          <select
            value={supplierId}
            onChange={(event) => setSupplierId(event.target.value)}
          >
            <option value="">Choisir…</option>
            {workspace.suppliers
              .filter(
                (supplier) =>
                  !supplier.archivedAt || supplier.id === supplierId,
              )
              .map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Date" required>
          <input
            type="date"
            value={orderDate}
            max={todayIso()}
            onChange={(event) => setOrderDate(event.target.value)}
            required
          />
        </Field>
        <Field label="Titre" required wide>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </Field>
        <Field label="Projet">
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Aucun</option>
            {workspace.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Conditions">
          <input
            value={terms}
            onChange={(event) => setTerms(event.target.value)}
            placeholder="Délais, livraison, conditions…"
          />
        </Field>
        <Field label="Notes" wide>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
          />
        </Field>
        <div className="purchase-line-editor field--wide">
          <div className="purchase-line-editor__heading">
            <div>
              <strong>Lignes de commande</strong>
              <small>Le mode pilote la réception et le stock.</small>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() =>
                setLines((rows) => [
                  ...rows,
                  emptyOrderLine(workspace, projectId),
                ])
              }
            >
              <Plus size={14} /> Ajouter une ligne
            </Button>
          </div>
          {lines.map((line, index) => {
            const selectedCatalog = catalog.find(
              (item) => item.id === line.catalogItemId,
            );
            return (
              <div className="purchase-line-editor__row" key={line.id}>
                <div className="purchase-line-editor__index">{index + 1}</div>
                <Field label="Article du catalogue">
                  <select
                    value={line.catalogItemId}
                    onChange={(event) =>
                      chooseCatalog(line, event.target.value)
                    }
                  >
                    <option value="">Saisie libre</option>
                    {catalog.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Description" required>
                  <input
                    value={line.description}
                    onChange={(event) =>
                      patchLine(line.id, { description: event.target.value })
                    }
                  />
                </Field>
                <Field label="Quantité" required>
                  <input
                    type="number"
                    min="0.001"
                    step="0.001"
                    value={line.quantityMilli / 1_000}
                    onChange={(event) =>
                      patchLine(line.id, {
                        quantityMilli: milliFromNumber(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Unité">
                  <input
                    value={line.unit}
                    onChange={(event) =>
                      patchLine(line.id, { unit: event.target.value })
                    }
                  />
                </Field>
                <Field label="Prix achat HT">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.unitPriceCents / 100}
                    onChange={(event) =>
                      patchLine(line.id, {
                        unitPriceCents: centsFromNumber(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Rabais %">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={line.discountBp / 100}
                    onChange={(event) =>
                      patchLine(line.id, {
                        discountBp: basisPointsFromNumber(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="TVA %">
                  <select
                    value={line.vatBp / 100}
                    onChange={(event) =>
                      patchLine(line.id, {
                        vatBp: basisPointsFromNumber(event.target.value),
                      })
                    }
                  >
                    {vatOptions.map((rate) => (
                      <option key={rate} value={rate / 100}>
                        {(rate / 100).toLocaleString('fr-CH')} %
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Catégorie" required>
                  <input
                    list="purchase-categories"
                    value={line.category}
                    onChange={(event) =>
                      patchLine(line.id, { category: event.target.value })
                    }
                  />
                </Field>
                <Field label="Traitement" required>
                  <select
                    value={line.fulfillmentMode}
                    onChange={(event) =>
                      patchLine(line.id, {
                        fulfillmentMode: event.target
                          .value as SupplierOrderFulfillmentMode,
                      })
                    }
                  >
                    <option
                      value="stocked_receipt"
                      disabled={
                        !selectedCatalog ||
                        selectedCatalog.kind !== 'product' ||
                        !selectedCatalog.trackStock
                      }
                    >
                      Réception + stock
                    </option>
                    <option value="untracked_receipt">
                      Réception sans stock
                    </option>
                    <option value="direct">Prestation directe</option>
                  </select>
                </Field>
                <div className="purchase-line-editor__total">
                  <small>Total TTC</small>
                  <strong>
                    {formatMoney(supplierDraftLineTotals(line).totalCents)}
                  </strong>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={lines.length === 1}
                  onClick={() =>
                    setLines((rows) => rows.filter((row) => row.id !== line.id))
                  }
                  aria-label={`Supprimer la ligne ${index + 1}`}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            );
          })}
          <datalist id="purchase-categories">
            {workspace.settings?.work.costCategories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
          <div className="purchase-line-editor__summary">
            <span>
              HT <strong>{formatMoney(totals.netCents)}</strong>
            </span>
            <span>
              TVA <strong>{formatMoney(totals.vatCents)}</strong>
            </span>
            <span>
              Total <strong>{formatMoney(totals.totalCents)}</strong>
            </span>
          </div>
        </div>
        {error ? <ErrorPanel message={error} /> : null}
        <FormActions
          onCancel={onClose}
          busy={busy}
          submitLabel="Enregistrer le brouillon"
        />
      </form>
    </Modal>
  );
}

function ConfirmOrderModal({
  workspace,
  order,
  busy,
  onClose,
  onConfirm,
}: {
  workspace: Workspace;
  order: SupplierOrder;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      wide
      title="Contrôler puis confirmer la commande"
      description="Après confirmation, l’identité du fournisseur et les quantités pilotent les réceptions et le rapprochement."
      onClose={onClose}
    >
      <div className="document-preview purchase-preview">
        <header>
          <div>
            <small>Destinataire</small>
            <h3>{supplierName(workspace, order.supplierId)}</h3>
            <p>
              {order.title} · {formatDate(order.orderDate)}
            </p>
          </div>
          <strong>{formatMoney(order.totalCents)}</strong>
        </header>
        <div className="purchase-preview__lines">
          {order.lines.map((line) => (
            <div key={line.id}>
              <span>
                <strong>{line.description}</strong>
                <small>
                  {line.fulfillmentMode === 'direct'
                    ? 'Sans réception'
                    : line.fulfillmentMode === 'stocked_receipt'
                      ? 'Réception avec entrée en stock'
                      : 'Réception sans stock'}
                </small>
              </span>
              <span>
                {formatCatalogQuantity(line.quantityMilli)} {line.unit}
              </span>
              <strong>{formatMoney(line.lineTotalCents)}</strong>
            </div>
          ))}
        </div>
        {order.notes ? (
          <p>
            <strong>Notes :</strong> {order.notes}
          </p>
        ) : null}
        {order.terms ? (
          <p>
            <strong>Conditions :</strong> {order.terms}
          </p>
        ) : null}
      </div>
      <div className="confirmation-callout">
        <ShieldCheck size={19} />
        <p>
          Je confirme le fournisseur, les lignes, les modes de traitement et les
          quantités ci-dessus. La commande ne sera plus modifiable directement.
        </p>
      </div>
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Retour au brouillon
        </Button>
        <Button onClick={onConfirm} disabled={busy}>
          <FileCheck2 size={16} /> Confirmer la commande
        </Button>
      </div>
    </Modal>
  );
}

function SupplierReceiptForm({
  workspace,
  order,
  receipt,
  busy,
  onClose,
  onSave,
}: {
  workspace: Workspace;
  order: SupplierOrder;
  receipt?: SupplierReceipt;
  busy: boolean;
  onClose: () => void;
  onSave: (
    input: Parameters<typeof desktopApi.saveSupplierReceiptDraft>[0],
  ) => void;
}) {
  const eligible = order.lines.filter(
    (line) => line.fulfillmentMode !== 'direct',
  );
  const [receiptDate, setReceiptDate] = useState(
    receipt?.receiptDate || todayIso(),
  );
  const [reference, setReference] = useState(receipt?.reference || '');
  const [notes, setNotes] = useState(receipt?.notes || '');
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      eligible.map((line) => [
        line.id,
        receipt?.lines.find((row) => row.supplierOrderLineId === line.id)
          ?.quantityMilli ??
          supplierOrderLineProgress(order, line, workspace)
            .remainingToReceiveMilli,
      ]),
    ),
  );
  const dateError = supplierReceiptDateValidationError(
    order.orderDate,
    receiptDate,
    todayIso(),
  );
  const quantityError = eligible.some(
    (line) =>
      (quantities[line.id] || 0) >
      supplierOrderLineProgress(order, line, workspace).remainingToReceiveMilli,
  )
    ? 'Une quantité dépasse le reliquat disponible.'
    : '';
  const hasQuantity = Object.values(quantities).some(
    (quantity) => quantity > 0,
  );
  function submit() {
    if (dateError || quantityError || !hasQuantity) return;
    onSave({
      id: receipt?.id,
      supplierOrderId: order.id,
      receiptDate,
      reference,
      notes,
      lines: eligible
        .map((line) => ({
          supplierOrderLineId: line.id,
          quantityMilli: quantities[line.id] || 0,
        }))
        .filter((line) => line.quantityMilli > 0),
    });
  }
  return (
    <Modal
      wide
      title={
        receipt ? 'Modifier la réception brouillon' : 'Saisir une réception'
      }
      description="Choisissez les quantités réellement arrivées. Une réception partielle est possible; le stock ne bougera qu’après le contrôle d’émission."
      onClose={onClose}
    >
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Commande">
          <input
            value={`${orderName(order)} · ${supplierName(workspace, order.supplierId)}`}
            disabled
          />
        </Field>
        <Field label="Date de réception" required error={dateError}>
          <input
            type="date"
            min={order.orderDate}
            max={todayIso()}
            value={receiptDate}
            onChange={(event) => setReceiptDate(event.target.value)}
          />
        </Field>
        <Field label="Référence">
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </Field>
        <Field label="Notes">
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        <div className="receipt-quantity-grid field--wide">
          <div className="receipt-quantity-grid__heading">
            <strong>Quantités reçues</strong>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() =>
                setQuantities(
                  Object.fromEntries(
                    eligible.map((line) => [
                      line.id,
                      supplierOrderLineProgress(order, line, workspace)
                        .remainingToReceiveMilli,
                    ]),
                  ),
                )
              }
            >
              Tout le reliquat
            </Button>
          </div>
          {eligible.map((line) => {
            const max = supplierOrderLineProgress(
              order,
              line,
              workspace,
            ).remainingToReceiveMilli;
            return (
              <label key={line.id}>
                <span>
                  <strong>{line.description}</strong>
                  <small>
                    Reste {formatCatalogQuantity(max)} {line.unit}
                  </small>
                </span>
                <input
                  aria-label={`Quantité reçue pour ${line.description}`}
                  type="number"
                  min="0"
                  max={max / 1_000}
                  step="0.001"
                  value={(quantities[line.id] || 0) / 1_000}
                  onChange={(event) =>
                    setQuantities((rows) => ({
                      ...rows,
                      [line.id]: milliFromNumber(event.target.value),
                    }))
                  }
                />
              </label>
            );
          })}
        </div>
        {quantityError ? (
          <ErrorPanel message={quantityError} />
        ) : !hasQuantity ? (
          <ErrorPanel message="Saisissez au moins une quantité reçue positive." />
        ) : null}
        <FormActions
          onCancel={onClose}
          busy={busy}
          disabled={Boolean(dateError || quantityError || !hasQuantity)}
          submitLabel="Enregistrer le brouillon"
        />
      </form>
    </Modal>
  );
}

function IssueReceiptModal({
  workspace,
  receipt,
  busy,
  onClose,
  onConfirm,
}: {
  workspace: Workspace;
  receipt: SupplierReceipt;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const order = workspace.supplierOrders.find(
    (candidate) => candidate.id === receipt.supplierOrderId,
  );
  return (
    <Modal
      wide
      title="Contrôler puis émettre la réception"
      description="Cette émission est l’événement qui augmente le stock pour les articles suivis."
      onClose={onClose}
    >
      {!order ? (
        <ErrorPanel message="La commande liée est introuvable. La réception ne peut pas être émise." />
      ) : (
        <>
          <div className="document-preview purchase-preview">
            <header>
              <div>
                <small>{receiptName(receipt)}</small>
                <h3>{supplierName(workspace, order.supplierId)}</h3>
                <p>
                  {orderName(order)} · reçu le {formatDate(receipt.receiptDate)}
                </p>
              </div>
              <StatusBadge status="draft" />
            </header>
            <div className="purchase-preview__lines">
              {receipt.lines.map((line) => {
                const orderLine = order.lines.find(
                  (candidate) => candidate.id === line.supplierOrderLineId,
                );
                return (
                  <div key={line.id}>
                    <span>
                      <strong>{line.description}</strong>
                      <small>
                        {orderLine?.fulfillmentMode === 'stocked_receipt'
                          ? 'Créera une entrée en stock'
                          : 'Réception sans suivi de stock'}
                      </small>
                    </span>
                    <strong>
                      {formatCatalogQuantity(line.quantityMilli)} {line.unit}
                    </strong>
                  </div>
                );
              })}
            </div>
            {receipt.reference ? (
              <p>
                <strong>Référence :</strong> {receipt.reference}
              </p>
            ) : null}
          </div>
          <div className="confirmation-callout">
            <PackageCheck size={19} />
            <p>
              Je confirme que ces quantités ont réellement été reçues à la date
              indiquée.
            </p>
          </div>
          <div className="form-actions">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Retour
            </Button>
            <Button
              disabled={busy || !receipt.lines.length}
              onClick={onConfirm}
            >
              Émettre la réception
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ReverseReceiptModal({
  workspace,
  receipt,
  busy,
  onClose,
  onConfirm,
}: {
  workspace: Workspace;
  receipt: SupplierReceipt;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const order = workspace.supplierOrders.find(
    (candidate) => candidate.id === receipt.supplierOrderId,
  );
  return (
    <Modal
      title="Extourner la réception"
      description="Une extourne conserve l’historique et crée les mouvements de stock inverses."
      onClose={onClose}
    >
      <Field
        label="Motif de la correction"
        required
        hint="Expliquez l’erreur ou le retour de marchandises."
      >
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          autoFocus
        />
      </Field>
      <div className="correction-preview">
        <strong>{receiptName(receipt)}</strong>
        <p>
          {order ? orderName(order) : receipt.supplierOrderId} ·{' '}
          {receipt.lines.length} ligne{receipt.lines.length > 1 ? 's' : ''}
        </p>
        {receipt.lines.map((line) => (
          <small key={line.id}>
            − {formatCatalogQuantity(line.quantityMilli)} {line.unit} ·{' '}
            {line.description}
          </small>
        ))}
      </div>
      <div className="form-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Annuler
        </Button>
        <Button
          variant="danger"
          disabled={busy || reason.trim().length < 8}
          onClick={() => onConfirm(reason)}
        >
          Confirmer l’extourne
        </Button>
      </div>
    </Modal>
  );
}

function CancelSupplierRemainderModal({
  workspace,
  order,
  busy,
  onClose,
  onConfirm,
}: {
  workspace: Workspace;
  order: SupplierOrder;
  busy: boolean;
  onClose: () => void;
  onConfirm: (
    reason: string,
    lines: Array<{ supplierOrderLineId: string; quantityMilli: number }>,
  ) => void;
}) {
  const cancelable = order.lines
    .map((line) => {
      const progress = supplierOrderLineProgress(order, line, workspace);
      return {
        line,
        max: Math.max(
          0,
          progress.effectiveQuantityMilli -
            Math.max(
              progress.receivedQuantityMilli,
              progress.matchedQuantityMilli,
            ),
        ),
      };
    })
    .filter((row) => row.max > 0);
  const [reason, setReason] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(cancelable.map(({ line, max }) => [line.id, max])),
  );
  const invalid =
    cancelable.some(({ line, max }) => (quantities[line.id] || 0) > max) ||
    !Object.values(quantities).some((value) => value > 0);
  return (
    <Modal
      wide
      title="Corriger le reliquat de commande"
      description="Annulez uniquement la part qui ne sera ni reçue ni rapprochée. Le motif restera dans l’historique."
      onClose={onClose}
    >
      <div className="receipt-quantity-grid">
        <div className="receipt-quantity-grid__heading">
          <strong>Quantités à annuler</strong>
          <small>{supplierName(workspace, order.supplierId)}</small>
        </div>
        {cancelable.map(({ line, max }) => (
          <label key={line.id}>
            <span>
              <strong>{line.description}</strong>
              <small>
                Maximum {formatCatalogQuantity(max)} {line.unit}
              </small>
            </span>
            <input
              type="number"
              min="0"
              max={max / 1_000}
              step="0.001"
              value={(quantities[line.id] || 0) / 1_000}
              onChange={(event) =>
                setQuantities((rows) => ({
                  ...rows,
                  [line.id]: milliFromNumber(event.target.value),
                }))
              }
            />
          </label>
        ))}
      </div>
      <Field label="Motif de la correction" required>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
        />
      </Field>
      <div className="correction-preview">
        <strong>Aperçu du reliquat annulé</strong>
        {cancelable
          .filter(({ line }) => (quantities[line.id] || 0) > 0)
          .map(({ line }) => (
            <small key={line.id}>
              − {formatCatalogQuantity(quantities[line.id])} {line.unit} ·{' '}
              {line.description}
            </small>
          ))}
      </div>
      <div className="form-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Annuler
        </Button>
        <Button
          variant="danger"
          disabled={busy || invalid || reason.trim().length < 8}
          onClick={() =>
            onConfirm(
              reason,
              cancelable
                .map(({ line }) => ({
                  supplierOrderLineId: line.id,
                  quantityMilli: quantities[line.id] || 0,
                }))
                .filter((line) => line.quantityMilli > 0),
            )
          }
        >
          Confirmer la correction
        </Button>
      </div>
    </Modal>
  );
}

function SupplierInvoiceMatchModal({
  workspace,
  order: initialOrder,
  initialInvoice,
  busy,
  onClose,
  onSave,
}: {
  workspace: Workspace;
  order: SupplierOrder;
  initialInvoice?: SupplierInvoice;
  busy: boolean;
  onClose: () => void;
  onSave: (
    input: Parameters<typeof desktopApi.saveSupplierInvoiceMatch>[0],
  ) => void;
}) {
  const supplierId = initialInvoice?.supplierId || initialOrder.supplierId;
  const eligibleOrders = workspace.supplierOrders.filter((candidate) => {
    if (candidate.supplierId !== supplierId || candidate.status !== 'confirmed')
      return false;
    const hasInitialInvoiceMatch = initialInvoice
      ? workspace.supplierInvoiceMatches.some(
          (match) =>
            match.supplierInvoiceId === initialInvoice.id &&
            match.supplierOrderId === candidate.id,
        )
      : false;
    return (
      candidate.id === initialOrder.id ||
      hasInitialInvoiceMatch ||
      candidate.lines.some(
        (line) =>
          supplierOrderLineMatchableMilli(line, workspace, candidate) > 0,
      )
    );
  });
  const eligibleInvoices = workspace.supplierInvoices.filter((candidate) => {
    if (
      candidate.supplierId !== supplierId ||
      candidate.documentStatus !== 'draft' ||
      (candidate.matchStatus === 'matched' &&
        candidate.id !== initialInvoice?.id)
    )
      return false;
    return true;
  });
  const [invoiceId, setInvoiceId] = useState(
    initialInvoice?.id || eligibleInvoices[0]?.id || '',
  );
  const invoice = eligibleInvoices.find(
    (candidate) => candidate.id === invoiceId,
  );
  const protectedSplitItemIds = invoice
    ? invoice.lines
        .filter((item) =>
          invoiceItemHasMultipleOrderLineMatches(
            workspace.supplierInvoiceMatches,
            invoice.id,
            item.id,
          ),
        )
        .map((item) => item.id)
    : [];
  const hasProtectedSplitMatches = protectedSplitItemIds.length > 0;
  const compatibleOrders = eligibleOrders.filter(
    (candidate) =>
      !invoice ||
      (candidate.currency === invoice.currency &&
        candidate.orderDate <= invoice.documentDate),
  );
  const [lineLinks, setLineLinks] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [confirmClear, setConfirmClear] = useState(false);

  function matchableForLine(
    order: SupplierOrder,
    line: SupplierOrder['lines'][number],
  ) {
    const base = supplierOrderLineMatchableMilli(line, workspace, order);
    const currentInvoiceMatched = invoice
      ? workspace.supplierInvoiceMatches
          .filter(
            (match) =>
              match.supplierInvoiceId === invoice.id &&
              match.supplierOrderLineId === line.id,
          )
          .reduce((total, match) => total + match.quantityMilli, 0)
      : 0;
    const progress = supplierOrderLineProgress(order, line, workspace);
    return replacementMatchableQuantity(
      base,
      currentInvoiceMatched,
      progress.effectiveQuantityMilli,
      progress.receivedQuantityMilli,
      line.fulfillmentMode,
    );
  }

  function selectedOrderAndLine(itemId: string) {
    const link = parseSupplierOrderLineLink(lineLinks[itemId] || '');
    if (!link) return null;
    const order = compatibleOrders.find(
      (candidate) => candidate.id === link.supplierOrderId,
    );
    const line = order?.lines.find(
      (candidate) => candidate.id === link.supplierOrderLineId,
    );
    return order && line ? { order, line } : null;
  }

  useEffect(() => {
    setConfirmClear(nextMatchClearConfirmation('selection-change'));
    if (!invoice) return;
    const nextLines: Record<string, string> = {};
    const nextQuantities: Record<string, number> = {};
    for (const item of invoice.lines) {
      const existingMatch = existingInvoiceItemMultiOrderMatchDraft(
        workspace.supplierInvoiceMatches,
        invoice.id,
        item.id,
      );
      if (existingMatch) {
        nextLines[item.id] = supplierOrderLineLinkValue(
          existingMatch.supplierOrderId,
          existingMatch.supplierOrderLineId,
        );
        nextQuantities[item.id] = existingMatch.quantityMilli;
        continue;
      }
      if (
        invoiceItemHasMultipleOrderLineMatches(
          workspace.supplierInvoiceMatches,
          invoice.id,
          item.id,
        )
      )
        continue;
      const normalizedItem = item.description.toLocaleLowerCase('fr-CH');
      const availableLines = compatibleOrders.flatMap((order) =>
        order.lines
          .filter((line) => matchableForLine(order, line) > 0)
          .map((line) => ({ order, line })),
      );
      const preferredLines = [
        ...availableLines.filter(({ order }) => order.id === initialOrder.id),
        ...availableLines.filter(({ order }) => order.id !== initialOrder.id),
      ];
      const selected =
        preferredLines.find(
          ({ line }) =>
            line.description
              .toLocaleLowerCase('fr-CH')
              .includes(normalizedItem) ||
            normalizedItem.includes(line.description.toLocaleLowerCase('fr-CH')),
        ) || (invoice.lines.length === 1 ? preferredLines[0] : undefined);
      if (!selected) continue;
      nextLines[item.id] = supplierOrderLineLinkValue(
        selected.order.id,
        selected.line.id,
      );
      nextQuantities[item.id] = Math.min(
        item.quantityMilli,
        matchableForLine(selected.order, selected.line),
      );
    }
    setLineLinks(nextLines);
    setQuantities(nextQuantities);
  }, [invoiceId]);

  function issuedReceiptsFor(orderId: string) {
    return workspace.supplierReceipts
      .filter(
        (receipt) =>
          receipt.supplierOrderId === orderId && receipt.status === 'issued',
      )
      .sort(
        (left, right) =>
          left.receiptDate.localeCompare(right.receiptDate) ||
          left.createdAt.localeCompare(right.createdAt),
      );
  }

  function receiptLinesFor(orderId: string, orderLineId: string) {
    return issuedReceiptsFor(orderId).flatMap((receipt) =>
      receipt.lines
        .filter((line) => line.supplierOrderLineId === orderLineId)
        .map((line) => ({ receipt, line })),
    );
  }

  function buildAllocationPreview() {
    const pending = receiptAllocationUsageOutsideInvoice(
      workspace.supplierInvoiceMatches,
      invoice?.id || '',
    );
    const allocations: Parameters<
      typeof desktopApi.saveSupplierInvoiceMatch
    >[0]['allocations'] = [];
    const missingItemIds: string[] = [];
    if (!invoice) return { allocations, missingItemIds };
    for (const item of invoice.lines) {
      const selected = selectedOrderAndLine(item.id);
      const quantityMilli = quantities[item.id] || 0;
      if (!selected) continue;
      const { order, line } = selected;
      if (quantityMilli <= 0) {
        missingItemIds.push(item.id);
        continue;
      }
      if (line.fulfillmentMode === 'direct') {
        allocations.push({
          supplierOrderId: order.id,
          supplierInvoiceItemId: item.id,
          supplierOrderLineId: line.id,
          supplierReceiptLineId: null,
          quantityMilli,
        });
        continue;
      }
      const receiptLines = receiptLinesFor(order.id, line.id).map(
        ({ line: row }) => ({
          id: row.id,
          quantityMilli: row.quantityMilli,
        }),
      );
      const split = allocateSupplierReceiptQuantity(
        quantityMilli,
        receiptLines,
        pending,
      );
      if (split.remainingMilli > 0) {
        missingItemIds.push(item.id);
        continue;
      }
      for (const part of split.allocations) {
        allocations.push({
          supplierOrderId: order.id,
          supplierInvoiceItemId: item.id,
          supplierOrderLineId: line.id,
          supplierReceiptLineId: part.supplierReceiptLineId,
          quantityMilli: part.quantityMilli,
        });
        pending.push(part);
      }
    }
    return { allocations, missingItemIds };
  }

  const preview = buildAllocationPreview();
  const previewAmountDifference = invoice
    ? supplierInvoiceMatchPreviewAmountDifference(
        invoice,
        compatibleOrders,
        preview.allocations,
        initialOrder.id,
      )
    : null;
  const globalAmountMismatch = Boolean(
    previewAmountDifference &&
      preview.allocations.length > 0 &&
      (previewAmountDifference.invalid ||
        Math.abs(previewAmountDifference.netCents) > 1 ||
        Math.abs(previewAmountDifference.vatCents) > 1 ||
        Math.abs(previewAmountDifference.totalCents) > 1),
  );
  const overAllocatedOrderLine = compatibleOrders.some((order) =>
    order.lines.some((line) => {
      const linkValue = supplierOrderLineLinkValue(order.id, line.id);
      const selected =
        invoice?.lines.reduce(
          (total, item) =>
            lineLinks[item.id] === linkValue
              ? total + (quantities[item.id] || 0)
              : total,
          0,
        ) || 0;
      return selected > matchableForLine(order, line);
    }),
  );
  const invalidItem = invoice?.lines.some((item) => {
    const selected = selectedOrderAndLine(item.id);
    const quantity = quantities[item.id] || 0;
    if (!selected) return false;
    return (
      quantity <= 0 ||
      quantity >
        Math.min(
          item.quantityMilli,
          matchableForLine(selected.order, selected.line),
        )
    );
  });
  const error = !invoice
    ? 'Aucune facture brouillon de ce fournisseur ne peut être rapprochée.'
    : hasProtectedSplitMatches
      ? `Cette facture contient ${protectedSplitItemIds.length} ligne${protectedSplitItemIds.length > 1 ? 's' : ''} déjà répartie${protectedSplitItemIds.length > 1 ? 's' : ''} sur plusieurs commandes. Pour éviter toute perte, retirez d’abord le rapprochement existant; aucune allocation ne sera remplacée par cet éditeur.`
      : compatibleOrders.length === 0
      ? 'Aucune commande confirmée de même fournisseur, devise et date ne peut être rapprochée.'
      : overAllocatedOrderLine
        ? 'Les allocations cumulées dépassent une ligne de commande.'
        : invalidItem
          ? 'Chaque ligne associée doit avoir une quantité encore disponible.'
          : preview.missingItemIds.length
            ? 'Les réceptions émises ne couvrent pas toutes les quantités demandées.'
            : preview.allocations.length === 0
              ? 'Rapprochez au moins une ligne de facture à la commande.'
              : '';
  const globalAmountWarning =
    globalAmountMismatch && previewAmountDifference
      ? `L’écart global de la facture dépasse 1 centime (HT ${formatMoney(previewAmountDifference.netCents)}, TVA ${formatMoney(previewAmountDifference.vatCents)}, TTC ${formatMoney(previewAmountDifference.totalCents)}).`
      : '';
  const hasExistingMatches = Boolean(
    invoice &&
    workspace.supplierInvoiceMatches.some(
      (match) => match.supplierInvoiceId === invoice.id,
    ),
  );
  const existingOrderIds = [
    ...new Set(
      workspace.supplierInvoiceMatches
        .filter((match) => match.supplierInvoiceId === invoice?.id)
        .map((match) => match.supplierOrderId),
    ),
  ];
  const linkedOrderCount = new Set(
    preview.allocations.map(
      (allocation) => allocation.supplierOrderId || initialOrder.id,
    ),
  ).size;

  function save() {
    if (!invoice || error) return;
    const primaryOrderId =
      preview.allocations[0]?.supplierOrderId || initialOrder.id;
    onSave({
      requestId: createId(),
      supplierInvoiceId: invoice.id,
      supplierOrderId: primaryOrderId,
      allocations: preview.allocations,
    });
  }

  return (
    <Modal
      wide
      title="Rapprocher commande, réception et facture"
      description="Seules les factures brouillon sont rapprochables. Zentra répartit automatiquement une quantité sur toutes les réceptions partielles émises."
      onClose={onClose}
    >
      <div className="form-grid">
        <Field label="Facture fournisseur" required>
          <select
            value={invoiceId}
            onChange={(event) => setInvoiceId(event.target.value)}
          >
            <option value="">Choisir…</option>
            {eligibleInvoices.map((row) => (
              <option key={row.id} value={row.id}>
                {row.reference || row.id} · {formatMoney(row.totalCents)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Commandes compatibles"
          hint="Chaque ligne peut pointer vers une commande différente. L’enregistrement remplace tous les liens en une seule opération."
        >
          <output className="field-output">
            {compatibleOrders.length} commande
            {compatibleOrders.length > 1 ? 's' : ''} disponible
            {compatibleOrders.length > 1 ? 's' : ''}
          </output>
        </Field>
      </div>
      {invoice ? (
        <div className="match-editor">
          <div className="match-editor__heading">
            <span>Ligne de facture</span>
            <span>Commande / ligne</span>
            <span>Réceptions</span>
            <span>Quantité</span>
            <span>Contrôle prix</span>
          </div>
          {invoice.lines.map((item) => {
            const selected = selectedOrderAndLine(item.id);
            const order = selected?.order;
            const line = selected?.line;
            const max = selected
              ? Math.min(
                  item.quantityMilli,
                  matchableForLine(selected.order, selected.line),
                )
              : 0;
            const quantity = quantities[item.id] || 0;
            const expectedNet = line?.quantityMilli
              ? Math.round((line.lineNetCents * quantity) / line.quantityMilli)
              : 0;
            const expectedVat = line?.quantityMilli
              ? Math.round((line.lineVatCents * quantity) / line.quantityMilli)
              : 0;
            const invoicedNet = item.quantityMilli
              ? Math.round((item.netCents * quantity) / item.quantityMilli)
              : 0;
            const invoicedVat = item.quantityMilli
              ? Math.round((item.vatCents * quantity) / item.quantityMilli)
              : 0;
            const netDifference = invoicedNet - expectedNet;
            const vatDifference = invoicedVat - expectedVat;
            const amountsConcord =
              !globalAmountMismatch &&
              Math.abs(netDifference) <= 1 &&
              Math.abs(vatDifference) <= 1;
            const splitParts = preview.allocations.filter(
              (allocation) =>
                allocation.supplierInvoiceItemId === item.id &&
                allocation.supplierReceiptLineId,
            );
            return (
              <div key={item.id}>
                <span data-mobile-label="Ligne de facture">
                  <strong>{item.description}</strong>
                  <small>{formatMoney(item.totalCents)}</small>
                </span>
                <label data-mobile-label="Commande / ligne">
                  <select
                    aria-label={`Commande et ligne pour ${item.description}`}
                    value={lineLinks[item.id] || ''}
                    disabled={hasProtectedSplitMatches}
                    onChange={(event) => {
                      const nextLink = parseSupplierOrderLineLink(
                        event.target.value,
                      );
                      const nextOrder = compatibleOrders.find(
                        (row) => row.id === nextLink?.supplierOrderId,
                      );
                      const next = nextOrder?.lines.find(
                        (row) => row.id === nextLink?.supplierOrderLineId,
                      );
                      setLineLinks((rows) => ({
                        ...rows,
                        [item.id]: event.target.value,
                      }));
                      setQuantities((rows) => ({
                        ...rows,
                        [item.id]: next && nextOrder
                          ? Math.min(
                              item.quantityMilli,
                              matchableForLine(nextOrder, next),
                            )
                          : 0,
                      }));
                    }}
                  >
                    <option value="">Hors commande / ne pas rapprocher</option>
                    {compatibleOrders.map((candidateOrder) => (
                      <optgroup
                        key={candidateOrder.id}
                        label={`${orderName(candidateOrder)} · ${formatDate(candidateOrder.orderDate)}`}
                      >
                        {candidateOrder.lines
                          .filter(
                            (row) =>
                              matchableForLine(candidateOrder, row) > 0,
                          )
                          .map((row) => (
                            <option
                              key={row.id}
                              value={supplierOrderLineLinkValue(
                                candidateOrder.id,
                                row.id,
                              )}
                            >
                              {row.description}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                {!line ? (
                  <span
                    className="match-editor__direct"
                    data-mobile-label="Réceptions"
                  >
                    Hors commande
                  </span>
                ) : line.fulfillmentMode === 'direct' ? (
                  <span
                    className="match-editor__direct"
                    data-mobile-label="Réceptions"
                  >
                    Sans réception
                  </span>
                ) : (
                  <span
                    className="match-editor__automatic"
                    data-mobile-label="Réceptions"
                  >
                    <strong>Répartition automatique</strong>
                    <small>
                      {splitParts.length
                        ? splitParts
                            .map((part) => {
                              const link = order
                                ? issuedReceiptsFor(order.id)
                                .flatMap((receipt) =>
                                  receipt.lines.map((receiptLine) => ({
                                    receipt,
                                    receiptLine,
                                  })),
                                )
                                .find(
                                  ({ receiptLine }) =>
                                    receiptLine.id ===
                                    part.supplierReceiptLineId,
                                )
                                : undefined;
                              return `${link ? receiptName(link.receipt) : 'Réception'} ${formatCatalogQuantity(part.quantityMilli)}`;
                            })
                            .join(' + ')
                        : 'Aucune quantité disponible'}
                    </small>
                  </span>
                )}
                <label data-mobile-label="Quantité">
                  <input
                    aria-label={`Quantité rapprochée pour ${item.description}`}
                    type="number"
                    min={line ? '0.001' : '0'}
                    max={max / 1_000}
                    step="0.001"
                    value={quantity / 1_000}
                    disabled={!line || hasProtectedSplitMatches}
                    onChange={(event) =>
                      setQuantities((rows) => ({
                        ...rows,
                        [item.id]: milliFromNumber(event.target.value),
                      }))
                    }
                  />
                </label>
                <span
                  data-mobile-label="Contrôle prix"
                  className={
                    !line
                      ? 'match-control is-neutral'
                      : amountsConcord
                        ? 'match-control is-green'
                        : 'match-control is-red'
                  }
                >
                  {!line
                    ? 'Non rapprochée'
                    : amountsConcord
                      ? 'Concorde'
                      : globalAmountMismatch
                        ? 'Écart global à corriger'
                        : `Écart HT ${formatMoney(netDifference)} · TVA ${formatMoney(vatDifference)}`}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {confirmClear ? (
        <div className="correction-preview" role="alert">
          <strong>Confirmer le retrait du rapprochement ?</strong>
          <p>
            {
              workspace.supplierInvoiceMatches.filter(
                (match) => match.supplierInvoiceId === invoice?.id,
              ).length
            }{' '}
            allocations sur {existingOrderIds.length} commande
            {existingOrderIds.length > 1 ? 's' : ''} seront dissociées. La
            facture restera en brouillon et aucune réception ne sera supprimée.
          </p>
        </div>
      ) : error ? (
        <ErrorPanel message={error} />
      ) : globalAmountWarning ? (
        <div className="correction-preview" role="alert">
          <strong>Écart global à corriger</strong>
          <p>
            {globalAmountWarning} Le rapprochement peut rester en brouillon,
            mais la facture ne sera ni marquée « Concorde » ni validable et
            aucune commande ne sera clôturée.
          </p>
        </div>
      ) : (
        <div className="confirmation-callout">
          <ClipboardCheck size={19} />
          <p>
            Contrôlez les associations sur {linkedOrderCount} commande
            {linkedOrderCount > 1 ? 's' : ''}, la répartition des réceptions
            partielles et les écarts. Chaque commande complète sera clôturée
            lors de la validation de la facture si tout concorde.
          </p>
        </div>
      )}
      <div className="form-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Annuler
        </Button>
        {hasExistingMatches && invoice ? (
          <Button
            variant={confirmClear ? 'danger' : 'ghost'}
            disabled={busy}
            onClick={() => {
              if (!confirmClear)
                return setConfirmClear(nextMatchClearConfirmation('request'));
              onSave({
                requestId: createId(),
                supplierInvoiceId: invoice.id,
                supplierOrderId: existingOrderIds[0] || initialOrder.id,
                allocations: [],
              });
            }}
          >
            {confirmClear
              ? 'Oui, retirer les liens'
              : 'Retirer le rapprochement'}
          </Button>
        ) : null}
        <Button
          disabled={busy || Boolean(error) || confirmClear}
          onClick={save}
        >
          Enregistrer le rapprochement
        </Button>
      </div>
    </Modal>
  );
}

function SupplierCreditNoteForm({
  workspace,
  invoice,
  credit,
  busy,
  onClose,
  onSave,
}: {
  workspace: Workspace;
  invoice?: SupplierInvoice;
  credit?: SupplierCreditNote;
  busy: boolean;
  onClose: () => void;
  onSave: (
    input: Parameters<typeof desktopApi.saveSupplierCreditNoteDraft>[0],
  ) => void;
}) {
  const [supplierId, setSupplierId] = useState(
    credit?.supplierId ||
      invoice?.supplierId ||
      workspace.suppliers.find((supplier) => !supplier.archivedAt)?.id ||
      '',
  );
  const [documentDate, setDocumentDate] = useState(
    credit?.documentDate || todayIso(),
  );
  const [reference, setReference] = useState(credit?.reference || '');
  const [note, setNote] = useState(credit?.note || '');
  const [lines, setLines] = useState<CreditDraftLine[]>(
    () =>
      credit?.items.map((item) => ({
        id: item.id,
        description: item.description,
        quantityMilli: item.quantityMilli,
        unit: item.unit,
        unitPriceCents: item.unitPriceCents,
        discountBp: item.discountBp,
        vatBp: item.vatBp,
        category: item.category,
        expenseAccountId: item.expenseAccountId || '',
        projectId: item.projectId || '',
      })) ||
      invoice?.lines.map((item) => ({
        id: createId(),
        description: item.description,
        quantityMilli: item.quantityMilli,
        unit: item.unit,
        unitPriceCents: item.unitPriceCents,
        discountBp: item.discountBp,
        vatBp: item.vatBp,
        category: item.category,
        expenseAccountId: item.expenseAccountId || '',
        projectId: item.projectId || '',
      })) || [emptyCreditLine(workspace)],
  );
  const [allocations, setAllocations] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      (
        credit?.allocations ||
        (invoice
          ? [
              {
                supplierInvoiceId: invoice.id,
                amountCents: invoice.balanceCents,
              },
            ]
          : [])
      ).map((allocation) => [
        allocation.supplierInvoiceId,
        allocation.amountCents,
      ]),
    ),
  );
  const [error, setError] = useState('');
  const totals = orderDraftTotals(lines);
  const vatOptions = purchaseVatOptions(
    Boolean(workspace.settings?.organization.vatRegistered),
    workspace.settings?.billing.vatRatesBp || [],
  );
  const invoices = workspace.supplierInvoices.filter(
    (row) =>
      row.supplierId === supplierId &&
      row.documentStatus === 'validated' &&
      (row.balanceCents > 0 || (allocations[row.id] || 0) > 0),
  );
  const allocatedCents = Object.values(allocations).reduce(
    (total, amount) => total + amount,
    0,
  );
  const patchLine = (id: string, patch: Partial<CreditDraftLine>) =>
    setLines((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  function save() {
    if (!supplierId || !reference.trim())
      return setError(
        'Choisissez un fournisseur et renseignez la référence de l’avoir.',
      );
    if (
      !lines.length ||
      lines.some(
        (line) =>
          !line.description.trim() ||
          line.quantityMilli <= 0 ||
          !line.category.trim(),
      )
    )
      return setError(
        'Chaque ligne doit avoir une description, une quantité positive et une catégorie.',
      );
    if (
      allocatedCents > totals.totalCents ||
      invoices.some((row) => (allocations[row.id] || 0) > row.balanceCents)
    )
      return setError(
        'Les allocations ne peuvent dépasser ni l’avoir ni le solde des factures.',
      );
    setError('');
    onSave({
      id: credit?.id,
      supplierId,
      documentDate,
      reference,
      note,
      items: lines.map((line) => ({
        id: credit?.items.some((item) => item.id === line.id)
          ? line.id
          : undefined,
        description: line.description.trim(),
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPriceCents: line.unitPriceCents,
        discountBp: line.discountBp,
        vatBp: line.vatBp,
        category: line.category,
        expenseAccountId: line.expenseAccountId || null,
        projectId: line.projectId || null,
      })),
      allocations: Object.entries(allocations)
        .filter(([, amount]) => amount > 0)
        .map(([supplierInvoiceId, amountCents]) => ({
          supplierInvoiceId,
          amountCents,
        })),
    });
  }
  return (
    <Modal
      wide
      title={
        credit ? 'Modifier l’avoir fournisseur' : 'Nouvel avoir fournisseur'
      }
      description="Préparez le brouillon et choisissez les factures compensées. La validation comptable se fera dans un second contrôle."
      onClose={onClose}
    >
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field label="Fournisseur" required>
          <select
            value={supplierId}
            onChange={(event) => {
              setSupplierId(event.target.value);
              setAllocations({});
            }}
          >
            <option value="">Choisir…</option>
            {workspace.suppliers
              .filter(
                (supplier) =>
                  !supplier.archivedAt || supplier.id === supplierId,
              )
              .map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Date" required>
          <input
            type="date"
            max={todayIso()}
            value={documentDate}
            onChange={(event) => setDocumentDate(event.target.value)}
          />
        </Field>
        <Field label="Référence fournisseur" required>
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </Field>
        <Field label="Note">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <div className="purchase-line-editor field--wide">
          <div className="purchase-line-editor__heading">
            <div>
              <strong>Lignes de l’avoir</strong>
              <small>Les montants seront négatifs après validation.</small>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() =>
                setLines((rows) => [...rows, emptyCreditLine(workspace)])
              }
            >
              <Plus size={14} /> Ajouter
            </Button>
          </div>
          {lines.map((line, index) => (
            <div
              className="purchase-line-editor__row purchase-line-editor__row--credit"
              key={line.id}
            >
              <div className="purchase-line-editor__index">{index + 1}</div>
              <Field label="Description" required>
                <input
                  value={line.description}
                  onChange={(event) =>
                    patchLine(line.id, { description: event.target.value })
                  }
                />
              </Field>
              <Field label="Quantité">
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={line.quantityMilli / 1_000}
                  onChange={(event) =>
                    patchLine(line.id, {
                      quantityMilli: milliFromNumber(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Unité">
                <input
                  value={line.unit}
                  onChange={(event) =>
                    patchLine(line.id, { unit: event.target.value })
                  }
                />
              </Field>
              <Field label="Prix HT">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={line.unitPriceCents / 100}
                  onChange={(event) =>
                    patchLine(line.id, {
                      unitPriceCents: centsFromNumber(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Rabais %">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={line.discountBp / 100}
                  onChange={(event) =>
                    patchLine(line.id, {
                      discountBp: basisPointsFromNumber(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="TVA %">
                <select
                  value={line.vatBp / 100}
                  onChange={(event) =>
                    patchLine(line.id, {
                      vatBp: basisPointsFromNumber(event.target.value),
                    })
                  }
                >
                  {vatOptions.map((rate) => (
                    <option key={rate} value={rate / 100}>
                      {(rate / 100).toLocaleString('fr-CH')} %
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Catégorie">
                <input
                  value={line.category}
                  onChange={(event) =>
                    patchLine(line.id, { category: event.target.value })
                  }
                />
              </Field>
              <div className="purchase-line-editor__total">
                <small>Total</small>
                <strong>
                  {formatMoney(supplierDraftLineTotals(line).totalCents)}
                </strong>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={lines.length === 1}
                onClick={() =>
                  setLines((rows) => rows.filter((row) => row.id !== line.id))
                }
                aria-label={`Supprimer la ligne ${index + 1}`}
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))}
          <div className="purchase-line-editor__summary">
            <span>
              HT <strong>{formatMoney(totals.netCents)}</strong>
            </span>
            <span>
              TVA <strong>{formatMoney(totals.vatCents)}</strong>
            </span>
            <span>
              Total avoir <strong>{formatMoney(totals.totalCents)}</strong>
            </span>
          </div>
        </div>
        <div className="credit-allocation field--wide">
          <div>
            <strong>Compensation des factures</strong>
            <small>
              Facultatif au brouillon · maximum {formatMoney(totals.totalCents)}
            </small>
          </div>
          {invoices.length ? (
            invoices.map((row) => (
              <label key={row.id}>
                <span>
                  <strong>{row.reference || row.id}</strong>
                  <small>Solde {formatMoney(row.balanceCents)}</small>
                </span>
                <input
                  type="number"
                  min="0"
                  max={row.balanceCents / 100}
                  step="0.01"
                  value={(allocations[row.id] || 0) / 100}
                  onChange={(event) =>
                    setAllocations((values) => ({
                      ...values,
                      [row.id]: centsFromNumber(event.target.value),
                    }))
                  }
                />
              </label>
            ))
          ) : (
            <p>Aucune facture validée avec un solde pour ce fournisseur.</p>
          )}
          <strong>Alloué : {formatMoney(allocatedCents)}</strong>
        </div>
        {error ? <ErrorPanel message={error} /> : null}
        <FormActions
          onCancel={onClose}
          busy={busy}
          submitLabel="Enregistrer le brouillon"
        />
      </form>
    </Modal>
  );
}

function ValidateCreditNoteModal({
  credit,
  workspace,
  busy,
  onClose,
  onConfirm,
}: {
  credit: SupplierCreditNote;
  workspace: Workspace;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const allocatedCents = credit.allocations.reduce(
    (total, allocation) => total + allocation.amountCents,
    0,
  );
  const invalidAllocation = credit.allocations.find((allocation) => {
    const invoice = workspace.supplierInvoices.find(
      (row) => row.id === allocation.supplierInvoiceId,
    );
    return (
      !invoice ||
      invoice.supplierId !== credit.supplierId ||
      invoice.documentStatus !== 'validated' ||
      allocation.amountCents <= 0 ||
      allocation.amountCents > invoice.balanceCents
    );
  });
  const allocationError =
    allocatedCents > credit.totalCents
      ? 'Les factures compensées dépassent le total de l’avoir. Revenez au brouillon pour corriger les montants.'
      : invalidAllocation
        ? 'Une facture compensée n’existe plus, n’est plus validée ou son solde est devenu insuffisant. Revenez au brouillon pour corriger l’allocation.'
        : '';
  return (
    <Modal
      wide
      title="Contrôler puis valider l’avoir"
      description="La validation fige l’avoir, crée l’écriture comptable et réduit les soldes selon les allocations."
      onClose={onClose}
    >
      <div className="document-preview purchase-preview">
        <header>
          <div>
            <small>{credit.number || 'Avoir brouillon'}</small>
            <h3>
              {credit.supplierName ||
                supplierName(workspace, credit.supplierId)}
            </h3>
            <p>
              {credit.reference} · {formatDate(credit.documentDate)}
            </p>
          </div>
          <strong>− {formatMoney(credit.totalCents)}</strong>
        </header>
        <div className="purchase-preview__lines">
          {credit.items.map((item) => (
            <div key={item.id}>
              <span>
                <strong>{item.description}</strong>
                <small>
                  {formatCatalogQuantity(item.quantityMilli)} {item.unit}
                </small>
              </span>
              <strong>{formatMoney(item.totalCents)}</strong>
            </div>
          ))}
        </div>
        <div className="credit-preview-allocations">
          <strong>Factures compensées</strong>
          {credit.allocations.length ? (
            credit.allocations.map((allocation) => {
              const invoice = workspace.supplierInvoices.find(
                (row) => row.id === allocation.supplierInvoiceId,
              );
              return (
                <p key={allocation.id}>
                  <span>
                    {invoice?.reference || allocation.supplierInvoiceId}
                  </span>
                  <strong>{formatMoney(allocation.amountCents)}</strong>
                </p>
              );
            })
          ) : (
            <p>Aucune allocation : l’avoir restera disponible.</p>
          )}
        </div>
      </div>
      {allocationError ? (
        <ErrorPanel message={allocationError} />
      ) : (
        <div className="confirmation-callout">
          <FileCheck2 size={19} />
          <p>
            Je confirme le fournisseur, les lignes, la TVA et les factures
            compensées. Cette validation est définitive.
          </p>
        </div>
      )}
      <div className="form-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Retour au brouillon
        </Button>
        <Button
          disabled={busy || !credit.items.length || Boolean(allocationError)}
          onClick={onConfirm}
        >
          Valider et comptabiliser
        </Button>
      </div>
    </Modal>
  );
}

function ApplySupplierCreditModal({
  credit,
  workspace,
  busy,
  onClose,
  onConfirm,
}: {
  credit: SupplierCreditNote;
  workspace: Workspace;
  busy: boolean;
  onClose: () => void;
  onConfirm: (invoiceId: string, amountCents: number) => void;
}) {
  const availableCents = Math.max(0, credit.totalCents - credit.allocatedCents);
  const invoices = workspace.supplierInvoices.filter(
    (invoice) =>
      invoice.supplierId === credit.supplierId &&
      invoice.documentStatus === 'validated' &&
      invoice.balanceCents > 0,
  );
  const [invoiceId, setInvoiceId] = useState(invoices[0]?.id || '');
  const invoice = invoices.find((row) => row.id === invoiceId);
  const [amountCents, setAmountCents] = useState(
    Math.min(availableCents, invoices[0]?.balanceCents || 0),
  );
  useEffect(() => {
    const selected = invoices.find((row) => row.id === invoiceId);
    setAmountCents(Math.min(availableCents, selected?.balanceCents || 0));
  }, [invoiceId]);
  const error = !invoice
    ? 'Aucune facture validée avec un solde n’est disponible pour ce fournisseur.'
    : amountCents <= 0
      ? 'Saisissez un montant positif.'
      : amountCents > availableCents
        ? 'Le montant dépasse le solde disponible de l’avoir.'
        : amountCents > invoice.balanceCents
          ? 'Le montant dépasse le solde de la facture.'
          : '';
  return (
    <Modal
      title="Imputer l’avoir sur une facture"
      description="L’avoir validé reste disponible jusqu’à son imputation. Cette opération réduit le solde de la facture choisie."
      onClose={onClose}
    >
      <div className="form-grid">
        <Field label="Avoir disponible">
          <input disabled value={formatMoney(availableCents)} />
        </Field>
        <Field label="Facture" required>
          <select
            value={invoiceId}
            onChange={(event) => setInvoiceId(event.target.value)}
          >
            <option value="">Choisir…</option>
            {invoices.map((row) => (
              <option key={row.id} value={row.id}>
                {row.reference || row.id} · solde{' '}
                {formatMoney(row.balanceCents)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Montant imputé" required>
          <input
            type="number"
            min="0.01"
            max={Math.min(availableCents, invoice?.balanceCents || 0) / 100}
            step="0.01"
            value={amountCents / 100}
            onChange={(event) =>
              setAmountCents(centsFromNumber(event.target.value))
            }
          />
        </Field>
      </div>
      {error ? (
        <ErrorPanel message={error} />
      ) : (
        <div className="correction-preview">
          <strong>Aperçu de l’imputation</strong>
          <small>
            {credit.number || credit.reference} : − {formatMoney(amountCents)}
          </small>
          <small>
            {invoice?.reference || invoiceId} : nouveau solde{' '}
            {formatMoney((invoice?.balanceCents || 0) - amountCents)}
          </small>
        </div>
      )}
      <div className="form-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Annuler
        </Button>
        <Button
          disabled={busy || Boolean(error)}
          onClick={() => onConfirm(invoiceId, amountCents)}
        >
          Confirmer l’imputation
        </Button>
      </div>
    </Modal>
  );
}

function ReverseSupplierCreditAllocationModal({
  credit,
  allocation,
  workspace,
  busy,
  onClose,
  onConfirm,
}: {
  credit: SupplierCreditNote;
  allocation: SupplierCreditAllocation;
  workspace: Workspace;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const invoice = workspace.supplierInvoices.find(
    (row) => row.id === allocation.supplierInvoiceId,
  );
  return (
    <Modal
      title="Extourner l’imputation de l’avoir"
      description="L’historique reste intact. L’extourne rend le montant disponible sur l’avoir et le rétablit sur la facture."
      onClose={onClose}
    >
      <Field label="Motif de l’extourne" required hint="Au moins 8 caractères.">
        <textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <div className="correction-preview">
        <strong>Aperçu de l’extourne</strong>
        <small>
          Avoir {credit.number || credit.reference} : +{' '}
          {formatMoney(allocation.amountCents)} disponible
        </small>
        <small>
          Facture {invoice?.reference || allocation.supplierInvoiceId} : +{' '}
          {formatMoney(allocation.amountCents)} à payer
        </small>
      </div>
      <div className="form-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Annuler
        </Button>
        <Button
          variant="danger"
          disabled={busy || reason.trim().length < 8}
          onClick={() => onConfirm(reason)}
        >
          Confirmer l’extourne
        </Button>
      </div>
    </Modal>
  );
}

function SupplierExpenseReclassificationModal({
  workspace,
  invoice,
  busy,
  onClose,
  onConfirm,
}: {
  workspace: Workspace;
  invoice: SupplierInvoice;
  busy: boolean;
  onClose: () => void;
  onConfirm: (
    input: Parameters<typeof desktopApi.reclassifySupplierInvoiceExpense>[0],
  ) => void;
}) {
  const reclassifications = workspace.supplierExpenseReclassifications
    .filter((row) => row.supplierInvoiceId === invoice.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const currentAccountByItem = Object.fromEntries(
    invoice.lines.map((line) => {
      const latestLine = reclassifications
        .flatMap((row) => row.lines)
        .filter((row) => row.supplierInvoiceItemId === line.id)
        .at(-1);
      return [
        line.id,
        latestLine?.newExpenseAccountId || line.postedExpenseAccountId || '',
      ];
    }),
  );
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [accountByItem, setAccountByItem] =
    useState<Record<string, string>>(currentAccountByItem);
  useEffect(() => {
    let active = true;
    void desktopApi
      .listAccounts()
      .then((rows) => {
        if (active)
          setAccounts(
            rows.filter(
              (account) => account.active && account.accountType === 'expense',
            ),
          );
      })
      .catch((reasonValue) => {
        if (active)
          setLoadError(
            errorMessage(
              reasonValue,
              'Le plan comptable n’a pas pu être chargé.',
            ),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const changedLines = invoice.lines.filter(
    (line) =>
      Boolean(currentAccountByItem[line.id]) &&
      Boolean(accountByItem[line.id]) &&
      accountByItem[line.id] !== currentAccountByItem[line.id],
  );
  const unresolvedLines = invoice.lines.filter(
    (line) => !currentAccountByItem[line.id],
  );
  const invalid =
    !reason.trim() ||
    reason.trim().length < 8 ||
    !effectiveDate ||
    effectiveDate < invoice.documentDate ||
    effectiveDate > todayIso() ||
    changedLines.length === 0;
  return (
    <Modal
      wide
      title="Corriger l’imputation de charge"
      description="La facture validée reste intacte. Zentra crée une écriture de reclassement datée, motivée et traçable."
      onClose={onClose}
    >
      {loadError ? (
        <ErrorPanel message={loadError} />
      ) : loading ? (
        <p>Chargement du plan comptable…</p>
      ) : (
        <>
          <div className="form-grid">
            <Field
              label="Date d’effet"
              required
              hint={`Entre le ${formatDate(invoice.documentDate)} et aujourd’hui.`}
            >
              <input
                type="date"
                min={invoice.documentDate}
                max={todayIso()}
                value={effectiveDate}
                onChange={(event) => setEffectiveDate(event.target.value)}
              />
            </Field>
            <Field label="Motif" required hint="Au moins 8 caractères.">
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          </div>
          <div className="reclassification-preview">
            <div className="reclassification-preview__heading">
              <span>Ligne</span>
              <span>Compte actuel</span>
              <span>Nouveau compte</span>
              <span>Montant HT</span>
            </div>
            {invoice.lines.map((line) => {
              const currentAccountId = currentAccountByItem[line.id];
              const currentAccount = accounts.find(
                (account) => account.id === currentAccountId,
              );
              return (
                <div key={line.id}>
                  <span data-mobile-label="Ligne">
                    <strong>{line.description}</strong>
                  </span>
                  <span data-mobile-label="Compte actuel">
                    {currentAccount
                      ? `${currentAccount.code} · ${currentAccount.name}`
                      : currentAccountId || 'Compte général'}
                  </span>
                  <label data-mobile-label="Nouveau compte">
                    <select
                      aria-label={`Nouveau compte pour ${line.description}`}
                      disabled={!currentAccountId}
                      value={accountByItem[line.id] || ''}
                      onChange={(event) =>
                        setAccountByItem((rows) => ({
                          ...rows,
                          [line.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Choisir…</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} · {account.name}
                          {account.id === currentAccountId ? ' (actuel)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <strong data-mobile-label="Montant HT">
                    {formatMoney(line.netCents)}
                  </strong>
                </div>
              );
            })}
          </div>
          {unresolvedLines.length ? (
            <ErrorPanel message="Le compte historiquement comptabilisé manque sur certaines anciennes lignes. Zentra les laisse intactes; seules les lignes dont la source est certaine peuvent être reclassées." />
          ) : null}
          {!changedLines.length ? (
            <ErrorPanel message="Choisissez un nouveau compte pour au moins une ligne. Les lignes inchangées ne seront pas réécrites." />
          ) : (
            <div className="confirmation-callout">
              <ShieldCheck size={19} />
              <p>
                Aperçu : une écriture reclassera uniquement les lignes modifiées
                sans changer la pièce fournisseur d’origine.
              </p>
            </div>
          )}
          <div className="form-actions">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Annuler
            </Button>
            <Button
              disabled={busy || invalid}
              onClick={() =>
                onConfirm({
                  requestId: createId(),
                  supplierInvoiceId: invoice.id,
                  effectiveDate,
                  reason,
                  lines: changedLines.map((line) => ({
                    supplierInvoiceItemId: line.id,
                    newExpenseAccountId: accountByItem[line.id],
                  })),
                })
              }
            >
              Confirmer la correction
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
