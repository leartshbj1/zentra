import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  FileText,
  Mail,
  MessageSquareWarning,
  Plus,
  Printer,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { desktopApi } from './bridge';
import {
  compareReminderBalanceSnapshot,
  reminderHistoryActionLabel,
  reminderPreviewSessionKey,
  reminderStatusLabel,
  sortRemindersByUrgency,
  validateReminderAsOfDate,
} from './remindersUi';
import type {
  Reminder,
  ReminderActionResult,
  ReminderDeliveryAction,
  ReminderHistory,
  ReminderPreview,
  ReminderSettings,
  ReminderTemplate,
} from './types';
import { errorMessage, formatDate, formatMoney, todayIso } from './utils';
import {
  Button,
  EmptyState,
  ErrorPanel,
  Field,
  Modal,
  SectionHeading,
  StatusBadge,
  submitForm,
} from './ui';

type Tab = 'queue' | 'templates' | 'history' | 'settings';
type Resolution = { reminder: Reminder };

const tabs: Array<[Tab, string]> = [
  ['queue', 'À valider'],
  ['templates', 'Cycle & textes'],
  ['history', 'Historique'],
  ['settings', 'Réglages'],
];

const cycleSummary = [
  ['1', 'Rappel amical', '7 jours après l’échéance'],
  ['2', 'Première relance', '21 jours après l’échéance'],
  ['3', 'Dernière relance', '35 jours après l’échéance'],
] as const;

export function RemindersScreen({
  readOnly = false,
  refreshSignal = 0,
}: {
  readOnly?: boolean;
  refreshSignal?: number;
}) {
  const [tab, setTab] = useState<Tab>('queue');
  const [settings, setSettings] = useState<ReminderSettings>({
    enabled: false,
    senderName: '',
    lastScanAt: '',
  });
  const [settingsDraft, setSettingsDraft] = useState<ReminderSettings>({
    enabled: false,
    senderName: '',
    lastScanAt: '',
  });
  const [templates, setTemplates] = useState<ReminderTemplate[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [history, setHistory] = useState<ReminderHistory[]>([]);
  const [selectedReminderId, setSelectedReminderId] = useState('');
  const [templateDraft, setTemplateDraft] =
    useState<Partial<ReminderTemplate> | null>(null);
  const [templateToDelete, setTemplateToDelete] =
    useState<ReminderTemplate | null>(null);
  const [asOf, setAsOf] = useState(todayIso());
  const [preview, setPreview] = useState<ReminderPreview | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState(1);
  const [setupSender, setSetupSender] = useState('');
  const [setupConfirmed, setSetupConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const scanRequestIds = useRef(new Map<string, string>());
  const setupRequestId = useRef('');
  const actionRequestIds = useRef(new Map<string, string>());
  const historyRequestSerial = useRef(0);
  const refreshSignalSeen = useRef(refreshSignal);

  async function perform<T>(action: () => Promise<T>, success?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await action();
      if (success) setNotice(success);
      return result;
    } catch (reason) {
      setError(errorMessage(reason, 'L’action de relance locale a échoué.'));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    const [nextSettings, nextTemplates, nextReminders] = await Promise.all([
      desktopApi.getReminderSettings(),
      desktopApi.listReminderTemplates(),
      desktopApi.listReminders(),
    ]);
    setSettings(nextSettings);
    setSettingsDraft(nextSettings);
    setTemplates(nextTemplates);
    setReminders(nextReminders);
    setSetupSender(nextSettings.senderName);
  }

  useEffect(() => {
    void perform(load);
  }, []);

  useEffect(() => {
    if (refreshSignalSeen.current === refreshSignal) return;
    refreshSignalSeen.current = refreshSignal;
    void perform(async () => {
      const [nextSettings, nextReminders] = await Promise.all([
        desktopApi.getReminderSettings(),
        desktopApi.listReminders(),
      ]);
      setSettings((current) => ({
        ...current,
        lastScanAt: nextSettings.lastScanAt,
      }));
      setReminders(nextReminders);
    });
  }, [refreshSignal]);

  const today = todayIso();
  const dateError = validateReminderAsOfDate(asOf, today);
  const openReminders = useMemo(
    () =>
      sortRemindersByUrgency(
        reminders.filter(
          (reminder) =>
            reminder.status === 'due' || reminder.status === 'planned',
        ),
        today,
      ),
    [reminders, today],
  );
  const selectedReminder = reminders.find(
    (reminder) => reminder.id === selectedReminderId,
  );
  const configured = templates.some((template) => template.active);

  async function scan() {
    if (dateError || readOnly) return;
    let requestId = scanRequestIds.current.get(asOf);
    if (!requestId) {
      requestId = crypto.randomUUID();
      scanRequestIds.current.set(asOf, requestId);
    }
    const result = await perform(async () => {
      const scanResult = await desktopApi.scanDueReminders(requestId!, asOf);
      await load();
      return scanResult;
    });
    if (!result) return;
    scanRequestIds.current.delete(asOf);
    const created = result.created.length;
    const cancelled = result.cancelled.length;
    const anomalies = result.review.filter(
      (item) => item.reason !== 'already_open' && item.reason !== 'cycle_stopped',
    );
    setNotice(
      anomalies.length
        ? `${anomalies.length} cycle${anomalies.length > 1 ? 's' : ''} hérité${anomalies.length > 1 ? 's' : ''} exige${anomalies.length > 1 ? 'nt' : ''} un contrôle manuel dans l’historique. Aucune étape suivante n’a été créée pour ${anomalies.length > 1 ? 'ces factures' : 'cette facture'}.`
        : created || cancelled
        ? `${created} relance${created > 1 ? 's' : ''} préparée${created > 1 ? 's' : ''}, ${cancelled} arrêtée${cancelled > 1 ? 's' : ''} après règlement.`
        : 'Contrôle terminé : aucune nouvelle relance à préparer.',
    );
  }

  async function installCycle() {
    if (readOnly || !setupConfirmed) return;
    if (!setupRequestId.current) setupRequestId.current = crypto.randomUUID();
    const result = await perform(async () => {
      const installation = await desktopApi.installReminderCycle(
        setupRequestId.current,
        setupSender.trim() || undefined,
      );
      await load();
      return installation;
    });
    if (!result) return;
    setupRequestId.current = '';
    setSetupOpen(false);
    setSetupStep(1);
    setSetupConfirmed(false);
    setNotice(
      result.createdLevels.length
        ? 'Le cycle conseillé a été installé. Relisez les textes avant le premier envoi.'
        : 'Vos niveaux existants ont été conservés et les relances ont été activées.',
    );
  }

  async function prepare(reminder: Reminder) {
    const result = await perform(() =>
      desktopApi.previewReminderDelivery(reminder.id, todayIso()),
    );
    if (result) setPreview(result);
  }

  async function refreshPreview(
    current: ReminderPreview,
  ): Promise<ReminderPreview | null> {
    const result = await perform(() =>
      desktopApi.previewReminderDelivery(current.reminderId, todayIso()),
    );
    if (result) {
      setPreview(result);
      if (result.previewSha256 !== current.previewSha256) {
        setNotice(
          'Le solde ou les coordonnées ont changé. L’aperçu a été actualisé : relisez-le avant de continuer.',
        );
      }
    }
    return result;
  }

  async function recordPreviewAction(
    action: ReminderDeliveryAction,
    note?: string,
  ): Promise<ReminderActionResult | null> {
    if (!preview || readOnly) return null;
    const key = `${preview.reminderId}:${action}:${preview.previewSha256}`;
    let requestId = actionRequestIds.current.get(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      actionRequestIds.current.set(key, requestId);
    }
    const result = await perform(async () => {
      const actionResult = await desktopApi.recordReminderAction({
        requestId: requestId!,
        id: preview.reminderId,
        action,
        preparedOn: preview.preparedOn,
        previewSha256: preview.previewSha256,
        note,
      });
      await load();
      return actionResult;
    });
    if (!result) return null;
    actionRequestIds.current.delete(key);
    if (result.blocked) {
      setPreview(null);
      setNotice('La facture est soldée : la relance a été arrêtée sans envoi.');
      return result;
    }
    if (action === 'manual_sent') {
      setPreview(null);
      setNotice('L’envoi manuel a été confirmé et le niveau a été clôturé.');
    } else if (action === 'mail_draft_created') {
      setNotice(
        'La demande d’ouverture du client e-mail a été tracée. Aucun envoi n’est considéré comme effectué sans votre confirmation.',
      );
    } else if (action === 'print_confirmed') {
      setNotice('L’impression a été confirmée dans l’historique local.');
    }
    return result;
  }

  async function selectHistory(id: string) {
    const serial = ++historyRequestSerial.current;
    setSelectedReminderId(id);
    setHistory([]);
    setBusy(true);
    setError('');
    try {
      const result = await desktopApi.getReminderHistory(id);
      if (serial === historyRequestSerial.current) setHistory(result);
    } catch (reason) {
      if (serial === historyRequestSerial.current) {
        setError(errorMessage(reason, 'L’historique n’a pas pu être chargé.'));
      }
    } finally {
      if (serial === historyRequestSerial.current) setBusy(false);
    }
  }

  async function resolveReminder() {
    if (!resolution || readOnly || resolutionNote.trim().length < 3) return;
    const result = await perform(
      async () => {
        const marked = await desktopApi.markReminder(
          resolution.reminder.id,
          'cancelled',
          resolutionNote,
        );
        await load();
        return marked;
      },
      'La relance a été clôturée sans envoi avec votre motif. Le cycle est arrêté.',
    );
    if (!result) return;
    setResolution(null);
    setResolutionNote('');
  }

  return (
    <div className="stack-layout reminders-screen">
      <section className="panel reminder-command-center">
        <div className="reminder-command-center__copy">
          <span className="reminder-command-center__icon">
            <MessageSquareWarning size={22} />
          </span>
          <div>
            <p className="eyebrow">Recouvrement supervisé</p>
            <h2>Chaque relance est préparée. Vous décidez de l’envoi.</h2>
            <p>
              Zentra recalcule le solde localement, bloque les factures soldées
              et conserve une preuve distincte de chaque action.
            </p>
          </div>
        </div>
        <div className="reminder-command-center__stats" aria-label="Résumé des relances">
          <span>
            <strong>{openReminders.length}</strong>
            à valider
          </span>
          <span>
            <strong>{templates.filter((item) => item.active).length}</strong>
            niveaux actifs
          </span>
          <span>
            <strong>{settings.lastScanAt ? formatDate(settings.lastScanAt) : 'Jamais'}</strong>
            dernier contrôle
          </span>
        </div>
      </section>

      <section className="panel reminder-toolbar">
        <div className="tab-strip" role="tablist" aria-label="Relances">
          {tabs.map(([id, label]) => (
            <button
              type="button"
              role="tab"
              id={`reminder-tab-${id}`}
              aria-controls={`reminder-panel-${id}`}
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              className={tab === id ? 'is-active' : ''}
              key={id}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const currentIndex = tabs.findIndex(([tabId]) => tabId === id);
                const lastIndex = tabs.length - 1;
                const nextIndex =
                  event.key === 'ArrowRight'
                    ? currentIndex === lastIndex
                      ? 0
                      : currentIndex + 1
                    : event.key === 'ArrowLeft'
                      ? currentIndex === 0
                        ? lastIndex
                        : currentIndex - 1
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? lastIndex
                          : -1;
                if (nextIndex < 0) return;
                event.preventDefault();
                const nextTab = tabs[nextIndex][0];
                setTab(nextTab);
                document.getElementById(`reminder-tab-${nextTab}`)?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div>
          <Field label="Contrôler jusqu’au" error={dateError || undefined}>
            <input
              type="date"
              max={today}
              value={asOf}
              disabled={busy || readOnly}
              onChange={(event) => setAsOf(event.target.value)}
            />
          </Field>
          <Button
            disabled={
              busy || readOnly || !!dateError || !settings.enabled || !configured
            }
            onClick={() => void scan()}
          >
            <RefreshCw className={busy ? 'spin' : ''} size={16} />
            Vérifier maintenant
          </Button>
        </div>
      </section>

      <div className="info-strip reminder-trust-strip">
        <ShieldCheck size={18} />
        <span>
          Données et historique sur ce PC. Aucun e-mail et aucune poursuite ne
          partent automatiquement.
        </span>
      </div>
      {readOnly ? (
        <div className="notice notice--warning" role="status">
          <span>
            <ShieldCheck size={18} /> Mode lecture seule : aperçus disponibles,
            aucune donnée ne peut être modifiée.
          </span>
        </div>
      ) : null}
      {error ? (
        <div
          className={
            setupOpen || templateDraft || templateToDelete || resolution || preview
              ? 'reminder-floating-error'
              : undefined
          }
        >
          <ErrorPanel message={error} />
        </div>
      ) : null}
      {notice ? (
        <div className="notice notice--success" role="status">
          <span>
            <CheckCircle2 size={18} /> {notice}
          </span>
          <button type="button" onClick={() => setNotice('')} aria-label="Fermer">
            <X size={15} />
          </button>
        </div>
      ) : null}

      {tab === 'queue' ? (
        <div
          role="tabpanel"
          id="reminder-panel-queue"
          aria-labelledby="reminder-tab-queue"
        >
          <QueuePanel
            busy={busy}
            configured={configured}
            readOnly={readOnly}
            reminders={openReminders}
            settings={settings}
            onSetup={() => {
              setSetupStep(1);
              setSetupOpen(true);
            }}
            onPrepare={(reminder) => void prepare(reminder)}
            onHistory={(reminder) => {
              setTab('history');
              void selectHistory(reminder.id);
            }}
            onResolve={(reminder) => {
              setResolution({ reminder });
              setResolutionNote('');
            }}
          />
        </div>
      ) : null}

      {tab === 'templates' ? (
        <section
          className="panel"
          role="tabpanel"
          id="reminder-panel-templates"
          aria-labelledby="reminder-tab-templates"
        >
          <SectionHeading
            eyebrow="Cycle réel"
            title="Niveaux et textes de relance"
            description="Les délais sont des recommandations modifiables. Les frais restent à CHF 0 et aucun intérêt n’est ajouté par ce module."
            action={
              <div className="reminder-heading-actions">
                <Button
                  variant="secondary"
                  disabled={busy || readOnly}
                  onClick={() => setSetupOpen(true)}
                >
                  <Sparkles size={15} /> Assistant 3 niveaux
                </Button>
                <Button
                  disabled={busy || readOnly}
                  onClick={() =>
                    setTemplateDraft({
                      active: true,
                      paymentDeadlineDays: 10,
                    })
                  }
                >
                  <Plus size={15} /> Nouveau niveau
                </Button>
              </div>
            }
          />
          {templates.length ? (
            <div className="template-list reminder-template-list">
              {templates.map((template) => (
                <article key={template.id}>
                  <span className="reminder-level">Niveau {template.level}</span>
                  <div>
                    <strong>{template.name}</strong>
                    <p>{template.subject}</p>
                    <small>
                      J+{template.daysAfterDue} · nouveau délai de{' '}
                      {template.paymentDeadlineDays} jours
                    </small>
                  </div>
                  <StatusBadge
                    status={template.active ? 'validated' : 'incomplete'}
                    label={template.active ? 'Actif' : 'Inactif'}
                  />
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy || readOnly}
                    onClick={() => setTemplateDraft(template)}
                  >
                    Modifier
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy || readOnly}
                    aria-label={`Supprimer ${template.name}`}
                    onClick={() => setTemplateToDelete(template)}
                  >
                    <Archive size={15} />
                  </Button>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<FileText />}
              title="Aucun cycle installé"
              text="L’assistant crée trois modèles neutres uniquement après votre confirmation. Aucune donnée de démonstration n’est ajoutée."
              actionLabel="Configurer en 2 minutes"
              onAction={() => setSetupOpen(true)}
              disabled={readOnly}
            />
          )}
        </section>
      ) : null}

      {tab === 'history' ? (
        <section
          className="panel"
          role="tabpanel"
          id="reminder-panel-history"
          aria-labelledby="reminder-tab-history"
        >
          <SectionHeading
            eyebrow="Preuves locales"
            title="Historique des relances"
            description="Un brouillon, une impression et un envoi confirmé restent trois événements différents."
          />
          <div className="history-layout">
            <div className="history-selector">
              {reminders.length ? (
                reminders.map((reminder) => (
                  <button
                    type="button"
                    className={
                      selectedReminderId === reminder.id ? 'is-active' : ''
                    }
                    key={reminder.id}
                    onClick={() => void selectHistory(reminder.id)}
                  >
                    <strong>
                      Niveau {reminder.level} · {reminder.invoiceNumber}
                    </strong>
                    <small>
                      {formatDate(reminder.scheduledDate)} ·{' '}
                      {reminderStatusLabel(reminder.status)}
                    </small>
                  </button>
                ))
              ) : (
                <EmptyState
                  title="Aucune relance"
                  text="L’historique apparaîtra après la première relance réelle."
                />
              )}
            </div>
            <div className="history-timeline">
              {selectedReminder ? (
                <header>
                  <strong>{selectedReminder.subject}</strong>
                  <StatusBadge
                    status={selectedReminder.status}
                    label={reminderStatusLabel(selectedReminder.status)}
                  />
                </header>
              ) : null}
              {history.length ? (
                history.map((item) => (
                  <article key={item.id}>
                    <span />
                    <div>
                      <strong>{reminderHistoryActionLabel(item.action)}</strong>
                      <small>{formatDate(item.occurredAt)}</small>
                      {item.note ? <p>{item.note}</p> : null}
                    </div>
                  </article>
                ))
              ) : (
                <div className="compact-empty">
                  <Clock3 size={18} />
                  <span>
                    {selectedReminderId
                      ? 'Aucune action enregistrée.'
                      : 'Choisissez une relance.'}
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {tab === 'settings' ? (
        <section
          className="panel settings-card reminder-settings-card"
          role="tabpanel"
          id="reminder-panel-settings"
          aria-labelledby="reminder-tab-settings"
        >
          <SectionHeading
            eyebrow="Fonctionnement local"
            title="Réglages des relances"
            description="Le contrôle fonctionne au démarrage, au retour dans Zentra et périodiquement tant que l’application est ouverte."
          />
          <label className="module-toggle module-toggle--compact">
            <input
              type="checkbox"
              checked={settingsDraft.enabled}
              disabled={busy || readOnly}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
            />
            <span>
              <MessageSquareWarning size={19} />
              <strong>Analyse locale active</strong>
              <small>Prépare la file, sans envoyer de message</small>
            </span>
          </label>
          <Field
            label="Nom de l’expéditeur"
            hint="Affiché dans les textes et sur le courrier imprimé."
          >
            <input
              value={settingsDraft.senderName}
              maxLength={200}
              disabled={busy || readOnly}
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  senderName: event.target.value,
                }))
              }
            />
          </Field>
          <div className="reminder-legal-note">
            <AlertTriangle size={18} />
            <div>
              <strong>Échue ne signifie pas toujours juridiquement en demeure</strong>
              <p>
                Zentra ne fixe ni frais ni intérêts automatiquement et n’engage
                jamais de poursuite. Vérifiez la base convenue de l’échéance et,
                au besoin, demandez un avis professionnel.
              </p>
            </div>
          </div>
          <Button
            disabled={busy || readOnly}
            onClick={() =>
              void perform(
                async () => {
                  await desktopApi.updateReminderSettings(settingsDraft);
                  await load();
                },
                'Les réglages ont été enregistrés localement.',
              )
            }
          >
            Enregistrer les réglages
          </Button>
        </section>
      ) : null}

      {setupOpen ? (
        <SetupWizard
          busy={busy}
          confirmed={setupConfirmed}
          readOnly={readOnly}
          sender={setupSender}
          step={setupStep}
          onClose={() => {
            setSetupOpen(false);
            setSetupStep(1);
            setSetupConfirmed(false);
          }}
          onConfirmChange={setSetupConfirmed}
          onInstall={() => void installCycle()}
          onSenderChange={setSetupSender}
          onStepChange={setSetupStep}
        />
      ) : null}

      {templateDraft ? (
        <TemplateDialog
          busy={busy}
          draft={templateDraft}
          onClose={() => setTemplateDraft(null)}
          onSave={(input) =>
            void perform(
              async () => {
                await desktopApi.upsertReminderTemplate(input);
                setTemplateDraft(null);
                await load();
              },
              'Le niveau de relance a été enregistré.',
            )
          }
        />
      ) : null}

      {templateToDelete ? (
        <Modal
          title="Supprimer ce niveau ?"
          description="Les relances déjà créées restent conservées dans l’historique."
          onClose={() => setTemplateToDelete(null)}
        >
          <p className="modal-copy">
            Le modèle « {templateToDelete.name} » ne sera plus proposé lors des
            prochains contrôles.
          </p>
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setTemplateToDelete(null)}
            >
              Conserver
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void perform(
                  async () => {
                    await desktopApi.deleteReminderTemplate(
                      templateToDelete.id,
                    );
                    setTemplateToDelete(null);
                    await load();
                  },
                  'Le niveau a été supprimé.',
                )
              }
            >
              Supprimer
            </Button>
          </div>
        </Modal>
      ) : null}

      {resolution ? (
        <Modal
          title="Clôturer sans envoi"
          description="Le motif est obligatoire afin que l’historique reste compréhensible."
          onClose={() => setResolution(null)}
        >
          <Field
            label="Motif"
            required
            hint="Exemple : accord téléphonique, litige ouvert ou plan de paiement."
          >
            <textarea
              autoFocus
              rows={5}
              minLength={3}
              maxLength={5000}
              value={resolutionNote}
              onChange={(event) => setResolutionNote(event.target.value)}
            />
          </Field>
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setResolution(null)}
            >
              Retour
            </Button>
            <Button
              variant="primary"
              disabled={busy || resolutionNote.trim().length < 3}
              onClick={() => void resolveReminder()}
            >
              Confirmer avec ce motif
            </Button>
          </div>
        </Modal>
      ) : null}

      {preview ? (
        <ReminderDeliveryPreview
          key={reminderPreviewSessionKey(
            preview.reminderId,
            preview.previewSha256,
          )}
          busy={busy}
          preview={preview}
          readOnly={readOnly}
          onClose={() => setPreview(null)}
          onRecord={(action, note) => recordPreviewAction(action, note)}
          onRefresh={refreshPreview}
        />
      ) : null}
    </div>
  );
}

function QueuePanel({
  busy,
  configured,
  readOnly,
  reminders,
  settings,
  onSetup,
  onPrepare,
  onHistory,
  onResolve,
}: {
  busy: boolean;
  configured: boolean;
  readOnly: boolean;
  reminders: Reminder[];
  settings: ReminderSettings;
  onSetup: () => void;
  onPrepare: (reminder: Reminder) => void;
  onHistory: (reminder: Reminder) => void;
  onResolve: (reminder: Reminder) => void;
}) {
  return (
    <section className="panel reminder-queue-panel">
      <SectionHeading
        eyebrow="File supervisée"
        title="Relances à vérifier"
        description="Le bouton Prévisualiser recalcule les coordonnées, le solde et la nouvelle échéance juste avant l’action."
        action={
          !configured ? (
            <Button disabled={readOnly} onClick={onSetup}>
              <Sparkles size={15} /> Configurer en 2 minutes
            </Button>
          ) : undefined
        }
      />
      {!configured ? (
        <div className="reminder-first-run">
          <div>
            <span>1</span>
            <strong>Identité</strong>
            <small>Choisissez le nom affiché.</small>
          </div>
          <ChevronRight size={18} />
          <div>
            <span>2</span>
            <strong>Cycle</strong>
            <small>Relisez trois délais conseillés.</small>
          </div>
          <ChevronRight size={18} />
          <div>
            <span>3</span>
            <strong>Activation</strong>
            <small>Rien ne part sans validation.</small>
          </div>
        </div>
      ) : reminders.length ? (
        <div className="reminder-list reminder-queue">
          {reminders.map((reminder) => {
            const balance = compareReminderBalanceSnapshot(
              reminder.balanceCents,
              reminder.liveBalanceCents,
            );
            return (
              <article key={reminder.id}>
                <header>
                  <span className="reminder-level">Niveau {reminder.level}</span>
                  <div>
                    <strong>{reminder.invoiceNumber || 'Facture'}</strong>
                    <small>
                      {reminder.clientName || 'Client'} · {reminder.subject}
                    </small>
                  </div>
                  <StatusBadge
                    status={reminder.status}
                    label={reminderStatusLabel(reminder.status)}
                  />
                </header>
                <div className="reminder-facts">
                  <span>
                    Échéance
                    <strong>{formatDate(reminder.dueDate)}</strong>
                  </span>
                  <span>
                    Relance prévue
                    <strong>{formatDate(reminder.scheduledDate)}</strong>
                  </span>
                  <span>
                    Solde actuel
                    <strong>
                      {formatMoney(
                        reminder.liveBalanceCents ?? reminder.balanceCents,
                      )}
                    </strong>
                  </span>
                </div>
                {balance.state === 'changed' ? (
                  <div className="reminder-balance-alert">
                    <RefreshCw size={15} />
                    Un paiement partiel ou un avoir a modifié le solde. L’aperçu
                    utilisera le montant actuel.
                  </div>
                ) : null}
                {balance.state === 'settled' ? (
                  <div className="reminder-balance-alert is-settled">
                    <Check size={15} /> Facture soldée : lancez le contrôle pour
                    arrêter cette relance.
                  </div>
                ) : null}
                <footer>
                  <Button
                    size="small"
                    disabled={
                      busy ||
                      balance.state === 'settled' ||
                      reminder.status !== 'due'
                    }
                    title={
                      reminder.status === 'planned'
                        ? 'Cette relance deviendra prévisualisable à sa date.'
                        : undefined
                    }
                    onClick={() => onPrepare(reminder)}
                  >
                    <Eye size={15} /> Prévisualiser
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() => onHistory(reminder)}
                  >
                    <Clock3 size={14} /> Historique
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy || readOnly}
                    onClick={() => onResolve(reminder)}
                  >
                    Clôturer sans envoi
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<CheckCircle2 />}
          title="Aucune relance à valider"
          text={
            settings.enabled
              ? 'Le dernier contrôle n’a trouvé aucune facture nécessitant une relance.'
              : 'Activez l’analyse locale dans les réglages lorsque votre cycle est prêt.'
          }
        />
      )}
    </section>
  );
}

function SetupWizard({
  busy,
  confirmed,
  readOnly,
  sender,
  step,
  onClose,
  onConfirmChange,
  onInstall,
  onSenderChange,
  onStepChange,
}: {
  busy: boolean;
  confirmed: boolean;
  readOnly: boolean;
  sender: string;
  step: number;
  onClose: () => void;
  onConfirmChange: (value: boolean) => void;
  onInstall: () => void;
  onSenderChange: (value: string) => void;
  onStepChange: (value: number) => void;
}) {
  return (
    <Modal
      title="Configurer les relances"
      description={`Étape ${step} sur 3 · vos modèles ne sont créés qu’à la dernière étape.`}
      onClose={onClose}
      wide
    >
      <div className="reminder-setup-progress" aria-label={`Étape ${step} sur 3`}>
        {[1, 2, 3].map((item) => (
          <span className={item <= step ? 'is-active' : ''} key={item} />
        ))}
      </div>
      {step === 1 ? (
        <div className="reminder-setup-step">
          <span className="reminder-setup-symbol">
            <ShieldCheck size={27} />
          </span>
          <div>
            <p className="eyebrow">Votre identité</p>
            <h3>Qui signe les rappels ?</h3>
            <p>
              Le nom est inséré dans les courriers. Les coordonnées et le logo
              proviennent de votre configuration d’entreprise.
            </p>
          </div>
          <Field label="Nom de l’expéditeur" required>
            <input
              autoFocus
              maxLength={200}
              value={sender}
              onChange={(event) => onSenderChange(event.target.value)}
              placeholder="Nom de l’entreprise ou de la personne"
            />
          </Field>
        </div>
      ) : null}
      {step === 2 ? (
        <div className="reminder-setup-step">
          <div>
            <p className="eyebrow">Cycle conseillé</p>
            <h3>Trois étapes, entièrement modifiables</h3>
            <p>
              Ces délais sont des usages pratiques, pas une obligation légale.
              Chaque courrier accordera un nouveau délai de 10 jours.
            </p>
          </div>
          <div className="reminder-cycle-preview">
            {cycleSummary.map(([level, name, delay]) => (
              <article key={level}>
                <span>{level}</span>
                <div>
                  <strong>{name}</strong>
                  <small>{delay}</small>
                </div>
                <Check size={17} />
              </article>
            ))}
          </div>
        </div>
      ) : null}
      {step === 3 ? (
        <div className="reminder-setup-step">
          <span className="reminder-setup-symbol is-amber">
            <Send size={26} />
          </span>
          <div>
            <p className="eyebrow">Dernière vérification</p>
            <h3>Préparation automatique, envoi manuel</h3>
            <p>
              Zentra analysera les échéances lorsque l’application est ouverte.
              Il ne facturera aucun frais, n’ajoutera aucun intérêt et n’enverra
              rien sans votre action.
            </p>
          </div>
          <label className="check-card reminder-confirm-card">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => onConfirmChange(event.target.checked)}
            />
            <span>
              <strong>J’ai compris le fonctionnement supervisé</strong>
              <small>Je relirai les textes avant le premier envoi réel.</small>
            </span>
          </label>
        </div>
      ) : null}
      <div className="form-actions reminder-setup-actions">
        {step > 1 ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onStepChange(step - 1)}
          >
            <ChevronLeft size={16} /> Retour
          </Button>
        ) : (
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Plus tard
          </Button>
        )}
        {step < 3 ? (
          <Button
            disabled={busy || (step === 1 && !sender.trim())}
            onClick={() => onStepChange(step + 1)}
          >
            Continuer <ChevronRight size={16} />
          </Button>
        ) : (
          <Button
            disabled={busy || readOnly || !confirmed}
            onClick={onInstall}
          >
            <Sparkles size={16} /> Installer et activer
          </Button>
        )}
      </div>
    </Modal>
  );
}

function TemplateDialog({
  busy,
  draft,
  onClose,
  onSave,
}: {
  busy: boolean;
  draft: Partial<ReminderTemplate>;
  onClose: () => void;
  onSave: (input: Omit<ReminderTemplate, 'id'> & { id?: string }) => void;
}) {
  return (
    <Modal
      title={draft.id ? 'Modifier le niveau' : 'Nouveau niveau'}
      description="Les délais actifs doivent augmenter avec le numéro du niveau."
      onClose={onClose}
      wide
    >
      <form
        className="reminder-template-form"
        onSubmit={submitForm((form) =>
          onSave({
            id: draft.id,
            level: Number(form.get('level')),
            name: String(form.get('name')),
            subject: String(form.get('subject')),
            body: String(form.get('body')),
            daysAfterDue: Number(form.get('daysAfterDue')),
            paymentDeadlineDays: Number(form.get('paymentDeadlineDays')),
            active: form.get('active') === 'on',
          }),
        )}
      >
        <div className="form-grid">
          <Field label="Niveau" required>
            <input
              name="level"
              type="number"
              min="1"
              max="10"
              defaultValue={draft.level || ''}
              required
            />
          </Field>
          <Field label="Nom" required>
            <input name="name" defaultValue={draft.name} maxLength={120} required />
          </Field>
          <Field label="Jours après l’échéance" required>
            <input
              name="daysAfterDue"
              type="number"
              min="0"
              max="3650"
              defaultValue={draft.daysAfterDue ?? ''}
              required
            />
          </Field>
          <Field label="Nouveau délai accordé" required hint="Entre 1 et 90 jours.">
            <input
              name="paymentDeadlineDays"
              type="number"
              min="1"
              max="90"
              defaultValue={draft.paymentDeadlineDays ?? 10}
              required
            />
          </Field>
          <Field
            label="Objet"
            required
            wide
            hint="Variables disponibles : {invoice_number}, {client_name}, {balance}, {due_date}, {payment_deadline}, {sender_name}."
          >
            <input
              name="subject"
              defaultValue={draft.subject}
              maxLength={300}
              required
            />
          </Field>
          <Field label="Message" required wide>
            <textarea
              name="body"
              rows={9}
              defaultValue={draft.body}
              maxLength={10000}
              required
            />
          </Field>
          <label className="check-card">
            <input
              name="active"
              type="checkbox"
              defaultChecked={draft.active ?? true}
            />
            <span>
              <strong>Niveau actif</strong>
              <small>Pris en compte par le contrôle local.</small>
            </span>
          </label>
        </div>
        <div className="form-actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={busy}>
            Enregistrer
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ReminderDeliveryPreview({
  busy,
  preview,
  readOnly,
  onClose,
  onRecord,
  onRefresh,
}: {
  busy: boolean;
  preview: ReminderPreview;
  readOnly: boolean;
  onClose: () => void;
  onRecord: (
    action: ReminderDeliveryAction,
    note?: string,
  ) => Promise<ReminderActionResult | null>;
  onRefresh: (preview: ReminderPreview) => Promise<ReminderPreview | null>;
}) {
  const [confirmation, setConfirmation] = useState<'print' | 'send' | null>(null);
  const [sendNote, setSendNote] = useState('');
  const [legacyTemplateConfirmed, setLegacyTemplateConfirmed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeActionRef = useRef(onClose);
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);
  const logoUrl = localAssetUrl(preview.sender.logoPath);
  const mailto = `mailto:${preview.recipientEmail}?subject=${encodeURIComponent(preview.subject)}&body=${encodeURIComponent(preview.body)}`;
  const legacyTemplateReady =
    !preview.templateReviewRequired || legacyTemplateConfirmed;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      if (confirmation) closeConfirmation();
      else closeActionRef.current();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusRoot = confirmation
      ? dialogRef.current?.querySelector<HTMLElement>('.reminder-delivery-confirm')
      : dialogRef.current;
    const focusable = Array.from(
      focusRoot?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? focusable.length - 1
        : currentIndex - 1
      : currentIndex === focusable.length - 1
        ? 0
        : currentIndex + 1;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  function closeConfirmation() {
    setConfirmation(null);
    window.setTimeout(() => confirmationTriggerRef.current?.focus(), 0);
  }

  async function createMailDraft() {
    const refreshed = await onRefresh(preview);
    if (!refreshed || refreshed.previewSha256 !== preview.previewSha256) return;
    const result = await onRecord('mail_draft_created');
    if (result && !result.blocked) window.location.href = mailto;
  }

  async function confirmPrint() {
    const result = await onRecord('print_confirmed', 'Impression confirmée par l’utilisateur');
    if (result && !result.blocked) closeConfirmation();
  }

  async function preparePrint() {
    const refreshed = await onRefresh(preview);
    if (!refreshed) return;
    if (refreshed.previewSha256 !== preview.previewSha256) return;
    window.print();
    setConfirmation('print');
  }

  async function prepareManualSend() {
    const refreshed = await onRefresh(preview);
    if (!refreshed || refreshed.previewSha256 !== preview.previewSha256) return;
    setConfirmation('send');
  }

  async function confirmManualSend() {
    const result = await onRecord('manual_sent', sendNote.trim());
    if (result && !result.blocked) {
      setConfirmation(null);
      setSendNote('');
    }
  }

  return (
    <div
      ref={dialogRef}
      className="print-preview reminder-delivery-preview"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reminder-preview-title"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
    >
      <div className="print-preview__toolbar">
        <div className="reminder-preview-title">
          <strong id="reminder-preview-title">Aperçu sécurisé</strong>
          <span>Solde revérifié · rien n’est envoyé automatiquement</span>
        </div>
        {!readOnly ? (
          <>
            <Button
              variant="secondary"
              disabled={busy || !!confirmation || !preview.recipientEmail || !legacyTemplateReady}
              title={
                preview.recipientEmail
                  ? undefined
                  : 'Ajoutez une adresse e-mail au client.'
              }
              onClick={(event) => {
                confirmationTriggerRef.current = event.currentTarget;
                void createMailDraft();
              }}
            >
              <Mail size={16} /> Ouvrir l’e-mail
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !!confirmation || !legacyTemplateReady}
              onClick={(event) => {
                confirmationTriggerRef.current = event.currentTarget;
                void preparePrint();
              }}
            >
              <Printer size={16} /> Imprimer
            </Button>
            <Button
              disabled={busy || !!confirmation || !legacyTemplateReady}
              onClick={(event) => {
                confirmationTriggerRef.current = event.currentTarget;
                void prepareManualSend();
              }}
            >
              <Send size={16} /> Confirmer un envoi
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          disabled={busy || !!confirmation}
          onClick={onClose}
          aria-label="Fermer l’aperçu"
        >
          <X size={18} />
        </Button>
      </div>

      {preview.snapshotStale || preview.templateReviewRequired ? (
        <div className="reminder-preview-alert" role="status">
          <RefreshCw size={16} />
          <div>
            {preview.snapshotStale ? (
              <p>
                Le solde a changé. Ce document utilise le montant actuel de{' '}
                {formatMoney(preview.currentBalanceCents)}.
              </p>
            ) : null}
            {preview.templateReviewRequired ? (
              <label>
                <input
                  type="checkbox"
                  checked={legacyTemplateConfirmed}
                  onChange={(event) =>
                    setLegacyTemplateConfirmed(event.target.checked)
                  }
                />
                Relance héritée d’une ancienne version : j’ai relu entièrement
                le texte et les coordonnées actuelles.
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      {confirmation === 'print' ? (
        <div className="reminder-delivery-confirm" role="group" aria-labelledby="confirm-print-title">
          <div>
            <strong id="confirm-print-title">L’impression s’est-elle terminée correctement ?</strong>
            <p>Elle ne sera ajoutée à l’historique qu’après votre confirmation.</p>
          </div>
          <Button autoFocus variant="secondary" disabled={busy} onClick={closeConfirmation}>
            Non
          </Button>
          <Button disabled={busy} onClick={() => void confirmPrint()}>
            Oui, confirmer
          </Button>
        </div>
      ) : null}

      {confirmation === 'send' ? (
        <div className="reminder-delivery-confirm is-send" role="group" aria-labelledby="confirm-send-title">
          <div>
            <strong id="confirm-send-title">Confirmer uniquement après l’envoi réel</strong>
            <p>Indiquez le canal ou une référence. Cette validation clôt le niveau.</p>
          </div>
          <textarea
            autoFocus
            rows={2}
            maxLength={5000}
            placeholder="Ex. e-mail envoyé depuis Outlook le 01.09.2026"
            value={sendNote}
            onChange={(event) => setSendNote(event.target.value)}
          />
          <Button variant="secondary" disabled={busy} onClick={closeConfirmation}>
            Retour
          </Button>
          <Button
            disabled={busy || sendNote.trim().length < 3}
            onClick={() => void confirmManualSend()}
          >
            Confirmer l’envoi réel
          </Button>
        </div>
      ) : null}

      <article className="print-sheet reminder-print">
        <header className="print-header reminder-print__header">
          <div className="reminder-print__brand">
            {logoUrl ? <img src={logoUrl} alt="" /> : null}
            <div>
              <strong>
                {preview.sender.company || preview.sender.name || 'Entreprise'}
                {preview.sender.legalForm
                  ? ` ${preview.sender.legalForm}`
                  : ''}
              </strong>
              <p>
                {[preview.sender.addressLine1, preview.sender.addressLine2]
                  .filter(Boolean)
                  .join(', ')}
                <br />
                {[preview.sender.postalCode, preview.sender.city]
                  .filter(Boolean)
                  .join(' ')}
              </p>
            </div>
          </div>
          <div>
            <span>RELANCE · NIVEAU {preview.level}</span>
            <h1>{preview.invoiceNumber}</h1>
            <p>Préparée le {formatDate(preview.preparedOn)}</p>
          </div>
        </header>
        <section className="print-recipient reminder-print__recipient">
          <span>DESTINATAIRE</span>
          <strong>{preview.client.name || '—'}</strong>
          <p>
            {[preview.client.addressLine1, preview.client.addressLine2]
              .filter(Boolean)
              .join(', ')}
            <br />
            {[preview.client.postalCode, preview.client.city]
              .filter(Boolean)
              .join(' ')}
          </p>
        </section>
        <div className="reminder-print__summary">
          <span>
            Facture échue le <strong>{formatDate(preview.dueDate)}</strong>
          </span>
          <span>
            Solde actuel{' '}
            <strong>
              {formatMoney(preview.currentBalanceCents)}
            </strong>
          </span>
          <span>
            Nouveau délai{' '}
            <strong>{formatDate(preview.paymentDeadlineDate)}</strong>
          </span>
        </div>
        <h2>{preview.subject}</h2>
        <div className="reminder-letter">
          {preview.body.split('\n').map((line, index) => (
            <p key={`${index}-${line}`}>{line || <br />}</p>
          ))}
        </div>
        <footer className="print-footer reminder-print__footer">
          <p>
            {preview.sender.email || preview.sender.phone
              ? [preview.sender.email, preview.sender.phone]
                  .filter(Boolean)
                  .join(' · ')
              : 'Coordonnées de l’expéditeur enregistrées dans Zentra'}
            {preview.sender.uidNumber
              ? ` · IDE ${preview.sender.uidNumber}`
              : ''}
          </p>
          <small>
            Document préparé localement. Aucun frais, intérêt ou acte de
            poursuite n’est généré par cette relance.
          </small>
        </footer>
      </article>
    </div>
  );
}

function localAssetUrl(path: string) {
  if (!path) return '';
  try {
    return convertFileSrc(path);
  } catch {
    return '';
  }
}
