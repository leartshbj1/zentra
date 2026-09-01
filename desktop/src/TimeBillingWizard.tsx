import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileText,
  ShieldCheck,
} from 'lucide-react';
import { desktopApi } from './bridge';
import {
  eligibleTimeEntries,
  summarizeTimeBilling,
  timeEntryNetCents,
} from './timeBilling';
import type { Workspace } from './types';
import { formatDate, formatMinutes, formatMoney } from './utils';
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
  const eligible = useMemo(() => eligibleTimeEntries(workspace), [workspace]);
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
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const vatRates = workspace.settings!.organization.vatRegistered
    ? workspace.settings!.billing.vatRatesBp.filter((rate) => rate > 0)
    : [0];
  const [vatBp, setVatBp] = useState(vatRates[0] ?? 0);

  useEffect(() => {
    setSelectedIds(projectEntries.map((entry) => entry.id));
  }, [projectEntries]);

  const selectedEntries = projectEntries.filter((entry) =>
    selectedIds.includes(entry.id),
  );
  const summary = summarizeTimeBilling(selectedEntries, vatBp);
  const project = workspace.projects.find(
    (candidate) => candidate.id === projectId,
  );
  const client = workspace.clients.find(
    (candidate) => candidate.id === project?.clientId,
  );

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
      description="Choisissez les heures approuvées. Zentra crée une facture brouillon et réserve chaque saisie pour empêcher toute double facturation."
      onClose={close}
      wide
    >
      {!projects.length ? (
        <EmptyState
          icon={<Clock3 />}
          title="Aucune heure prête à facturer"
          text="Une heure doit être approuvée, marquée facturable, avoir un tarif positif et appartenir à un projet lié à un client."
        />
      ) : (
        <form
          onSubmit={submitForm(async (form) => {
            if (!selectedEntries.length || !projectId || !vatRates.length)
              return;
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
            );
            if (created) onCreated();
          })}
        >
          <div className="form-grid time-billing-config">
            <Field label="Projet à facturer" required wide>
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                required
                autoFocus
              >
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
                value={vatBp}
                onChange={(event) => setVatBp(Number(event.target.value))}
                required
                disabled={!workspace.settings!.organization.vatRegistered}
              >
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
                    selectedIds.length === projectEntries.length
                      ? []
                      : projectEntries.map((entry) => entry.id),
                  )
                }
              >
                {selectedIds.length === projectEntries.length
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
            <textarea name="notes" rows={2} maxLength={5000} />
          </Field>
          <div className="info-strip">
            <FileText size={17} />
            <span>
              La facture reste modifiable et sans numéro jusqu’à son émission.
              Supprimer ce brouillon libérera les heures.
            </span>
          </div>
          <FormActions
            onCancel={close}
            busy={busy}
            disabled={!selectedEntries.length || !vatRates.length}
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
