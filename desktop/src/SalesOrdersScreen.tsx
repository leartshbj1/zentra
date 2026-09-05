import { convertFileSrc } from '@tauri-apps/api/core';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  Box,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  LockKeyhole,
  PackageCheck,
  Printer,
  Receipt,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Truck,
  UserRound,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { desktopApi } from './bridge';
import { formatCatalogQuantity, stockQuantityFromInput } from './catalog';
import { RecurringDocumentsPanel } from './RecurringDocumentsPanel';
import {
  pendingRecurringOccurrenceCount,
  recurrenceOrderEligibility,
} from './recurrenceUi';
import {
  availabilityForCatalogItem,
  canCancelSalesOrderCompletely,
  canReverseDeliveryNote,
  cancellableSalesOrderRemainder,
  confirmationShortages,
  defaultDeliveryAllocations,
  defaultInvoiceAllocations,
  deliveryDateValidationError,
  nextSalesOrderAction,
  salesOrderInvoiceDateValidationError,
  salesOrderDisplayStatus,
  salesOrderLineProgress,
  salesOrderProgress,
  type InvoiceAllocationDraft,
  type RemainderCancellationDraft,
  type SalesOrderNextAction,
} from './orderFlow';
import type {
  DeliveryNote,
  Invoice,
  SalesOrder,
  SalesOrderInvoicePreview,
  Workspace,
} from './types';
import {
  createId,
  documentTotals,
  errorMessage,
  formatDate,
  formatMoney,
  searchText,
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
  submitForm,
} from './ui';

type ActionRunner = (
  action: () => Promise<Workspace>,
  message: string,
  close?: boolean,
  onError?: (reason: unknown) => void,
) => Promise<boolean>;

type OrderCorrectionAction =
  | { kind: 'cancel_order' }
  | { kind: 'cancel_remainder'; lines: RemainderCancellationDraft[] }
  | { kind: 'reverse_delivery'; note: DeliveryNote }
  | { kind: 'cancel_invoice'; invoice: Invoice };

export type SalesView = 'quotes' | 'orders' | 'invoices';

export function SalesTabs({
  active,
  onChange,
}: {
  active: SalesView;
  onChange: (view: SalesView) => void;
}) {
  return (
    <nav className="sales-tabs" aria-label="Cycle de vente">
      {(
        [
          ['quotes', 'Devis'],
          ['orders', 'Commandes'],
          ['invoices', 'Factures'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={active === id ? 'is-active' : ''}
          aria-current={active === id ? 'page' : undefined}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export function SalesOrdersScreen({
  workspace,
  query,
  busy,
  readOnly,
  act,
  openOrderId,
  onOpenOrderHandled,
  onShowQuotes,
  onOpenInvoice,
  onIssueInvoice,
  onPrintOrder,
  onPrintDelivery,
}: {
  workspace: Workspace;
  query: string;
  busy: boolean;
  readOnly: boolean;
  act: ActionRunner;
  openOrderId?: string | null;
  onOpenOrderHandled?: () => void;
  onShowQuotes: () => void;
  onOpenInvoice: (invoice: Invoice) => void;
  onIssueInvoice: (invoice: Invoice) => void;
  onPrintOrder: (order: SalesOrder) => void;
  onPrintDelivery: (note: DeliveryNote) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const previousQuery = useRef(query);
  useEffect(() => {
    if (query !== previousQuery.current) {
      previousQuery.current = query;
      setSelectedId(null);
    }
  }, [query]);
  const selected = workspace.salesOrders.find(
    (order) => order.id === selectedId,
  );
  const filtered = useMemo(
    () =>
      workspace.salesOrders.filter((order) => {
        const client = workspace.clients.find(
          (item) => item.id === order.clientId,
        );
        return searchText(
          [order.number, order.title, client?.company, client?.name],
          query,
        );
      }),
    [query, workspace.clients, workspace.salesOrders],
  );

  useEffect(() => {
    if (
      openOrderId &&
      workspace.salesOrders.some((order) => order.id === openOrderId)
    ) {
      setSelectedId(openOrderId);
      onOpenOrderHandled?.();
    }
  }, [onOpenOrderHandled, openOrderId, workspace.salesOrders]);

  if (selected)
    return (
      <SalesOrderDetail
        order={selected}
        workspace={workspace}
        busy={busy}
        readOnly={readOnly}
        act={act}
        onBack={() => setSelectedId(null)}
        onOpenInvoice={onOpenInvoice}
        onIssueInvoice={onIssueInvoice}
        onPrintOrder={onPrintOrder}
        onPrintDelivery={onPrintDelivery}
      />
    );

  if (!workspace.salesOrders.length)
    return (
      <EmptyState
        icon={<ClipboardCheck size={27} />}
        title="Aucune commande client"
        text="Créez une commande depuis un devis accepté pour gérer une livraison ou préparer un modèle de facturation récurrente. Un service ponctuel peut rester dans le flux de facture simple."
        actionLabel="Voir les devis"
        onAction={onShowQuotes}
      />
    );

  return (
    <div className="stack-layout sales-orders-screen">
      <div
        className="summary-strip order-summary-strip"
        aria-label="Résumé des commandes"
      >
        <div>
          <span>À confirmer</span>
          <strong>
            {
              workspace.salesOrders.filter((order) => order.status === 'draft')
                .length
            }
          </strong>
        </div>
        <div>
          <span>À exécuter</span>
          <strong>
            {
              workspace.salesOrders.filter(
                (order) => order.status === 'confirmed',
              ).length
            }
          </strong>
        </div>
        <div>
          <span>Terminées</span>
          <strong>
            {
              workspace.salesOrders.filter((order) => order.status === 'closed')
                .length
            }
          </strong>
        </div>
      </div>
      <section className="panel sales-order-list-panel">
        <SectionHeading
          eyebrow="Exécution commerciale"
          title="Commandes client"
          description="Chaque commande montre ce qui est réservé, livré et facturé. Zentra propose une seule prochaine action à la fois."
        />
        <ul className="sales-order-list">
          {filtered.map((order) => {
            const client = workspace.clients.find(
              (item) => item.id === order.clientId,
            );
            const progress = salesOrderProgress(order, workspace);
            const display = salesOrderDisplayStatus(order, workspace);
            const recurrence = workspace.recurrenceSchedules.find(
              (schedule) => schedule.sourceSalesOrderId === order.id,
            );
            const recurrenceLabel = recurrence
              ? recurrence.status === 'active'
                ? 'Récurrence active'
                : recurrence.status === 'paused'
                  ? 'Récurrence en pause'
                  : recurrence.status === 'review_required'
                    ? 'Récurrence à contrôler'
                    : 'Récurrence terminée'
              : '';
            return (
              <li key={order.id}>
                <button
                  type="button"
                  className="sales-order-card"
                  onClick={() => setSelectedId(order.id)}
                >
                  <span className="sales-order-card__icon">
                    <ClipboardCheck size={19} />
                  </span>
                  <span className="sales-order-card__identity">
                    <strong>{order.number || 'Commande à confirmer'}</strong>
                    <small>{order.title}</small>
                  </span>
                  <span className="sales-order-card__client">
                    <small>Client</small>
                    <strong>
                      {client?.company || client?.name || 'Client introuvable'}
                    </strong>
                  </span>
                  <span className="sales-order-card__progress">
                    <small
                      className={
                        recurrence ? 'sales-order-card__recurrence' : undefined
                      }
                    >
                      {recurrence
                        ? `${recurrenceLabel} · prochaine échéance ${recurrence.status === 'completed' ? 'aucune' : formatDate(recurrence.nextScheduledFor)}`
                        : `Livré ${progress.deliveryPercent} % · Préparé ${progress.invoicePreparedPercent} % · Émis ${progress.invoicePercent} %`}
                    </small>
                    <i>
                      <span
                        style={{
                          width: recurrence
                            ? recurrence.status === 'completed'
                              ? '100%'
                              : recurrence.status === 'active'
                                ? '55%'
                                : recurrence.status === 'paused'
                                  ? '30%'
                                  : '15%'
                            : `${Math.min(progress.deliveryPercent, progress.invoicePercent)}%`,
                        }}
                      />
                    </i>
                  </span>
                  <span className="sales-order-card__total">
                    {formatMoney(order.totalCents)}
                  </span>
                  <StatusBadge
                    status={recurrence?.status || display.status}
                    label={recurrenceLabel || display.label}
                  />
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        {!filtered.length ? (
          <EmptyState
            title="Aucun résultat"
            text="Aucune commande ne correspond à cette recherche."
          />
        ) : null}
      </section>
    </div>
  );
}

function SalesOrderDetail({
  order,
  workspace,
  busy,
  readOnly,
  act,
  onBack,
  onOpenInvoice,
  onIssueInvoice,
  onPrintOrder,
  onPrintDelivery,
}: {
  order: SalesOrder;
  workspace: Workspace;
  busy: boolean;
  readOnly: boolean;
  act: ActionRunner;
  onBack: () => void;
  onOpenInvoice: (invoice: Invoice) => void;
  onIssueInvoice: (invoice: Invoice) => void;
  onPrintOrder: (order: SalesOrder) => void;
  onPrintDelivery: (note: DeliveryNote) => void;
}) {
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [deliveryDraft, setDeliveryDraft] = useState<
    DeliveryNote | undefined
  >();
  const [deliveryIssueTarget, setDeliveryIssueTarget] =
    useState<DeliveryNote | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [correctionAction, setCorrectionAction] =
    useState<OrderCorrectionAction | null>(null);
  const [clientError, setClientError] = useState('');
  const confirmRequestId = useRef(createId());
  const issueRequestIds = useRef(new Map<string, string>());
  const client = workspace.clients.find((item) => item.id === order.clientId);
  const project = workspace.projects.find(
    (item) => item.id === order.projectId,
  );
  const progress = salesOrderProgress(order, workspace);
  const display = salesOrderDisplayStatus(order, workspace);
  const nextAction = nextSalesOrderAction(order, workspace);
  const currentDate = todayIso();
  const recurrenceSchedule = workspace.recurrenceSchedules.find(
    (schedule) => schedule.sourceSalesOrderId === order.id,
  );
  const recurrenceEligibility = recurrenceOrderEligibility(order, workspace);
  const recurrenceOccurrences = recurrenceSchedule
    ? workspace.recurrenceOccurrences.filter(
        (occurrence) => occurrence.scheduleId === recurrenceSchedule.id,
      )
    : [];
  const recurrenceDraftCount = recurrenceOccurrences.filter((occurrence) =>
    ['draft', 'brouillon'].includes(occurrence.invoiceStatus.toLowerCase()),
  ).length;
  const recurrenceIssuedCount = recurrenceOccurrences.filter((occurrence) =>
    ['issued', 'partially_paid', 'paid'].includes(
      occurrence.invoiceStatus.toLowerCase(),
    ),
  ).length;
  const notes = workspace.deliveryNotes
    .filter((note) => note.salesOrderId === order.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const batches = workspace.salesOrderInvoiceBatches
    .filter((batch) => batch.salesOrderId === order.id)
    .map((batch) => ({
      batch,
      invoice: workspace.invoices.find(
        (invoice) => invoice.id === batch.invoiceId,
      ),
    }))
    .filter((entry): entry is typeof entry & { invoice: Invoice } =>
      Boolean(entry.invoice),
    );
  const draftDelivery = notes.find((note) => note.status === 'draft');
  const draftInvoice = batches.find(
    (entry) => entry.invoice.status === 'draft',
  )?.invoice;
  const canCancelOrder =
    (!recurrenceSchedule || recurrenceSchedule.status === 'completed') &&
    canCancelSalesOrderCompletely(order, workspace);
  const cancellableRemainder = cancellableSalesOrderRemainder(order, workspace);
  const canCancelRemainder =
    order.status === 'confirmed' &&
    (!recurrenceSchedule || recurrenceSchedule.status === 'completed') &&
    !canCancelOrder &&
    cancellableRemainder.length > 0;

  const issueDelivery = async (note: DeliveryNote, onError?: (reason: unknown) => void) => {
    let requestId = issueRequestIds.current.get(note.id);
    if (!requestId) {
      requestId = createId();
      issueRequestIds.current.set(note.id, requestId);
    }
    const ok = await act(
      () => desktopApi.issueDeliveryNote(requestId!, note.id),
      'Le bon de livraison a été émis. La réservation et le stock ont été mis à jour ensemble.',
      false,
      onError,
    );
    if (ok) issueRequestIds.current.delete(note.id);
    return ok;
  };

  const runNextAction = async () => {
    setClientError('');
    if (nextAction === 'confirm') {
      const shortages = confirmationShortages(
        order,
        workspace.catalogItems,
        workspace.stockReservationEvents,
        workspace.stockAvailability,
      );
      if (shortages.length) {
        setClientError(
          `Confirmation bloquée : ${shortages
            .map(
              (shortage) =>
                `${shortage.catalogItem.name} demande ${formatCatalogQuantity(shortage.requiredMilli)}, ${formatCatalogQuantity(shortage.availableMilli)} disponible`,
            )
            .join(' · ')}. Enregistrez d’abord une entrée de stock.`,
        );
        return;
      }
      if (
        !window.confirm(
          'Confirmer cette commande et réserver toutes les quantités suivies ?',
        )
      )
        return;
      await act(
        () => desktopApi.confirmSalesOrder(confirmRequestId.current, order.id),
        'La commande est confirmée et les produits disponibles sont réservés.',
        false,
      );
      return;
    }
    if (nextAction === 'issue_delivery' && draftDelivery) {
      setDeliveryIssueTarget(draftDelivery);
      return;
    }
    if (nextAction === 'create_delivery') {
      setDeliveryDraft(undefined);
      setDeliveryOpen(true);
      return;
    }
    if (nextAction === 'issue_invoice' && draftInvoice) {
      onOpenInvoice(draftInvoice);
      return;
    }
    if (
      nextAction === 'create_partial_invoice' ||
      nextAction === 'create_final_invoice'
    )
      setInvoiceOpen(true);
  };

  return (
    <div className="stack-layout sales-order-detail">
      <div className="sales-order-detail__back">
        <Button variant="ghost" size="small" onClick={onBack}>
          <ArrowLeft size={15} /> Toutes les commandes
        </Button>
      </div>
      <section className="panel sales-order-hero">
        <div>
          <p className="eyebrow">Commande client</p>
          <h2>
            {order.number || 'À confirmer'} · {order.title}
          </h2>
          <p>
            {client?.company || client?.name || 'Client introuvable'}
            {project ? ` · ${project.name}` : ''}
          </p>
        </div>
        <div className="sales-order-hero__meta">
          <StatusBadge status={display.status} label={display.label} />
          <strong>{formatMoney(order.totalCents)}</strong>
          <small>{formatDate(order.orderDate)}</small>
          {order.status !== 'draft' ? (
            <Button
              variant="ghost"
              size="small"
              onClick={() => onPrintOrder(order)}
            >
              <Printer size={14} /> Aperçu commande
            </Button>
          ) : null}
        </div>
      </section>

      {!recurrenceSchedule ? (
        <>
          <section
            className="panel order-progress-panel"
            aria-label="Avancement de la commande"
          >
            <OrderProgress
              label="Livraison"
              percent={progress.deliveryPercent}
              detail={
                progress.deliveryLineCount
                  ? `${progress.deliveryCompletedLines}/${progress.deliveryLineCount} lignes terminées`
                  : 'Aucune livraison requise'
              }
            />
            <OrderProgress
              label="Factures émises"
              percent={progress.invoicePercent}
              detail={`${progress.invoiceCompletedLines}/${progress.invoiceLineCount} lignes émises · ${progress.invoicePreparedPercent} % préparé en brouillon`}
            />
          </section>

          <section className="panel order-next-action">
            <div className="order-next-action__icon">
              <NextActionIcon action={nextAction} />
            </div>
            <div>
              <p className="eyebrow">Prochaine étape</p>
              <h3>{nextActionCopy[nextAction].title}</h3>
              <p>{nextActionCopy[nextAction].description}</p>
            </div>
            {nextAction !== 'none' ? (
              <Button
                disabled={busy || readOnly}
                title={
                  readOnly
                    ? 'Licence en lecture seule'
                    : nextActionCopy[nextAction].button
                }
                onClick={() => void runNextAction()}
              >
                {nextActionCopy[nextAction].button} <ArrowRight size={16} />
              </Button>
            ) : null}
          </section>
        </>
      ) : null}

      <RecurringDocumentsPanel
        order={{
          id: order.id,
          number: order.number || 'Sans numéro',
          title: order.title,
          clientName: client?.company || client?.name || 'Client introuvable',
          orderDate: order.orderDate,
          status: order.status,
          eligible: recurrenceEligibility.eligible,
          blockingReasons: recurrenceEligibility.reasons,
        }}
        schedule={
          recurrenceSchedule
            ? {
                id: recurrenceSchedule.id,
                sourceSalesOrderId: recurrenceSchedule.sourceSalesOrderId,
                status: recurrenceSchedule.status,
                frequency: recurrenceSchedule.frequency,
                startDate: recurrenceSchedule.anchorDate,
                endDate: recurrenceSchedule.endDate,
                paymentTermsDays: recurrenceSchedule.paymentTermsDays,
                nextOccurrenceOn:
                  recurrenceSchedule.status === 'completed'
                    ? null
                    : recurrenceSchedule.nextScheduledFor,
                pendingCatchUpCount: pendingRecurringOccurrenceCount(
                  recurrenceSchedule,
                  currentDate,
                ),
                reviewReason: recurrenceSchedule.reviewReason,
                occurrences: recurrenceOccurrences,
              }
            : null
        }
        today={currentDate}
        defaultPaymentTermsDays={
          workspace.settings?.billing.paymentTermsDays ?? 30
        }
        busy={busy}
        readOnly={readOnly}
        onCreate={async (input) => {
          let localReason: unknown;
          const ok = await act(
            () => desktopApi.createRecurrenceSchedule(input),
            'La planification est créée. Chaque échéance préparera uniquement une facture brouillon à contrôler.',
            false,
            (reason) => {
              localReason = reason;
            },
          );
          if (!ok)
            throw (
              localReason ??
              new Error('La planification n’a pas pu être créée.')
            );
        }}
        onUpdate={async (input) => {
          let localReason: unknown;
          const message =
            input.status === 'completed'
              ? 'La planification est terminée définitivement. Son historique reste disponible.'
              : input.status === 'paused'
                ? 'La planification est en pause.'
                : 'La planification est reprise. Les échéances dues seront préparées par lots contrôlés.';
          const ok = await act(
            () => desktopApi.updateRecurrenceSchedule(input),
            message,
            false,
            (reason) => {
              localReason = reason;
            },
          );
          if (!ok)
            throw (
              localReason ??
              new Error('La planification n’a pas pu être mise à jour.')
            );
        }}
        onOpenDraftInvoice={(occurrence) => {
          const invoice = workspace.invoices.find(
            (item) => item.id === occurrence.invoiceId,
          );
          if (!invoice) {
            setClientError(
              'La facture liée à cette occurrence est introuvable. Relancez Zentra puis contrôlez la sauvegarde locale.',
            );
            return;
          }
          onOpenInvoice(invoice);
        }}
      />
      {clientError ? <ErrorPanel message={clientError} /> : null}

      <section className="panel order-lines-panel">
        <SectionHeading
          eyebrow={recurrenceSchedule ? 'Contenu du modèle' : 'Quantités contrôlées'}
          title={recurrenceSchedule ? 'Montants par occurrence' : 'Articles et exécution'}
          description={
            recurrenceSchedule
              ? 'Chaque échéance reprend ces prestations et ces montants. Contrôlez le brouillon avant de l’émettre.'
              : 'Retrouvez les quantités commandées, livrées et facturées pour chaque article.'
          }
        />
        <div className="order-line-list">
          {order.lines.map((line) => {
            const lineProgress = salesOrderLineProgress(order, line, workspace);
            const item = line.catalogItemId
              ? workspace.catalogItems.find(
                  (catalogItem) => catalogItem.id === line.catalogItemId,
                )
              : undefined;
            const stock = item
              ? availabilityForCatalogItem(
                  item,
                  workspace.stockReservationEvents,
                  workspace.stockAvailability,
                )
              : null;
            return (
              <article key={line.id} className="order-line-card">
                <span className="order-line-card__icon">
                  {line.fulfillmentMode === 'direct' ? (
                    <FileText size={18} />
                  ) : (
                    <Box size={18} />
                  )}
                </span>
                <div className="order-line-card__identity">
                  <strong>{line.description}</strong>
                  <small>
                    {formatCatalogQuantity(line.quantityMilli)} {line.unit}{' '}
                    commandé · {formatMoney(line.lineTotalCents)}
                  </small>
                </div>
                {stock && item?.trackStock ? (
                  <div className="order-line-stock">
                    <small>
                      <span>En main</span>
                      <strong>
                        {formatCatalogQuantity(stock.onHandMilli)}
                      </strong>
                    </small>
                    <small>
                      <span>Réservé</span>
                      <strong>
                        {formatCatalogQuantity(stock.reservedMilli)}
                      </strong>
                    </small>
                    <small>
                      <span>Disponible</span>
                      <strong>
                        {formatCatalogQuantity(stock.availableMilli)}
                      </strong>
                    </small>
                  </div>
                ) : (
                  <div className="order-line-stock order-line-stock--direct">
                    <ShieldCheck size={15} />
                    <span>
                      {line.fulfillmentMode === 'direct'
                        ? 'Facturation directe'
                        : 'Livraison sans stock suivi'}
                    </span>
                  </div>
                )}
                {recurrenceSchedule ? (
                  <div className="order-line-progress-facts">
                    <small>
                      <span>Quantité par occurrence</span>
                      <strong>
                        {formatCatalogQuantity(line.quantityMilli)} {line.unit}
                      </strong>
                    </small>
                    <small>
                      <span>Montant par occurrence</span>
                      <strong>{formatMoney(line.lineTotalCents)}</strong>
                    </small>
                    <small>
                      <span>Brouillons à contrôler</span>
                      <strong>{recurrenceDraftCount}</strong>
                    </small>
                    <small>
                      <span>Factures émises</span>
                      <strong>{recurrenceIssuedCount}</strong>
                    </small>
                  </div>
                ) : (
                  <div className="order-line-progress-facts">
                  <small>
                    <span>Livré</span>
                    <strong>
                      {formatCatalogQuantity(
                        lineProgress.deliveredQuantityMilli,
                      )}
                    </strong>
                  </small>
                  <small>
                    <span>Préparé en brouillon</span>
                    <strong>
                      {formatCatalogQuantity(
                        lineProgress.allocatedQuantityMilli,
                      )}
                    </strong>
                  </small>
                  <small>
                    <span>Réellement facturé</span>
                    <strong>
                      {formatCatalogQuantity(
                        lineProgress.invoicedQuantityMilli,
                      )}
                    </strong>
                  </small>
                  {line.fulfillmentMode === 'stocked_delivery' ? (
                    <small>
                      <span>Réservé pour cette ligne</span>
                      <strong>
                        {formatCatalogQuantity(
                          lineProgress.reservedQuantityMilli,
                        )}
                      </strong>
                    </small>
                  ) : null}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {!recurrenceSchedule ? <div className="order-history-grid">
        <section className="panel order-history-card">
          <SectionHeading eyebrow="Logistique" title="Bons de livraison" />
          {notes.length ? (
            notes.map((note) => (
              <article key={note.id}>
                <div>
                  <Truck size={17} />
                  <span>
                    <strong>{note.number || 'Brouillon de bon'}</strong>
                    <small>
                      {formatDate(note.deliveryDate)} · {note.lines.length}{' '}
                      ligne{note.lines.length > 1 ? 's' : ''}
                    </small>
                  </span>
                </div>
                <StatusBadge
                  status={note.status}
                  label={note.status === 'reversed' ? 'Extourné' : undefined}
                />
                <div className="order-history-actions">
                  {note.status === 'draft' && order.status === 'confirmed' ? (
                    <>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busy || readOnly}
                        onClick={() => {
                          setDeliveryDraft(note);
                          setDeliveryOpen(true);
                        }}
                      >
                        <FileText size={14} /> Modifier
                      </Button>
                      <Button
                        size="small"
                        disabled={busy || readOnly}
                        onClick={() => setDeliveryIssueTarget(note)}
                      >
                        <CheckCircle2 size={14} /> Contrôler et émettre
                      </Button>
                    </>
                  ) : null}
                  {note.status === 'issued' ? (
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => onPrintDelivery(note)}
                    >
                      <Printer size={14} /> Aperçu
                    </Button>
                  ) : null}
                  {canReverseDeliveryNote(note, order, workspace) ? (
                    <Button
                      className="order-correction-button"
                      variant="ghost"
                      size="small"
                      disabled={busy || readOnly}
                      onClick={() =>
                        setCorrectionAction({ kind: 'reverse_delivery', note })
                      }
                    >
                      <RotateCcw size={14} /> Extourner
                    </Button>
                  ) : null}
                </div>
              </article>
            ))
          ) : (
            <p className="order-history-empty">
              Aucun bon de livraison préparé.
            </p>
          )}
        </section>
        <section className="panel order-history-card">
          <SectionHeading eyebrow="Finances" title="Factures liées" />
          {batches.length ? (
            batches.map(({ batch, invoice }) => (
              <article key={batch.id}>
                <div>
                  <Receipt size={17} />
                  <span>
                    <strong>
                      {invoice.number ||
                        (batch.role === 'final'
                          ? 'Facture finale brouillon'
                          : 'Situation brouillon')}
                    </strong>
                    <small>
                      {batch.role === 'final' ? 'Finale' : 'Partielle'} ·{' '}
                      {formatMoney(documentTotals(invoice.lines).totalCents)}
                    </small>
                  </span>
                </div>
                <StatusBadge status={invoice.status} />
                <div className="order-history-actions">
                  {invoice.status === 'draft' &&
                  order.status === 'confirmed' ? (
                    <Button
                      size="small"
                      disabled={busy || readOnly}
                      onClick={() => onIssueInvoice(invoice)}
                    >
                      <CheckCircle2 size={14} /> Émettre
                    </Button>
                  ) : null}
                  {invoice.status === 'draft' ? (
                    <Button
                      className="order-correction-button"
                      variant="ghost"
                      size="small"
                      disabled={busy || readOnly}
                      onClick={() =>
                        setCorrectionAction({ kind: 'cancel_invoice', invoice })
                      }
                    >
                      <Trash2 size={14} /> Supprimer le brouillon
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => onOpenInvoice(invoice)}
                  >
                    Contrôler
                  </Button>
                </div>
              </article>
            ))
          ) : (
            <p className="order-history-empty">
              Aucune facture créée depuis cette commande.
            </p>
          )}
        </section>
      </div> : null}

      {canCancelOrder || canCancelRemainder ? (
        <section className="panel order-correction-panel">
          <div>
            <p className="eyebrow">Correction contrôlée</p>
            <strong>Actions secondaires</strong>
            <small>
              Un motif est obligatoire et l’historique déjà émis reste intact.
            </small>
          </div>
          {canCancelOrder ? (
            <Button
              className="order-correction-button"
              variant="ghost"
              size="small"
              disabled={busy || readOnly}
              onClick={() => setCorrectionAction({ kind: 'cancel_order' })}
            >
              <Ban size={14} /> Annuler la commande
            </Button>
          ) : null}
          {canCancelRemainder ? (
            <Button
              className="order-correction-button"
              variant="ghost"
              size="small"
              disabled={busy || readOnly}
              onClick={() =>
                setCorrectionAction({
                  kind: 'cancel_remainder',
                  lines: cancellableRemainder,
                })
              }
            >
              <Ban size={14} /> Annuler le reliquat
            </Button>
          ) : null}
        </section>
      ) : null}

      {deliveryOpen ? (
        <DeliveryNoteForm
          note={deliveryDraft}
          order={order}
          workspace={workspace}
          busy={busy}
          act={act}
          close={() => {
            setDeliveryOpen(false);
            setDeliveryDraft(undefined);
          }}
        />
      ) : null}
      {deliveryIssueTarget ? (
        <DeliveryNoteIssueReview
          note={deliveryIssueTarget}
          order={order}
          workspace={workspace}
          busy={busy}
          close={() => setDeliveryIssueTarget(null)}
          onIssue={(onError) => issueDelivery(deliveryIssueTarget, onError)}
        />
      ) : null}
      {invoiceOpen ? (
        <OrderInvoiceWizard
          order={order}
          workspace={workspace}
          busy={busy}
          act={act}
          close={() => setInvoiceOpen(false)}
        />
      ) : null}
      {correctionAction ? (
        <OrderCorrectionModal
          action={correctionAction}
          order={order}
          busy={busy}
          act={act}
          close={() => setCorrectionAction(null)}
        />
      ) : null}
    </div>
  );
}

function OrderProgress({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number;
  detail: string;
}) {
  return (
    <div className="order-progress">
      <div>
        <strong>{label}</strong>
        <span>{percent} %</span>
      </div>
      <i aria-label={`${label} ${percent} %`}>
        <span style={{ width: `${percent}%` }} />
      </i>
      <small>{detail}</small>
    </div>
  );
}

function DeliveryNoteIssueReview({
  note,
  order,
  workspace,
  busy,
  close,
  onIssue,
}: {
  note: DeliveryNote;
  order: SalesOrder;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  onIssue: (onError: (reason: unknown) => void) => Promise<boolean>;
}) {
  const [issueError, setIssueError] = useState('');
  const client = workspace.clients.find((item) => item.id === order.clientId);
  const project = workspace.projects.find(
    (item) => item.id === order.projectId,
  );
  const recipient = client?.company || client?.name || '';
  return (
    <Modal
      title="Contrôler le bon avant émission"
      description="Vérifiez le destinataire et les quantités. L’émission attribue un numéro au bon et met à jour le stock des articles suivis."
      onClose={close}
      wide
    >
      <form onSubmit={submitForm(async () => {
        setIssueError('');
        const ok = await onIssue((reason) => setIssueError(errorMessage(reason, 'Le bon n’a pas pu être émis.')));
        if (ok) close();
      })}>
        <div className="info-strip">
          <UserRound size={17} />
          <span>
            <strong>{recipient || 'Destinataire introuvable'}</strong>
            {client?.address ? ` · ${client.address}` : ''}
            {project ? ` · ${project.name}` : ''}
          </span>
        </div>
        <div className="info-strip">
          <CalendarDays size={17} />
          <span>
            Livraison prévue le {formatDate(note.deliveryDate)}
            {note.reference ? ` · Référence ${note.reference}` : ''}
          </span>
        </div>
        <div
          className="order-correction-impact"
          aria-label="Quantités à émettre"
        >
          {note.lines.map((deliveryLine) => {
            const orderLine = order.lines.find(
              (line) => line.id === deliveryLine.salesOrderLineId,
            );
            return (
              <div key={deliveryLine.id}>
                <span>
                  {deliveryLine.description ||
                    orderLine?.description ||
                    'Article'}
                </span>
                <strong>
                  {formatCatalogQuantity(deliveryLine.quantityMilli)}{' '}
                  {deliveryLine.unit || orderLine?.unit || 'unité'}
                </strong>
              </div>
            );
          })}
        </div>
        {note.notes ? (
          <div className="info-strip">
            <FileText size={17} />
            <span>{note.notes}</span>
          </div>
        ) : null}
        {issueError ? <ErrorPanel message={issueError} reveal /> : null}
        {!client ? (
          <ErrorPanel message="Le client lié à cette commande est introuvable. Corrigez les données avant d’émettre le bon." />
        ) : null}
        <FormActions
          onCancel={close}
          busy={busy}
          disabled={!client || !note.lines.length}
          submitLabel="Confirmer et émettre le bon"
        />
      </form>
    </Modal>
  );
}

function OrderCorrectionModal({
  action,
  order,
  busy,
  act,
  close,
}: {
  action: OrderCorrectionAction;
  order: SalesOrder;
  busy: boolean;
  act: ActionRunner;
  close: () => void;
}) {
  const requestId = useRef(createId());
  const [clientError, setClientError] = useState('');
  const copy =
    action.kind === 'cancel_order'
      ? {
          title: 'Annuler la commande',
          description:
            'La commande passera en statut annulé. Les réservations encore actives seront libérées par le backend.',
          confirmation:
            'Confirmer l’annulation de toute la commande ? Cette action sera inscrite dans l’historique.',
          submit: 'Annuler la commande',
          success:
            'La commande a été annulée et ses réservations ont été libérées.',
        }
      : action.kind === 'cancel_remainder'
        ? {
            title: 'Annuler le reliquat',
            description:
              'Seules les quantités restant à livrer ou facturer seront annulées. Les livraisons et factures existantes restent intactes.',
            confirmation:
              'Confirmer l’annulation de tout le reliquat affiché ? Les quantités déjà traitées resteront inchangées.',
            submit: 'Annuler le reliquat',
            success: 'Le reliquat de la commande a été annulé.',
          }
        : action.kind === 'reverse_delivery'
          ? {
              title: `Extourner ${action.note.number || 'le bon de livraison'}`,
              description:
                'Le bon émis restera visible. Une entrée de stock inverse sera créée et la réservation sera restaurée atomiquement.',
              confirmation:
                'Confirmer l’extourne du bon de livraison ? Le document original restera dans l’historique.',
              submit: 'Créer l’extourne',
              success:
                'Le bon de livraison a été extourné et le stock restauré.',
            }
          : {
              title: 'Supprimer la facture brouillon',
              description:
                'Seul ce brouillon lié à la commande sera supprimé. Les quantités redeviendront disponibles pour la prochaine facture.',
              confirmation:
                'Confirmer la suppression de cette facture brouillon ? Une nouvelle facture pourra ensuite être préparée.',
              submit: 'Supprimer le brouillon',
              success: 'La facture brouillon liée a été supprimée.',
            };

  return (
    <Modal title={copy.title} description={copy.description} onClose={close}>
      <form
        className="order-correction-form"
        onSubmit={submitForm(async (form) => {
          const reason = String(form.get('reason') ?? '').trim();
          if (!reason) {
            setClientError('Indiquez un motif précis avant de confirmer.');
            return;
          }
          if (!window.confirm(copy.confirmation)) return;
          setClientError('');
          const ok = await act(
            () => {
              if (action.kind === 'cancel_order')
                return desktopApi.cancelSalesOrder(
                  requestId.current,
                  order.id,
                  reason,
                );
              if (action.kind === 'cancel_remainder')
                return desktopApi.cancelSalesOrderRemainder(
                  requestId.current,
                  order.id,
                  reason,
                  action.lines,
                );
              if (action.kind === 'reverse_delivery')
                return desktopApi.reverseDeliveryNote(
                  requestId.current,
                  action.note.id,
                  reason,
                );
              return desktopApi.cancelSalesOrderInvoiceDraft(
                requestId.current,
                action.invoice.id,
                reason,
              );
            },
            copy.success,
            false,
            (reason) => setClientError(errorMessage(reason, 'La correction n’a pas pu être enregistrée.')),
          );
          if (ok) close();
        })}
      >
        {action.kind === 'cancel_remainder' ? (
          <div
            className="order-correction-impact"
            aria-label="Reliquat à annuler"
          >
            {action.lines.map((entry) => {
              const line = order.lines.find(
                (candidate) => candidate.id === entry.salesOrderLineId,
              );
              return (
                <div key={entry.salesOrderLineId}>
                  <span>{line?.description || 'Ligne de commande'}</span>
                  <strong>
                    {formatCatalogQuantity(entry.quantityMilli)}{' '}
                    {line?.unit || 'unité'}
                  </strong>
                </div>
              );
            })}
          </div>
        ) : null}
        <Field label="Motif" required wide>
          <textarea
            name="reason"
            required
            maxLength={500}
            rows={4}
            autoFocus
            placeholder="Ex. demande écrite du client, erreur de préparation…"
            onChange={() => setClientError('')}
          />
        </Field>
        {clientError ? <ErrorPanel message={clientError} reveal /> : null}
        <FormActions onCancel={close} busy={busy} submitLabel={copy.submit} />
      </form>
    </Modal>
  );
}

function NextActionIcon({ action }: { action: SalesOrderNextAction }) {
  if (action === 'confirm') return <LockKeyhole size={21} />;
  if (action.includes('delivery')) return <Truck size={21} />;
  if (action.includes('invoice')) return <Receipt size={21} />;
  return <CheckCircle2 size={21} />;
}

const nextActionCopy: Record<
  SalesOrderNextAction,
  { title: string; description: string; button: string }
> = {
  confirm: {
    title: 'Confirmer et réserver',
    description:
      'Toutes les quantités stockées doivent être disponibles. La réservation est atomique.',
    button: 'Confirmer la commande',
  },
  create_delivery: {
    title: 'Préparer le prochain bon',
    description:
      'Les quantités restantes sont proposées; vous pouvez livrer seulement une partie.',
    button: 'Préparer la livraison',
  },
  issue_delivery: {
    title: 'Contrôler puis émettre le bon',
    description:
      'Relisez le destinataire et les quantités avant la sortie de stock définitive.',
    button: 'Contrôler le bon',
  },
  create_partial_invoice: {
    title: 'Facturer les quantités livrées',
    description:
      'Seules les quantités livrées et encore non facturées sont proposées.',
    button: 'Créer la facture suivante',
  },
  create_final_invoice: {
    title: 'Créer la facture finale',
    description:
      'Toutes les livraisons requises sont terminées. Le solde restant sera vérifié avant la création.',
    button: 'Créer la facture finale',
  },
  issue_invoice: {
    title: 'Contrôler le brouillon avant émission',
    description:
      'Ouvrez directement la facture liée, puis revenez ici pour l’émettre après vérification.',
    button: 'Contrôler la facture',
  },
  none: {
    title: 'Cycle terminé',
    description:
      'Aucune action supplémentaire n’est requise pour cette commande.',
    button: '',
  },
};

function DeliveryNoteForm({
  note,
  order,
  workspace,
  busy,
  act,
  close,
}: {
  note?: DeliveryNote;
  order: SalesOrder;
  workspace: Workspace;
  busy: boolean;
  act: ActionRunner;
  close: () => void;
}) {
  const draftId = useRef(note?.id || createId());
  const available = useMemo(
    () => defaultDeliveryAllocations(order, workspace),
    [order, workspace],
  );
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      available.map((line) => {
        const existing = note?.lines.find(
          (entry) => entry.salesOrderLineId === line.salesOrderLineId,
        );
        return [
          line.salesOrderLineId,
          existing
            ? String(existing.quantityMilli / 1_000)
            : note
              ? ''
              : String(line.quantityMilli / 1_000),
        ];
      }),
    ),
  );
  const [clientError, setClientError] = useState('');
  const currentDate = todayIso();
  const initialDeliveryDate =
    note?.deliveryDate ||
    (order.orderDate && order.orderDate > currentDate
      ? order.orderDate
      : currentDate);
  return (
    <Modal
      title={
        note
          ? 'Modifier le bon de livraison brouillon'
          : 'Préparer un bon de livraison'
      }
      description={
        note
          ? 'Corrigez les informations ou quantités, puis enregistrez. Aucun stock ne bougera avant le contrôle d’émission.'
          : 'Les quantités restantes sont préremplies. Réduisez-les pour une livraison partielle; l’émission aura lieu après un second contrôle.'
      }
      onClose={close}
      wide
    >
      <form
        onSubmit={submitForm(async (form) => {
          const deliveryDate = String(form.get('deliveryDate') ?? '');
          const dateError = deliveryDateValidationError(
            order.orderDate,
            deliveryDate,
          );
          if (dateError) {
            setClientError(dateError);
            return;
          }
          const lines = available.flatMap((entry) => {
            const quantityMilli = stockQuantityFromInput(
              quantities[entry.salesOrderLineId] ?? '',
            );
            if (quantityMilli === null || quantityMilli <= 0) return [];
            return [
              { salesOrderLineId: entry.salesOrderLineId, quantityMilli },
            ];
          });
          const exceeds = lines.find((line) => {
            const maximum = available.find(
              (entry) => entry.salesOrderLineId === line.salesOrderLineId,
            )?.quantityMilli;
            return maximum === undefined || line.quantityMilli > maximum;
          });
          if (!lines.length) {
            setClientError(
              'Conservez au moins une ligne avec une quantité positive.',
            );
            return;
          }
          if (exceeds) {
            setClientError(
              'Une quantité dépasse le reliquat livrable. Actualisez la commande et recommencez.',
            );
            return;
          }
          setClientError('');
          const ok = await act(
            () =>
              desktopApi.saveDeliveryNoteDraft({
                id: draftId.current,
                salesOrderId: order.id,
                deliveryDate,
                reference: String(form.get('reference') ?? ''),
                notes: String(form.get('notes') ?? ''),
                lines,
              }),
            note
              ? 'Le bon de livraison brouillon a été corrigé. Contrôlez-le avant émission.'
              : 'Le bon de livraison brouillon est prêt. Contrôlez-le puis émettez-le pour mouvementer le stock.',
            false,
            (reason) => setClientError(errorMessage(reason, 'Le brouillon n’a pas pu être enregistré.')),
          );
          if (ok) close();
        })}
      >
        <div className="form-grid">
          <Field label="Date de livraison" required>
            <input
              name="deliveryDate"
              type="date"
              min={order.orderDate || undefined}
              defaultValue={initialDeliveryDate}
              onChange={() => setClientError('')}
              onBlur={(event) =>
                setClientError(
                  deliveryDateValidationError(
                    order.orderDate,
                    event.target.value,
                  ),
                )
              }
              required
            />
          </Field>
          <Field
            label="Référence"
            hint="Facultatif : tournée, projet, référence client…"
          >
            <input
              name="reference"
              maxLength={200}
              defaultValue={note?.reference}
            />
          </Field>
        </div>
        <section className="guided-lines-section">
          <header>
            <Truck size={18} />
            <div>
              <strong>Quantités de ce bon</strong>
              <p>Une valeur vide exclut la ligne de cette livraison.</p>
            </div>
          </header>
          <div className="guided-line-list">
            {available.map((entry) => {
              const line = order.lines.find(
                (item) => item.id === entry.salesOrderLineId,
              )!;
              return (
                <label key={line.id} className="guided-line-row">
                  <span>
                    <strong>{line.description}</strong>
                    <small>
                      Reste {formatCatalogQuantity(entry.quantityMilli)}{' '}
                      {line.unit}
                    </small>
                  </span>
                  <span className="guided-quantity-input">
                    <input
                      type="number"
                      min="0.001"
                      max={entry.quantityMilli / 1_000}
                      step="0.001"
                      value={quantities[line.id] ?? ''}
                      onChange={(event) => {
                        setQuantities((current) => ({
                          ...current,
                          [line.id]: event.target.value,
                        }));
                        setClientError('');
                      }}
                      aria-label={`Quantité livrée pour ${line.description}`}
                    />
                    <small>{line.unit}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
        <Field label="Note logistique" wide>
          <textarea
            name="notes"
            rows={3}
            maxLength={2_000}
            defaultValue={note?.notes}
          />
        </Field>
        <div className="info-strip">
          <ShieldCheck size={17} />
          <span>
            Ce brouillon prépare les quantités à livrer. Le stock des articles
            suivis est mis à jour à l’émission du bon.
          </span>
        </div>
        {clientError ? <ErrorPanel message={clientError} reveal /> : null}
        <FormActions
          onCancel={close}
          busy={busy}
          submitLabel={
            note
              ? 'Enregistrer les corrections'
              : 'Enregistrer le bon brouillon'
          }
        />
      </form>
    </Modal>
  );
}

function OrderInvoiceWizard({
  order,
  workspace,
  busy,
  act,
  close,
}: {
  order: SalesOrder;
  workspace: Workspace;
  busy: boolean;
  act: ActionRunner;
  close: () => void;
}) {
  const initialIssueDate = todayIso();
  const initialServiceDateFrom = order.orderDate || initialIssueDate;
  const initialServiceDateTo =
    initialServiceDateFrom > initialIssueDate
      ? initialServiceDateFrom
      : initialIssueDate;
  const defaults = useMemo(
    () => defaultInvoiceAllocations(order, workspace),
    [order, workspace],
  );
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      defaults.map((entry) => [
        allocationKey(entry),
        String(entry.quantityMilli / 1_000),
      ]),
    ),
  );
  const [preview, setPreview] = useState<SalesOrderInvoicePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [clientError, setClientError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [dateError, setDateError] = useState('');
  const [issueDate, setIssueDate] = useState(initialIssueDate);
  const [dueDate, setDueDate] = useState('');
  const [serviceDateFrom, setServiceDateFrom] = useState(
    initialServiceDateFrom,
  );
  const [serviceDateTo, setServiceDateTo] = useState(initialServiceDateTo);
  const requestId = useRef(createId());
  const previewRequestVersion = useRef(0);

  const selectedAllocations = (): InvoiceAllocationDraft[] =>
    defaults.flatMap((entry) => {
      const quantityMilli = stockQuantityFromInput(
        quantities[allocationKey(entry)] ?? '',
      );
      if (quantityMilli === null || quantityMilli <= 0) return [];
      return [{ ...entry, quantityMilli }];
    });

  const validateAllocations = (allocations: InvoiceAllocationDraft[]) => {
    if (!allocations.length)
      return 'Conservez au moins une quantité à facturer.';
    const excessive = allocations.some((allocation) => {
      const maximum = defaults.find(
        (entry) => allocationKey(entry) === allocationKey(allocation),
      )?.quantityMilli;
      return maximum === undefined || allocation.quantityMilli > maximum;
    });
    return excessive
      ? 'Une quantité dépasse le disponible facturable. Actualisez la commande.'
      : '';
  };

  const refreshPreview = async (allocations = selectedAllocations()) => {
    const requestVersion = ++previewRequestVersion.current;
    const error = validateAllocations(allocations);
    if (error) {
      setPreview(null);
      setPreviewBusy(false);
      setClientError(error);
      return null;
    }
    setPreviewBusy(true);
    setClientError('');
    try {
      const next = await desktopApi.previewSalesOrderInvoice({
        salesOrderId: order.id,
        allocations,
      });
      if (requestVersion !== previewRequestVersion.current) return null;
      setPreview(next);
      if (next.blockers.length) setClientError(next.blockers.join(' · '));
      return next;
    } catch (reason) {
      if (requestVersion !== previewRequestVersion.current) return null;
      setClientError(
        errorMessage(reason, 'L’aperçu autoritaire n’a pas pu être calculé.'),
      );
      return null;
    } finally {
      if (requestVersion === previewRequestVersion.current)
        setPreviewBusy(false);
    }
  };

  const invalidatePreview = () => {
    previewRequestVersion.current += 1;
    setPreview(null);
    setPreviewBusy(false);
    setClientError('');
    setSaveError('');
  };

  useEffect(() => {
    void refreshPreview(defaults);
    // Le dialogue est recréé si la commande change; on évite de rappeler le
    // backend à chaque frappe et propose un bouton explicite de recalcul.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      previewRequestVersion.current += 1;
    };
  }, []);

  const fallbackTotal = defaults.reduce((total, entry) => {
    const line = order.lines.find((item) => item.id === entry.salesOrderLineId);
    const quantityMilli =
      stockQuantityFromInput(quantities[allocationKey(entry)] ?? '') ?? 0;
    return (
      total +
      (line && line.quantityMilli
        ? Math.round((line.lineTotalCents * quantityMilli) / line.quantityMilli)
        : 0)
    );
  }, 0);
  const invoiceDates = {
    issueDate,
    dueDate,
    serviceDateFrom,
    serviceDateTo,
  };
  const previewDocumentLabel = preview
    ? preview.role === 'final'
      ? 'Facture finale'
      : 'Facture de situation'
    : 'Type à recalculer';

  return (
    <Modal
      title={
        preview
          ? `Créer la ${previewDocumentLabel.toLowerCase()}`
          : 'Créer la facture suivante'
      }
      description="Le type de facture dépend des livraisons et des quantités déjà facturées."
      onClose={close}
      wide
    >
      <form
        onSubmit={submitForm(async () => {
          setSaveError('');
          const nextDateError =
            salesOrderInvoiceDateValidationError(invoiceDates);
          setDateError(nextDateError);
          if (nextDateError) return;
          const allocations = selectedAllocations();
          const error = validateAllocations(allocations);
          if (error) {
            setClientError(error);
            return;
          }
          const authoritative = await refreshPreview(allocations);
          if (!authoritative || authoritative.blockers.length) return;
          const ok = await act(
            () =>
              desktopApi.createSalesOrderInvoice({
                requestId: requestId.current,
                salesOrderId: order.id,
                issueDate,
                dueDate,
                serviceDateFrom,
                serviceDateTo,
                allocations,
              }),
            authoritative.role === 'final'
              ? 'La facture finale brouillon a été créée. Contrôlez-la puis émettez-la.'
              : 'La facture de situation brouillon a été créée. Contrôlez-la puis émettez-la.',
            false,
            (reason) => setSaveError(errorMessage(reason, 'La facture n’a pas pu être créée.')),
          );
          if (ok) close();
        })}
      >
        <div className="form-grid">
          <Field label="Date prévue d’émission" required>
            <input
              name="issueDate"
              type="date"
              value={issueDate}
              max={dueDate || undefined}
              onChange={(event) => {
                setIssueDate(event.target.value);
                setDateError('');
              }}
              onBlur={() =>
                setDateError(
                  salesOrderInvoiceDateValidationError({
                    ...invoiceDates,
                    issueDate,
                  }),
                )
              }
              required
            />
          </Field>
          <Field
            label="Échéance"
            hint="Laissez vide pour appliquer les conditions habituelles."
          >
            <input
              name="dueDate"
              type="date"
              value={dueDate}
              min={issueDate || undefined}
              onChange={(event) => {
                setDueDate(event.target.value);
                setDateError('');
              }}
              onBlur={() =>
                setDateError(
                  salesOrderInvoiceDateValidationError({
                    ...invoiceDates,
                    dueDate,
                  }),
                )
              }
            />
          </Field>
          <Field label="Prestation du" required>
            <input
              name="serviceDateFrom"
              type="date"
              value={serviceDateFrom}
              max={serviceDateTo || undefined}
              onChange={(event) => {
                setServiceDateFrom(event.target.value);
                setDateError('');
              }}
              onBlur={() =>
                setDateError(
                  salesOrderInvoiceDateValidationError({
                    ...invoiceDates,
                    serviceDateFrom,
                  }),
                )
              }
              required
            />
          </Field>
          <Field label="Prestation au" required>
            <input
              name="serviceDateTo"
              type="date"
              value={serviceDateTo}
              min={serviceDateFrom || undefined}
              onChange={(event) => {
                setServiceDateTo(event.target.value);
                setDateError('');
              }}
              onBlur={() =>
                setDateError(
                  salesOrderInvoiceDateValidationError({
                    ...invoiceDates,
                    serviceDateTo,
                  }),
                )
              }
              required
            />
          </Field>
        </div>
        <section className="guided-lines-section">
          <header>
            <Receipt size={18} />
            <div>
              <strong>Quantités éligibles</strong>
              <p>
                Une livraison ne peut être allouée qu’une fois. Réduisez une
                quantité pour une situation partielle.
              </p>
            </div>
          </header>
          <div className="guided-line-list">
            {defaults.map((entry) => {
              const line = order.lines.find(
                (item) => item.id === entry.salesOrderLineId,
              )!;
              const note = entry.deliveryNoteLineId
                ? workspace.deliveryNotes.find((item) =>
                    item.lines.some(
                      (deliveryLine) =>
                        deliveryLine.id === entry.deliveryNoteLineId,
                    ),
                  )
                : null;
              const key = allocationKey(entry);
              return (
                <label key={key} className="guided-line-row">
                  <span>
                    <strong>{line.description}</strong>
                    <small>
                      {note?.number
                        ? `${note.number} · `
                        : line.fulfillmentMode === 'direct'
                          ? 'Direct · '
                          : ''}
                      maximum {formatCatalogQuantity(entry.quantityMilli)}{' '}
                      {line.unit}
                    </small>
                  </span>
                  <span className="guided-quantity-input">
                    <input
                      type="number"
                      min="0.001"
                      max={entry.quantityMilli / 1_000}
                      step="0.001"
                      value={quantities[key] ?? ''}
                      onChange={(event) => {
                        setQuantities((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }));
                        invalidatePreview();
                      }}
                      aria-label={`Quantité facturée pour ${line.description}`}
                    />
                    <small>{line.unit}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
        <div className="invoice-preview-card" aria-live="polite">
          <div>
            <small>Document proposé</small>
            <strong>{previewDocumentLabel}</strong>
          </div>
          <div>
            <small>
              {preview ? 'Total TTC' : 'Estimation TTC à recalculer'}
            </small>
            <strong>{formatMoney(preview?.totalCents ?? fallbackTotal)}</strong>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={previewBusy || busy}
            onClick={() => void refreshPreview()}
          >
            {previewBusy ? 'Calcul…' : 'Recalculer l’aperçu'}
          </Button>
        </div>
        <div className="info-strip">
          <LockKeyhole size={17} />
          <span>
            La création réserve ces quantités à la facturation, mais ne déstocke
            rien. Le stock a déjà été mouvementé par le bon de livraison.
          </span>
        </div>
        {dateError || clientError || saveError ? (
          <ErrorPanel message={dateError || clientError || saveError} reveal />
        ) : null}
        <FormActions
          onCancel={close}
          busy={busy || previewBusy}
          disabled={Boolean(dateError || clientError)}
          submitLabel="Créer le brouillon contrôlé"
        />
      </form>
    </Modal>
  );
}

function allocationKey(
  allocation: Pick<
    InvoiceAllocationDraft,
    'salesOrderLineId' | 'deliveryNoteLineId'
  >,
) {
  return `${allocation.salesOrderLineId}:${allocation.deliveryNoteLineId ?? 'direct'}`;
}

export function SalesOrderPrintPreview({
  order,
  workspace,
  onClose,
}: {
  order: SalesOrder;
  workspace: Workspace;
  onClose: () => void;
}) {
  const frozen = order.snapshot;
  const document = frozen?.order ?? order;
  const lines = frozen?.lines ?? order.lines;
  const currentOrganization = workspace.settings!.organization;
  const issuer = frozen?.issuer;
  const issuerName = issuer?.companyName || currentOrganization.legalName;
  const issuerLegalForm = issuer?.legalForm || currentOrganization.legalForm;
  const issuerEmail = issuer?.email || currentOrganization.email;
  const issuerPhone = issuer?.phone || currentOrganization.phone;
  const issuerAddress = issuer
    ? [
        [issuer.addressLine1, issuer.buildingNumber].filter(Boolean).join(' '),
        issuer.addressLine2,
        [issuer.postalCode, issuer.city].filter(Boolean).join(' '),
        issuer.country,
      ]
        .filter(Boolean)
        .join('\n')
    : [
        [
          currentOrganization.address.street,
          currentOrganization.address.buildingNumber,
        ]
          .filter(Boolean)
          .join(' '),
        [
          currentOrganization.address.postalCode,
          currentOrganization.address.city,
        ]
          .filter(Boolean)
          .join(' '),
        currentOrganization.address.country,
      ]
        .filter(Boolean)
        .join('\n');
  const currentClient = workspace.clients.find(
    (item) => item.id === document.clientId,
  );
  const customer = frozen?.customer;
  const customerName =
    customer?.company ||
    customer?.name ||
    currentClient?.company ||
    currentClient?.name ||
    'Client non disponible';
  const customerAddress = customer
    ? [
        customer.addressLine1,
        customer.addressLine2,
        [customer.postalCode, customer.city].filter(Boolean).join(' '),
        customer.canton,
        customer.country,
      ]
        .filter(Boolean)
        .join('\n')
    : currentClient?.address || 'Adresse non renseignée';
  const logoPath = issuer?.logoPath || currentOrganization.logoPath;
  const logo = logoPath ? convertFileSrc(logoPath) : '';
  return (
    <div className="print-preview delivery-print-preview">
      <div className="print-preview__toolbar">
        <strong>Aperçu de la commande</strong>
        <span>
          {frozen
            ? `Identité, destinataire et lignes figés le ${formatDate(frozen.capturedAt.slice(0, 10))}.`
            : 'Ancienne commande sans snapshot complet · contrôlez les informations.'}
        </span>
        <Button variant="secondary" onClick={() => window.print()}>
          <Printer size={16} /> Imprimer
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      </div>
      <article className="print-sheet delivery-print-sheet sales-order-print-sheet">
        <header className="delivery-print-header">
          <div className="delivery-print-brand">
            {logo ? (
              <img src={logo} alt={`Logo ${issuerName}`} />
            ) : (
              <span>
                <PackageCheck size={30} />
              </span>
            )}
            <div>
              <strong>{issuerName}</strong>
              <small>{issuerLegalForm}</small>
            </div>
          </div>
          <div className="delivery-print-title">
            <span>COMMANDE CLIENT</span>
            <strong>{document.number}</strong>
          </div>
        </header>
        <div className="delivery-print-addresses">
          <section>
            <small>Émetteur</small>
            <strong>{issuerName}</strong>
            <p>
              {issuerAddress.split('\n').map((line, index) => (
                <span key={`${line}-${index}`}>
                  {line}
                  <br />
                </span>
              ))}
            </p>
            <p>
              {issuerEmail}
              {issuerPhone ? ` · ${issuerPhone}` : ''}
            </p>
          </section>
          <section>
            <small>Client</small>
            <strong>{customerName}</strong>
            <p>
              {customerAddress.split('\n').map((line, index) => (
                <span key={`${line}-${index}`}>
                  {line}
                  <br />
                </span>
              ))}
            </p>
          </section>
        </div>
        <div className="delivery-print-meta">
          <div>
            <span>Date</span>
            <strong>{formatDate(document.orderDate)}</strong>
          </div>
          <div>
            <span>Devise</span>
            <strong>{document.currency}</strong>
          </div>
          <div>
            <span>Total TTC</span>
            <strong>{formatMoney(document.totalCents)}</strong>
          </div>
        </div>
        <table className="delivery-print-table sales-order-print-table">
          <thead>
            <tr>
              <th>Article / prestation</th>
              <th>Quantité</th>
              <th>Prix unitaire</th>
              <th>Total TTC</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <strong>{line.description}</strong>
                  <small>
                    {line.discountBp
                      ? `Remise ${(line.discountBp / 100).toLocaleString('fr-CH')} % · TVA ${(line.vatBp / 100).toLocaleString('fr-CH')} %`
                      : `TVA ${(line.vatBp / 100).toLocaleString('fr-CH')} %`}
                  </small>
                </td>
                <td>
                  {formatCatalogQuantity(line.quantityMilli)} {line.unit}
                </td>
                <td>{formatMoney(line.unitPriceCents)}</td>
                <td>{formatMoney(line.lineTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {document.notes || document.terms ? (
          <section className="delivery-print-notes">
            <small>Conditions et remarques</small>
            <p>
              {[document.notes, document.terms].filter(Boolean).join('\n\n')}
            </p>
          </section>
        ) : null}
        <footer className="delivery-print-footer">
          <div>
            <span>Validation entreprise</span>
          </div>
          <div>
            <span>Acceptation client</span>
          </div>
          <p>
            Cette commande reprend les prix et quantités acceptés. Les
            livraisons et factures restent tracées séparément.
          </p>
        </footer>
      </article>
    </div>
  );
}

export function DeliveryNotePrintPreview({
  note,
  order,
  workspace,
  onClose,
}: {
  note: DeliveryNote;
  order: SalesOrder;
  workspace: Workspace;
  onClose: () => void;
}) {
  const frozen = note.snapshot;
  const document = frozen?.deliveryNote ?? note;
  const printedOrder = frozen?.order ?? order;
  const lines = frozen?.lines ?? note.lines;
  const currentOrganization = workspace.settings!.organization;
  const issuer = frozen?.issuer;
  const issuerName = issuer?.companyName || currentOrganization.legalName;
  const issuerLegalForm = issuer?.legalForm || currentOrganization.legalForm;
  const issuerEmail = issuer?.email || currentOrganization.email;
  const issuerPhone = issuer?.phone || currentOrganization.phone;
  const issuerAddress = issuer
    ? [
        [issuer.addressLine1, issuer.buildingNumber].filter(Boolean).join(' '),
        issuer.addressLine2,
        [issuer.postalCode, issuer.city].filter(Boolean).join(' '),
        issuer.country,
      ]
        .filter(Boolean)
        .join('\n')
    : [
        [
          currentOrganization.address.street,
          currentOrganization.address.buildingNumber,
        ]
          .filter(Boolean)
          .join(' '),
        [
          currentOrganization.address.postalCode,
          currentOrganization.address.city,
        ]
          .filter(Boolean)
          .join(' '),
        currentOrganization.address.country,
      ]
        .filter(Boolean)
        .join('\n');
  const currentClient = workspace.clients.find(
    (item) => item.id === printedOrder.clientId,
  );
  const customer = frozen?.customer;
  const customerName =
    customer?.company ||
    customer?.name ||
    currentClient?.company ||
    currentClient?.name ||
    'Client non disponible';
  const customerAddress = customer
    ? [
        customer.addressLine1,
        customer.addressLine2,
        [customer.postalCode, customer.city].filter(Boolean).join(' '),
        customer.canton,
        customer.country,
      ]
        .filter(Boolean)
        .join('\n')
    : currentClient?.address || 'Adresse non renseignée';
  const project = workspace.projects.find(
    (item) => item.id === printedOrder.projectId,
  );
  const logoPath = issuer?.logoPath || currentOrganization.logoPath;
  const logo = logoPath ? convertFileSrc(logoPath) : '';
  return (
    <div className="print-preview delivery-print-preview">
      <div className="print-preview__toolbar">
        <strong>Aperçu du bon de livraison</strong>
        <span>
          {frozen
            ? 'Document figé · identité, destinataire et quantités conservés.'
            : 'Ancien document sans snapshot complet · contrôlez les informations.'}
        </span>
        <Button variant="secondary" onClick={() => window.print()}>
          <Printer size={16} /> Imprimer
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      </div>
      <article className="print-sheet delivery-print-sheet">
        <header className="delivery-print-header">
          <div className="delivery-print-brand">
            {logo ? (
              <img src={logo} alt={`Logo ${issuerName}`} />
            ) : (
              <span>
                <PackageCheck size={30} />
              </span>
            )}
            <div>
              <strong>{issuerName}</strong>
              <small>{issuerLegalForm}</small>
            </div>
          </div>
          <div className="delivery-print-title">
            <span>BON DE LIVRAISON</span>
            <strong>{document.number}</strong>
          </div>
        </header>
        <div className="delivery-print-addresses">
          <section>
            <small>Expéditeur</small>
            <strong>{issuerName}</strong>
            <p>
              {issuerAddress.split('\n').map((line, index) => (
                <span key={`${line}-${index}`}>
                  {line}
                  <br />
                </span>
              ))}
            </p>
            <p>
              {issuerEmail}
              {issuerPhone ? ` · ${issuerPhone}` : ''}
            </p>
          </section>
          <section>
            <small>Destinataire</small>
            <strong>{customerName}</strong>
            <p>
              {customerAddress.split('\n').map((line, index) => (
                <span key={`${line}-${index}`}>
                  {line}
                  <br />
                </span>
              ))}
            </p>
            {project ? (
              <p>
                <strong>Livraison / projet :</strong> {project.name}
                <br />
                {project.address}
              </p>
            ) : null}
          </section>
        </div>
        <div className="delivery-print-meta">
          <div>
            <span>Date</span>
            <strong>{formatDate(document.deliveryDate)}</strong>
          </div>
          <div>
            <span>Commande</span>
            <strong>{printedOrder.number || printedOrder.title}</strong>
          </div>
          <div>
            <span>Référence</span>
            <strong>{document.reference || '—'}</strong>
          </div>
        </div>
        <table className="delivery-print-table">
          <thead>
            <tr>
              <th>Article / prestation</th>
              <th>Quantité livrée</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((deliveryLine) => {
              const orderLine = order.lines.find(
                (line) => line.id === deliveryLine.salesOrderLineId,
              );
              return (
                <tr key={deliveryLine.id}>
                  <td>
                    <strong>
                      {deliveryLine.description ||
                        orderLine?.description ||
                        'Article'}
                    </strong>
                    {orderLine?.catalogItemId ? (
                      <small>Référence catalogue liée</small>
                    ) : null}
                  </td>
                  <td>
                    {formatCatalogQuantity(deliveryLine.quantityMilli)}{' '}
                    {deliveryLine.unit || orderLine?.unit}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {document.notes ? (
          <section className="delivery-print-notes">
            <small>Remarques</small>
            <p>{document.notes}</p>
          </section>
        ) : null}
        <footer className="delivery-print-footer">
          <div>
            <span>Remis par</span>
          </div>
          <div>
            <span>Reçu par / signature</span>
          </div>
          <p>
            Ce bon constate uniquement les quantités livrées. Il ne constitue
            pas une facture.
          </p>
        </footer>
      </article>
    </div>
  );
}
