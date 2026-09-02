import {
  CalendarClock,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  FileClock,
  FileText,
  History,
  LockKeyhole,
  Plus,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Button, StatusBadge } from './ui';
import { createId } from './utils';
import './RecurringDocumentsPanel.css';

export type RecurringDocumentOrderStatus =
  | 'draft'
  | 'confirmed'
  | 'closed'
  | 'cancelled';

export type RecurringDocumentFrequency = 'monthly' | 'quarterly' | 'yearly';

export type RecurringDocumentScheduleStatus =
  | 'active'
  | 'paused'
  | 'review_required'
  | 'completed';

export type RecurringDocumentOrder = {
  id: string;
  number: string;
  title: string;
  clientName: string;
  orderDate: string;
  status: RecurringDocumentOrderStatus;
  eligible: boolean;
  blockingReasons?: readonly string[];
};

export type RecurringDocumentScheduleCreateInput = {
  requestId: string;
  sourceSalesOrderId: string;
  frequency: RecurringDocumentFrequency;
  startDate: string;
  endDate: string | null;
  paymentTermsDays: number;
};

export type RecurringDocumentScheduleUpdateInput = {
  requestId: string;
  scheduleId: string;
  status: Extract<
    RecurringDocumentScheduleStatus,
    'active' | 'paused' | 'completed'
  >;
  endDate: string | null;
};

export type RecurringDocumentOccurrence = {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  invoiceId: string;
  requestId: string;
  payloadSha256: string;
  sourceSnapshotSha256: string;
  createdAt: string;
  invoiceStatus: string;
  invoiceNumber: string | null;
};

export type RecurringDocumentSchedule = {
  id: string;
  sourceSalesOrderId: string;
  status: RecurringDocumentScheduleStatus;
  frequency: RecurringDocumentFrequency;
  startDate: string;
  endDate: string | null;
  paymentTermsDays: number;
  nextOccurrenceOn: string | null;
  pendingCatchUpCount: number;
  reviewReason?: string | null;
  occurrences: readonly RecurringDocumentOccurrence[];
};

export type RecurringDocumentsPanelProps = {
  order: RecurringDocumentOrder;
  schedule: RecurringDocumentSchedule | null;
  onCreate: (
    input: RecurringDocumentScheduleCreateInput,
  ) => void | Promise<void>;
  onUpdate: (
    input: RecurringDocumentScheduleUpdateInput,
  ) => void | Promise<void>;
  onOpenDraftInvoice?: (occurrence: RecurringDocumentOccurrence) => void;
  busy?: boolean;
  readOnly?: boolean;
  today?: string;
  catchUpLimit?: number;
  defaultPaymentTermsDays?: number;
  defaultCreateOpen?: boolean;
  notice?: string | null;
  error?: string | null;
};

export type RecurringScheduleValidationErrors = Partial<
  Record<'frequency' | 'startDate' | 'endDate' | 'paymentTermsDays', string>
>;

export const DEFAULT_RECURRING_CATCH_UP_LIMIT = 12;

const frequencyLabels: Record<RecurringDocumentFrequency, string> = {
  monthly: 'Mensuelle',
  quarterly: 'Trimestrielle',
  yearly: 'Annuelle',
};

function localTodayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function recurringOrderBlockingMessages(order: RecurringDocumentOrder) {
  const messages: string[] = [];
  if (order.status !== 'confirmed') {
    messages.push(
      order.status === 'draft'
        ? 'Confirmez d’abord la commande pour figer son contenu.'
        : 'Seule une commande confirmée et encore exploitable peut devenir récurrente.',
    );
  }
  if (!order.eligible) {
    const reasons = order.blockingReasons?.filter(
      (reason) => reason.trim().length > 0,
    );
    messages.push(
      ...(reasons?.length
        ? reasons
        : [
            'Cette commande contient des lignes qui ne peuvent pas servir de modèle récurrent.',
          ]),
    );
  }
  return [...new Set(messages)];
}

export function createRecurringRequestId() {
  return createId();
}

export function createRecurringScheduleInput(
  sourceSalesOrderId: string,
  today: string,
  requestId = createRecurringRequestId(),
  paymentTermsDays = 30,
): RecurringDocumentScheduleCreateInput {
  return {
    requestId,
    sourceSalesOrderId,
    frequency: 'monthly',
    startDate: today,
    endDate: null,
    paymentTermsDays,
  };
}

export function validateRecurringScheduleInput(
  draft: RecurringDocumentScheduleCreateInput,
  minimumStartDate?: string,
): RecurringScheduleValidationErrors {
  const errors: RecurringScheduleValidationErrors = {};
  if (!['monthly', 'quarterly', 'yearly'].includes(draft.frequency)) {
    errors.frequency = 'Choisissez une fréquence proposée.';
  }
  if (!validIsoDate(draft.startDate)) {
    errors.startDate = 'Indiquez une date de début valide.';
  } else if (
    minimumStartDate &&
    validIsoDate(minimumStartDate) &&
    draft.startDate < minimumStartDate
  ) {
    errors.startDate =
      'La première échéance ne peut pas précéder la date de la commande.';
  }
  if (draft.endDate && !validIsoDate(draft.endDate)) {
    errors.endDate = 'Indiquez une date de fin valide.';
  } else if (
    draft.endDate &&
    validIsoDate(draft.startDate) &&
    draft.endDate < draft.startDate
  ) {
    errors.endDate = 'La date de fin doit suivre la date de début.';
  }
  if (
    !Number.isInteger(draft.paymentTermsDays) ||
    draft.paymentTermsDays < 0 ||
    draft.paymentTermsDays > 365
  ) {
    errors.paymentTermsDays =
      'Le délai doit être compris entre 0 et 365 jours.';
  }
  return errors;
}

export function recurringCatchUpState(pending: number, limit: number) {
  const safePending = Number.isFinite(pending)
    ? Math.max(0, Math.trunc(pending))
    : 0;
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.trunc(limit))
    : DEFAULT_RECURRING_CATCH_UP_LIMIT;
  return {
    pending: safePending,
    limit: safeLimit,
    requiresReview: safePending > safeLimit,
  };
}

export function sortedRecurringOccurrences(
  occurrences: readonly RecurringDocumentOccurrence[],
) {
  return [...occurrences].sort(
    (left, right) =>
      right.scheduledFor.localeCompare(left.scheduledFor) ||
      (right.createdAt ?? '').localeCompare(left.createdAt ?? '') ||
      right.id.localeCompare(left.id),
  );
}

export function recurringScheduleRhythm(
  schedule: Pick<RecurringDocumentSchedule, 'frequency' | 'startDate'>,
) {
  const frequency = frequencyLabels[schedule.frequency];
  if (!validIsoDate(schedule.startDate)) return frequency;
  const [year, month, day] = schedule.startDate.split('-').map(Number);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const monthEnd = nextDay.getUTCMonth() !== month - 1;
  return `${frequency}, ${monthEnd ? 'en fin de mois' : `le ${day}`}`;
}

function formatIsoDate(value: string | null) {
  if (!value || !validIsoDate(value)) return '—';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-CH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function callbackError(reason: unknown) {
  if (typeof reason === 'string' && reason.trim()) return reason;
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (
    reason &&
    typeof reason === 'object' &&
    'message' in reason &&
    typeof reason.message === 'string' &&
    reason.message.trim()
  )
    return reason.message;
  return 'L’action n’a pas pu être enregistrée.';
}

function isDraftInvoiceStatus(status: string) {
  return ['draft', 'brouillon'].includes(status.trim().toLowerCase());
}

export function recurringInvoiceStatusLabel(status: string) {
  const normalized = status.trim().toLowerCase();
  const labels: Record<string, string> = {
    draft: 'Facture brouillon à contrôler',
    brouillon: 'Facture brouillon à contrôler',
    open: 'Facture ouverte',
    sent: 'Facture envoyée',
    paid: 'Facture payée',
    issued: 'Facture émise',
    partially_paid: 'Facture partiellement payée',
    cancelled: 'Facture annulée',
    canceled: 'Facture annulée',
  };
  return labels[normalized] ?? `Statut de facture : ${status || 'inconnu'}`;
}

export function RecurringDocumentsPanel({
  order,
  schedule,
  onCreate,
  onUpdate,
  onOpenDraftInvoice,
  busy = false,
  readOnly = false,
  today = localTodayIso(),
  catchUpLimit = DEFAULT_RECURRING_CATCH_UP_LIMIT,
  defaultPaymentTermsDays = 30,
  defaultCreateOpen = false,
  notice,
  error,
}: RecurringDocumentsPanelProps) {
  const headingId = useId();
  const formHeadingId = useId();
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const [createOpen, setCreateOpen] = useState(defaultCreateOpen);
  const initialStartDate =
    validIsoDate(order.orderDate) && order.orderDate > today
      ? order.orderDate
      : today;
  const [draft, setDraft] = useState(() =>
    createRecurringScheduleInput(
      order.id,
      initialStartDate,
      createRecurringRequestId(),
      defaultPaymentTermsDays,
    ),
  );
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusRequestIds, setStatusRequestIds] = useState<
    Partial<Record<'active' | 'paused' | 'completed', string>>
  >({});
  const [localError, setLocalError] = useState('');
  const orderBlockers = recurringOrderBlockingMessages(order);
  const safeCatchUpLimit = recurringCatchUpState(0, catchUpLimit).limit;
  const validationErrors = useMemo(
    () => validateRecurringScheduleInput(draft, order.orderDate),
    [draft, order.orderDate],
  );
  const validationErrorCount = Object.keys(validationErrors).length;
  const disabled = busy || submitting || statusBusy;

  useEffect(() => {
    setCreateOpen(defaultCreateOpen && !schedule);
    setDraft(
      createRecurringScheduleInput(
        order.id,
        initialStartDate,
        createRecurringRequestId(),
        defaultPaymentTermsDays,
      ),
    );
    setShowErrors(false);
    setLocalError('');
    setStatusRequestIds({});
  }, [
    defaultCreateOpen,
    defaultPaymentTermsDays,
    order.id,
    order.orderDate,
    schedule?.endDate,
    schedule?.id,
    initialStartDate,
  ]);

  useEffect(() => {
    if (showErrors && validationErrorCount > 0) {
      errorSummaryRef.current?.focus({ preventScroll: true });
    }
  }, [showErrors, validationErrorCount]);

  async function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowErrors(true);
    setLocalError('');
    if (orderBlockers.length || validationErrorCount) return;
    setSubmitting(true);
    try {
      await onCreate({
        ...draft,
        endDate: draft.endDate || null,
      });
      setCreateOpen(false);
      setShowErrors(false);
    } catch (reason) {
      setLocalError(callbackError(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(
    nextStatus: Extract<
      RecurringDocumentScheduleStatus,
      'active' | 'paused' | 'completed'
    >,
  ) {
    if (!schedule) return;
    if (
      nextStatus === 'completed' &&
      !window.confirm(
        'Terminer définitivement cette planification ? Les brouillons déjà créés resteront disponibles, mais aucune nouvelle échéance ne sera préparée.',
      )
    )
      return;
    const requestId =
      statusRequestIds[nextStatus] ?? createRecurringRequestId();
    if (!statusRequestIds[nextStatus]) {
      setStatusRequestIds((current) => ({
        ...current,
        [nextStatus]: requestId,
      }));
    }
    setStatusBusy(true);
    setLocalError('');
    try {
      await onUpdate({
        requestId,
        scheduleId: schedule.id,
        status: nextStatus,
        endDate: schedule.endDate,
      });
      setStatusRequestIds((current) => {
        const next = { ...current };
        delete next[nextStatus];
        return next;
      });
    } catch (reason) {
      setLocalError(callbackError(reason));
    } finally {
      setStatusBusy(false);
    }
  }

  function updateDraft(
    patch: Partial<
      Pick<
        RecurringDocumentScheduleCreateInput,
        'frequency' | 'startDate' | 'endDate' | 'paymentTermsDays'
      >
    >,
  ) {
    setDraft((current) => ({
      ...current,
      ...patch,
      requestId: createRecurringRequestId(),
    }));
  }

  return (
    <section className="recurring-documents panel" aria-labelledby={headingId}>
      <header className="recurring-documents__header">
        <div className="recurring-documents__heading-icon" aria-hidden="true">
          <CalendarClock size={21} />
        </div>
        <div>
          <p className="eyebrow">Documents récurrents</p>
          <h3 id={headingId}>Planification de cette commande</h3>
          <p>
            Définissez les futures échéances sans modifier la commande
            confirmée.
          </p>
        </div>
        {schedule ? <ScheduleStatus status={schedule.status} /> : null}
      </header>

      <div className="recurring-documents__assurance">
        <ShieldCheck size={18} aria-hidden="true" />
        <p>
          Chaque échéance prépare une{' '}
          <strong>facture brouillon à contrôler</strong>. Aucune facture n’est
          émise, envoyée ou comptabilisée automatiquement. Le contrôle local
          s’exécute au démarrage et tant que Zentra reste ouvert.
        </p>
      </div>

      {readOnly ? (
        <div className="recurring-documents__readonly" role="note">
          <LockKeyhole size={17} aria-hidden="true" />
          <span>Mode lecture seule : la planification reste consultable.</span>
        </div>
      ) : null}
      {error || localError ? (
        <div
          className="recurring-documents__message recurring-documents__message--danger"
          role="alert"
        >
          <TriangleAlert size={18} aria-hidden="true" />
          <span>{error || localError}</span>
        </div>
      ) : null}
      {notice ? (
        <div
          className="recurring-documents__message recurring-documents__message--success"
          role="status"
        >
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      ) : null}

      {schedule ? (
        <RecurringScheduleView
          order={order}
          schedule={schedule}
          catchUpLimit={safeCatchUpLimit}
          disabled={disabled}
          readOnly={readOnly}
          onStatusChange={(status) => void changeStatus(status)}
          onOpenDraftInvoice={onOpenDraftInvoice}
        />
      ) : orderBlockers.length ? (
        <BlockedOrderState order={order} messages={orderBlockers} />
      ) : createOpen ? (
        <form
          className="recurring-documents__form"
          aria-labelledby={formHeadingId}
          noValidate
          onSubmit={submitSchedule}
        >
          <div className="recurring-documents__form-heading">
            <div>
              <h4 id={formHeadingId}>Nouvelle planification</h4>
              <p>
                Commande {order.number} · {order.clientName}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Fermer le formulaire de planification"
              onClick={() => {
                setCreateOpen(false);
                setShowErrors(false);
                setLocalError('');
              }}
              disabled={submitting}
            >
              <X size={18} />
            </Button>
          </div>

          {showErrors && validationErrorCount ? (
            <div
              ref={errorSummaryRef}
              className="recurring-documents__error-summary"
              role="alert"
              tabIndex={-1}
            >
              <strong>Vérifiez les paramètres de planification.</strong>
              <span>
                {validationErrorCount} champ
                {validationErrorCount > 1 ? 's' : ''} à corriger.
              </span>
            </div>
          ) : null}

          <fieldset className="recurring-documents__choices">
            <legend>Fréquence</legend>
            <div>
              {(
                [
                  ['monthly', 'Mensuelle', 'Chaque mois'],
                  ['quarterly', 'Trimestrielle', 'Tous les trois mois'],
                  ['yearly', 'Annuelle', 'Chaque année'],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="recurring-frequency"
                    value={value}
                    checked={draft.frequency === value}
                    onChange={() => updateDraft({ frequency: value })}
                    disabled={disabled || readOnly}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="recurring-documents__form-grid">
            <RecurringField
              id={`${formHeadingId}-start-date`}
              label="Première échéance"
              hint="Cette date fixe le jour d’ancrage de la planification."
              error={showErrors ? validationErrors.startDate : undefined}
              required
            >
              <input
                id={`${formHeadingId}-start-date`}
                type="date"
                min={validIsoDate(order.orderDate) ? order.orderDate : undefined}
                value={draft.startDate}
                aria-describedby={`${formHeadingId}-start-date-description`}
                aria-invalid={Boolean(showErrors && validationErrors.startDate)}
                onChange={(event) =>
                  updateDraft({ startDate: event.target.value })
                }
                disabled={disabled || readOnly}
                required
              />
            </RecurringField>
            <RecurringField
              id={`${formHeadingId}-end-date`}
              label="Fin de planification"
              hint="Facultative : laissez vide pour ne pas fixer de fin."
              error={showErrors ? validationErrors.endDate : undefined}
            >
              <input
                id={`${formHeadingId}-end-date`}
                type="date"
                min={draft.startDate || undefined}
                value={draft.endDate ?? ''}
                aria-describedby={`${formHeadingId}-end-date-description`}
                aria-invalid={Boolean(showErrors && validationErrors.endDate)}
                onChange={(event) =>
                  updateDraft({ endDate: event.target.value || null })
                }
                disabled={disabled || readOnly}
              />
            </RecurringField>
            <RecurringField
              id={`${formHeadingId}-payment-terms`}
              label="Délai de paiement"
              hint="Ajouté à la date du futur brouillon."
              error={showErrors ? validationErrors.paymentTermsDays : undefined}
              suffix="jours"
              required
            >
              <input
                id={`${formHeadingId}-payment-terms`}
                type="number"
                min="0"
                max="365"
                step="1"
                value={draft.paymentTermsDays}
                aria-describedby={`${formHeadingId}-payment-terms-description`}
                aria-invalid={Boolean(
                  showErrors && validationErrors.paymentTermsDays,
                )}
                onChange={(event) =>
                  updateDraft({
                    paymentTermsDays: Number(event.target.value),
                  })
                }
                disabled={disabled || readOnly}
                required
              />
            </RecurringField>
          </div>

          <div className="recurring-documents__anchor-note" role="note">
            <CalendarClock size={18} aria-hidden="true" />
            <p>
              Le jour de la date de début devient l’ancrage. Si elle est le
              dernier jour du mois, les échéances suivantes restent en fin de
              mois.
            </p>
          </div>

          <div className="recurring-documents__catch-up-note" role="note">
            <FileClock size={18} aria-hidden="true" />
            <p>
              La limite de rattrapage est de <strong>{safeCatchUpLimit}</strong>{' '}
              échéances par lot. Après une période hors ligne, chaque lot
              prépare uniquement des factures brouillon à contrôler ; au-delà,
              une revue et une reprise explicite sont exigées.
            </p>
          </div>

          <div className="recurring-documents__actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setCreateOpen(false);
                setShowErrors(false);
              }}
              disabled={submitting}
            >
              Annuler
            </Button>
            <Button type="submit" disabled={disabled || readOnly}>
              <CalendarClock size={16} />
              {submitting ? 'Création…' : 'Créer la planification'}
            </Button>
          </div>
        </form>
      ) : (
        <EligibleOrderState
          order={order}
          disabled={busy || readOnly}
          onCreate={() => setCreateOpen(true)}
        />
      )}
    </section>
  );
}

function EligibleOrderState({
  order,
  disabled,
  onCreate,
}: {
  order: RecurringDocumentOrder;
  disabled: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="recurring-documents__empty">
      <div aria-hidden="true">
        <FileText size={25} />
      </div>
      <div>
        <h4>Aucune planification pour cette commande</h4>
        <p>
          La commande confirmée {order.number} est éligible. Une seule
          planification peut lui être associée.
        </p>
      </div>
      <Button type="button" onClick={onCreate} disabled={disabled}>
        <Plus size={16} /> Planifier cette commande
      </Button>
    </div>
  );
}

function BlockedOrderState({
  order,
  messages,
}: {
  order: RecurringDocumentOrder;
  messages: readonly string[];
}) {
  return (
    <div className="recurring-documents__blocked" role="alert">
      <TriangleAlert size={22} aria-hidden="true" />
      <div>
        <h4>Planification indisponible pour {order.number}</h4>
        <p>Corrigez d’abord les points suivants :</p>
        <ul>
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function RecurringScheduleView({
  order,
  schedule,
  catchUpLimit,
  disabled,
  readOnly,
  onStatusChange,
  onOpenDraftInvoice,
}: {
  order: RecurringDocumentOrder;
  schedule: RecurringDocumentSchedule;
  catchUpLimit: number;
  disabled: boolean;
  readOnly: boolean;
  onStatusChange: (
    status: Extract<
      RecurringDocumentScheduleStatus,
      'active' | 'paused' | 'completed'
    >,
  ) => void;
  onOpenDraftInvoice?: (occurrence: RecurringDocumentOccurrence) => void;
}) {
  const catchUpReviewId = useId();
  const mismatch = schedule.sourceSalesOrderId !== order.id;
  const catchUp = recurringCatchUpState(
    schedule.pendingCatchUpCount,
    catchUpLimit,
  );
  const occurrences = sortedRecurringOccurrences(schedule.occurrences);
  const canResume =
    (schedule.status === 'paused' || schedule.status === 'review_required') &&
    !mismatch;
  const requiresCatchUpReview =
    schedule.status === 'review_required' || catchUp.requiresReview;

  return (
    <div className="recurring-documents__schedule">
      {mismatch ? (
        <div
          className="recurring-documents__message recurring-documents__message--danger"
          role="alert"
        >
          <TriangleAlert size={18} aria-hidden="true" />
          <span>
            Cette planification ne correspond pas à la commande affichée. Aucune
            action n’est autorisée.
          </span>
        </div>
      ) : null}

      <div className="recurring-documents__summary">
        <SummaryFact
          label="Prochaine échéance"
          value={
            schedule.nextOccurrenceOn ? (
              <time dateTime={schedule.nextOccurrenceOn}>
                {formatIsoDate(schedule.nextOccurrenceOn)}
              </time>
            ) : (
              'Aucune'
            )
          }
          emphasized
        />
        <SummaryFact label="Rythme" value={recurringScheduleRhythm(schedule)} />
        <SummaryFact
          label="Période"
          value={
            <>
              <time dateTime={schedule.startDate}>
                {formatIsoDate(schedule.startDate)}
              </time>{' '}
              →{' '}
              {schedule.endDate ? (
                <time dateTime={schedule.endDate}>
                  {formatIsoDate(schedule.endDate)}
                </time>
              ) : (
                'sans date de fin'
              )}
            </>
          }
        />
        <SummaryFact
          label="Délai de paiement"
          value={`${schedule.paymentTermsDays} jour${schedule.paymentTermsDays > 1 ? 's' : ''}`}
        />
      </div>

      {catchUp.pending > 0 || schedule.status === 'review_required' ? (
        <div
          className={`recurring-documents__catch-up ${
            requiresCatchUpReview ? 'recurring-documents__catch-up--review' : ''
          }`}
          role={requiresCatchUpReview ? 'alert' : 'status'}
          aria-live="polite"
        >
          <FileClock size={19} aria-hidden="true" />
          <div>
            <strong>
              {catchUp.pending > 0
                ? `${catchUp.pending} échéance${catchUp.pending > 1 ? 's' : ''} en attente`
                : 'Revue du rattrapage requise'}
            </strong>
            {requiresCatchUpReview ? (
              <p id={catchUpReviewId}>
                {schedule.reviewReason ||
                  `La limite de rattrapage est de ${catchUp.limit} échéances par lot. Le traitement s’est arrêté pour contrôle ; une reprise explicite préparera au plus ${catchUp.limit} nouvelles factures brouillon à contrôler.`}
              </p>
            ) : (
              <p>
                Le prochain traitement préparera au plus {catchUp.limit}{' '}
                factures brouillon à contrôler.
              </p>
            )}
          </div>
        </div>
      ) : null}

      <div className="recurring-documents__schedule-actions">
        {schedule.status === 'active' ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => onStatusChange('paused')}
            disabled={disabled || readOnly || mismatch}
          >
            <CirclePause size={16} /> Mettre en pause
          </Button>
        ) : null}
        {schedule.status === 'paused' ? (
          <Button
            type="button"
            onClick={() => onStatusChange('active')}
            disabled={disabled || readOnly || !canResume}
            aria-describedby={
              requiresCatchUpReview ? catchUpReviewId : undefined
            }
          >
            <CirclePlay size={16} />
            {requiresCatchUpReview
              ? `Reprendre et préparer au plus ${catchUp.limit} brouillons`
              : 'Reprendre la planification'}
          </Button>
        ) : null}
        {schedule.status === 'review_required' ? (
          <Button
            type="button"
            onClick={() => onStatusChange('active')}
            disabled={disabled || readOnly || !canResume}
            aria-describedby={catchUpReviewId}
          >
            <CirclePlay size={16} /> Reprendre et préparer au plus{' '}
            {catchUp.limit} brouillons
          </Button>
        ) : null}
        {schedule.status !== 'completed' ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => onStatusChange('completed')}
            disabled={disabled || readOnly || mismatch}
          >
            <CheckCircle2 size={16} /> Terminer définitivement
          </Button>
        ) : null}
        {schedule.status === 'completed' ? (
          <p className="recurring-documents__completed-note">
            Cette planification est terminée. Son historique reste consultable.
          </p>
        ) : null}
      </div>

      <details className="recurring-documents__history" open>
        <summary>
          <History size={17} aria-hidden="true" />
          Historique des occurrences
          <span>{occurrences.length}</span>
        </summary>
        {occurrences.length ? (
          <ol>
            {occurrences.map((occurrence) => (
              <li key={occurrence.id}>
                <span
                  className={`recurring-documents__occurrence-marker recurring-documents__occurrence-marker--${
                    isDraftInvoiceStatus(occurrence.invoiceStatus)
                      ? 'draft'
                      : 'other'
                  }`}
                  aria-hidden="true"
                />
                <div>
                  <div className="recurring-documents__occurrence-heading">
                    <strong>
                      {recurringInvoiceStatusLabel(occurrence.invoiceStatus)}
                    </strong>
                    <time dateTime={occurrence.scheduledFor}>
                      {formatIsoDate(occurrence.scheduledFor)}
                    </time>
                  </div>
                  <p>
                    {occurrence.invoiceNumber
                      ? `Nº ${occurrence.invoiceNumber}`
                      : 'Numéro attribué lors de l’émission'}
                  </p>
                </div>
                {occurrence.invoiceId && onOpenDraftInvoice ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    onClick={() => onOpenDraftInvoice(occurrence)}
                    aria-label={`Ouvrir la facture ${
                      occurrence.invoiceNumber ?? occurrence.scheduledFor
                    }`}
                  >
                    <FileText size={15} /> Ouvrir la facture
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="recurring-documents__history-empty">
            Aucune occurrence n’a encore été préparée.
          </p>
        )}
      </details>
    </div>
  );
}

function ScheduleStatus({
  status,
}: {
  status: RecurringDocumentScheduleStatus;
}) {
  const label =
    status === 'active'
      ? 'Planification active'
      : status === 'paused'
        ? 'En pause'
        : status === 'review_required'
          ? 'Revue requise'
          : 'Terminée';
  const badgeStatus =
    status === 'active'
      ? 'validated'
      : status === 'paused'
        ? 'paused'
        : status === 'review_required'
          ? 'incomplete'
          : 'closed';
  return <StatusBadge status={badgeStatus} label={label} />;
}

function SummaryFact({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: ReactNode;
  emphasized?: boolean;
}) {
  return (
    <div
      className={`recurring-documents__fact ${
        emphasized ? 'recurring-documents__fact--emphasized' : ''
      }`}
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RecurringField({
  id,
  label,
  hint,
  error,
  suffix,
  required = false,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  suffix?: string;
  required?: boolean;
  children: ReactNode;
}) {
  const descriptionId = `${id}-description`;
  return (
    <label
      className={`recurring-documents__field ${error ? 'is-error' : ''}`}
      htmlFor={id}
    >
      <span className="recurring-documents__field-label">
        {label}
        {required ? <em>obligatoire</em> : null}
      </span>
      <span className="recurring-documents__field-control">
        {children}
        {suffix ? <span>{suffix}</span> : null}
      </span>
      {error ? (
        <span id={descriptionId} className="recurring-documents__field-error">
          {error}
        </span>
      ) : hint ? (
        <span id={descriptionId} className="recurring-documents__field-hint">
          {hint}
        </span>
      ) : null}
    </label>
  );
}
