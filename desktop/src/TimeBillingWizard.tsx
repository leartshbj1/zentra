import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileText,
  ShieldCheck,
} from 'lucide-react';
import { desktopApi } from './bridge';
import './work-time-forms.css';
import {
  readyTimeEntries,
  summarizeTimeBilling,
  timeEntryNetCents,
} from './timeBilling';
import type { Workspace } from './types';
import { errorMessage, formatDate, formatMinutes, formatMoney } from './utils';
import {
  Button,
  EmptyState,
  Field,
  FormActions,
  Modal,
  submitForm,
} from './ui';

type ActionRunner = (
  action: () => Promise<Workspace>,
  message: string,
  close?: boolean,
  onError?: (reason: unknown) => void,
) => Promise<boolean>;

export function TimeBillingWizard({
  workspace,
  busy,
  close,
  act,
  onCreated,
}: {
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
  onCreated: () => void;
}) {
  const eligible = useMemo(() => readyTimeEntries(workspace), [workspace]);
  const projects = useMemo(
    () =>
      workspace.projects
        .filter(
          (project) =>
            Boolean(project.clientId) &&
            eligible.some((entry) => entry.projectId === project.id),
        )
        .sort((left, right) => left.name.localeCompare(right.name, 'fr-CH')),
    [eligible, workspace.projects],
  );
  const [requestId] = useState(() => crypto.randomUUID());
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const projectEntries = useMemo(
    () => eligible.filter((entry) => entry.projectId === projectId),
    [eligible, projectId],
  );
  const [selections, setSelections] = useState<Record<string, string[]>>(() => ({ [projects[0]?.id ?? '']: eligible.filter(entry => entry.projectId === projects[0]?.id).map(entry => entry.id) }));
  const selectedIds = selections[projectId] ?? [];
  const setSelectedIds = (ids: string[] | ((current: string[]) => string[])) => setSelections(current => ({ ...current, [projectId]: typeof ids === 'function' ? ids(current[projectId] ?? []) : ids }));
  const [saveError, setSaveError] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const locked = busy || saving;
  useEffect(() => {
    if (saveError && !locked && errorRef.current) {
      errorRef.current.focus(); errorRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [saveError, locked]);
  const vatRates = workspace.settings!.organization.vatRegistered
    ? workspace.settings!.billing.vatRatesBp.filter((rate) => rate > 0)
    : [0];
  const [selectedVatBp, setVatBp] = useState(vatRates[0] ?? 0);
  const vatBp = workspace.settings!.organization.vatRegistered ? selectedVatBp : 0;

  const selectedEntries = projectEntries.filter((entry) =>
    selectedIds.includes(entry.id),
  );
  const summary = summarizeTimeBilling(selectedEntries, vatBp);
  const project = projects.find(
    (candidate) => candidate.id === projectId,
  );
  const client = workspace.clients.find(
    (candidate) => candidate.id === project?.clientId,
  );
  const savedBatch = workspace.timeBillingBatches.find(batch => batch.requestId === requestId);
  const allSelected = projectEntries.length > 0 && projectEntries.every(entry => selectedIds.includes(entry.id));

  function toggleEntry(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : [...current, id],
    );
  }

  return (
    <Modal
      title="Facturer les heures"
      description="Choisissez les heures à inclure. Vous pourrez vérifier la facture avant de l’émettre."
      onClose={close}
      dismissible={!locked}
      className="time-billing-modal"
      wide
    >
      {savedBatch ? <div className="stack-layout" role="status"><h3>La facture brouillon a été créée</h3><p>Les heures sont réservées dans cette facture. Vous pouvez la retrouver et la vérifier avant de l’émettre.</p><Button onClick={onCreated} disabled={locked}>Ouvrir les factures</Button></div> : !projects.length ? (
        <EmptyState
          icon={<Clock3 />}
          title="Aucune heure prête à facturer"
          text="Une heure doit être approuvée, marquée facturable, avoir un tarif positif et appartenir à un projet lié à un client."
        />
      ) : (
        <form
          onSubmit={submitForm(async (form) => {
            if (locked || inFlight.current || !selectedEntries.length || !project || !client || !vatRates.includes(vatBp))
              return;
            inFlight.current = true; setSaving(true); setSaveError('');
            try {
            const created = await act(
              () =>
                desktopApi.createInvoiceFromTimeEntries({
                  requestId,
                  projectId,
                  timeEntryIds: selectedEntries.map((entry) => entry.id),
                  title: String(form.get('title')),
                  vatBp,
                  notes: String(form.get('notes')),
                }),
              'La facture brouillon a été créée. Les heures sélectionnées y sont réservées sans double facturation.',
              true,
              reason => setSaveError(errorMessage(reason, 'La facture n’a pas pu être créée. Votre sélection est conservée.')),
            );
            if (created) onCreated();
            else setSaveError(current => current || 'La création n’est pas disponible pour le moment. Votre sélection est conservée.');
            } catch (reason) { setSaveError(errorMessage(reason, 'La création a été interrompue. Votre sélection est conservée.')); }
            finally { inFlight.current = false; setSaving(false); }
          })}
        >
          {saveError && <div ref={errorRef} tabIndex={-1} className="warning-card" role="alert"><div><strong>La facture n’a pas pu être créée</strong><p>{saveError}</p><p>Vérifiez les informations puis réessayez. Les heures décochées le restent.</p></div></div>}
          <fieldset className="work-time-fields" disabled={locked}>
          <div className="form-grid time-billing-config">
            <Field label="Projet à facturer" required wide>
              <select
                value={project ? projectId : ''}
                onChange={(event) => {
                  const next = event.target.value;
                  setSelections(current => next in current ? current : { ...current, [next]: eligible.filter(entry => entry.projectId === next).map(entry => entry.id) });
                  setProjectId(next);
                }}
                required
                autoFocus
              >
                {!project && <option value="">Choisir un projet disponible</option>}
                {projects.map((candidate) => (
                  <option value={candidate.id} key={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Client">
              <input
                value={client?.company || client?.name || ''}
                readOnly
                aria-readonly="true"
              />
            </Field>
            <Field label="TVA" required>
              <select
                value={vatRates.includes(vatBp) ? vatBp : ''}
                onChange={(event) => setVatBp(Number(event.target.value))}
                required
                disabled={!workspace.settings!.organization.vatRegistered}
              >
                {!vatRates.includes(vatBp) && <option value="">Choisir un taux disponible</option>}
                {vatRates.map((rate) => (
                  <option value={rate} key={rate}>
                    {(rate / 100).toLocaleString('fr-CH', {
                      maximumFractionDigits: 2,
                    })}{' '}
                    %
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Titre de la facture"
              wide
              hint="Facultatif : un titre lié au projet sera créé automatiquement."
            >
              <input
                name="title"
                value={title}
                onChange={event => setTitle(event.target.value)}
                maxLength={200}
                placeholder={`Heures — ${project?.name ?? ''}`}
              />
            </Field>
          </div>

          {!vatRates.length ? (
            <div className="warning-card" role="alert">
              <ShieldCheck size={18} />
              <div>
                <strong>Taux de TVA manquant</strong>
                <p>
                  Ajoutez au moins un taux positif dans Paramètres avant de
                  facturer ces heures.
                </p>
              </div>
            </div>
          ) : null}

          <section
            className="time-billing-selection"
            aria-labelledby="time-billing-selection-title"
          >
            <header>
              <div>
                <strong id="time-billing-selection-title">Heures prêtes</strong>
                <small>
                  {selectedEntries.length} sur {projectEntries.length}{' '}
                  sélectionnée(s)
                </small>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="small"
                onClick={() =>
                  setSelectedIds(
                    allSelected
                      ? []
                      : projectEntries.map((entry) => entry.id),
                  )
                }
              >
                {allSelected
                  ? 'Tout désélectionner'
                  : 'Tout sélectionner'}
              </Button>
            </header>
            <div className="time-billing-list">
              {projectEntries.map((entry) => {
                const employee = workspace.employees.find(
                  (candidate) => candidate.id === entry.employeeId,
                );
                const checked = selectedIds.includes(entry.id);
                return (
                  <label
                    className={checked ? 'is-selected' : ''}
                    key={entry.id}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleEntry(entry.id)}
                    />
                    <span className="time-billing-list__check">
                      <CheckCircle2 size={16} />
                    </span>
                    <span>
                      <strong>
                        {formatDate(entry.date)} ·{' '}
                        {employee?.name || 'Collaborateur'}
                      </strong>
                      <small>{entry.note || 'Aucune note de prestation'}</small>
                    </span>
                    <span>
                      <strong>{formatMinutes(entry.minutes)}</strong>
                      <small>
                        {formatMoney(entry.billingRateCents ?? 0)} / h
                      </small>
                    </span>
                    <strong>{formatMoney(timeEntryNetCents(entry))}</strong>
                  </label>
                );
              })}
            </div>
          </section>

          <div className="time-billing-summary" aria-live="polite">
            <div>
              <span>Période</span>
              <strong>
                {summary.dateFrom
                  ? `${formatDate(summary.dateFrom)} → ${formatDate(summary.dateTo)}`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>Temps</span>
              <strong>
                {summary.minutes ? formatMinutes(summary.minutes) : '—'}
              </strong>
            </div>
            <div>
              <span>Net</span>
              <strong>{formatMoney(summary.netCents)}</strong>
            </div>
            <div>
              <span>TVA</span>
              <strong>{formatMoney(summary.vatCents)}</strong>
            </div>
            <div>
              <span>Total TTC</span>
              <strong>{formatMoney(summary.totalCents)}</strong>
            </div>
          </div>

          <Field label="Note sur la facture" wide>
            <textarea name="notes" rows={2} maxLength={5000} value={notes} onChange={event => setNotes(event.target.value)} />
          </Field>
          </fieldset>
          <div className="info-strip">
            <FileText size={17} />
            <span>
              La facture reste modifiable et sans numéro jusqu’à son émission.
              Supprimer ce brouillon libérera les heures.
            </span>
          </div>
          <FormActions
            onCancel={close}
            busy={locked}
            disabled={!selectedEntries.length || !project || !client || !vatRates.includes(vatBp)}
            submitLabel="Créer la facture brouillon"
          />
          <div className="time-billing-next" aria-hidden="true">
            <ArrowRight size={15} /> Contrôle puis émission dans Factures
          </div>
        </form>
      )}
    </Modal>
  );
}
