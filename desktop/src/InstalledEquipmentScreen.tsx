import { useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { localDate } from './cashBook';
import { clientLabel, daysBetween, equipmentLabel, lastService, nextServiceDue, plannedService, suggestedServiceSlot, type InstalledEquipment } from './installedEquipment';
import { t, useAppLanguage } from './language';
import type { Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage, formatDate } from './utils';
import './erp-registers.css';
import './terrain.css';

type Draft = Omit<InstalledEquipment, 'archivedAt' | 'createdAt' | 'updatedAt' | 'serviceIntervalMonths'> & { intervalText: string; archived: boolean };
type Planning = { equipmentId: string; date: string; startTime: string; endTime: string; employeeId: string };

const emptyDraft = (clientId: string): Draft => ({ id: '', clientId, projectId: null, kind: '', brand: '', model: '', serialNumber: '', installedOn: null, warrantyUntil: null,
  location: '', intervalText: '12', lastServiceOn: null, notes: '', archived: false });

/** Titre du rendez-vous d'entretien, repris tel quel dans l'agenda et le planning. */
export function serviceTitle(item: InstalledEquipment, client: string) {
  return t('Entretien · {equipment} · {client}', { equipment: equipmentLabel(item), client });
}

/** Parc installé : ce qui a été posé chez chaque client, la garantie et le prochain entretien. */
export function InstalledEquipmentScreen({ workspace, readOnly, onWorkspace, onOpenPlanning }: { workspace: Workspace; readOnly: boolean; onWorkspace: (next: Workspace) => void; onOpenPlanning: () => void }) {
  useAppLanguage();
  const today = localDate(new Date());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = readOnly || busy;
  const clients = workspace.clients.filter(client => !client.archivedAt);
  const services = workspace.equipmentServices ?? [];
  const employees = workspace.employees.filter(employee => !employee.employmentEnd || employee.employmentEnd >= today);
  const clientName = (id: string) => clientLabel(workspace.clients.find(client => client.id === id));
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (workspace.installedEquipment ?? [])
      .filter(item => showArchived || !item.archivedAt)
      .filter(item => !needle || [item.kind, item.brand, item.model, item.serialNumber, item.location, clientName(item.clientId)].join(' ').toLocaleLowerCase().includes(needle))
      .map(item => ({ item, due: nextServiceDue(item, services), planned: plannedService(item, services, workspace.agendaEvents) }))
      .sort((left, right) => (left.due ?? '9999').localeCompare(right.due ?? '9999') || clientName(left.item.clientId).localeCompare(clientName(right.item.clientId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.installedEquipment, workspace.equipmentServices, workspace.agendaEvents, workspace.clients, query, showArchived]);

  async function run<T>(action: () => Promise<T>, after?: (value: T) => void) {
    setBusy(true);
    setError('');
    try {
      after?.(await action());
    } catch (reason) {
      setError(errorMessage(reason, t('L’équipement n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;
    const interval = draft.intervalText.trim() ? Number(draft.intervalText) : null;
    if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 120)) { setError(t('L’intervalle d’entretien va de 1 à 120 mois.')); return; }
    const { intervalText: _interval, ...rest } = draft;
    void run(() => desktopApi.saveInstalledEquipment({ ...rest, id: draft.id || null, serviceIntervalMonths: interval }), result => { onWorkspace(result.workspace); setDraft(null); });
  }

  function startPlanning(item: InstalledEquipment) {
    const due = nextServiceDue(item, services) ?? today;
    const slot = suggestedServiceSlot(due, today, workspace.agendaEvents);
    setPlanning({ equipmentId: item.id, ...slot, employeeId: '' });
    setError('');
  }

  function confirmPlanning(item: InstalledEquipment) {
    if (!planning) return;
    void run(() => desktopApi.planEquipmentService({ equipmentId: item.id, date: planning.date, startTime: planning.startTime, endTime: planning.endTime,
      employeeId: planning.employeeId || null, title: serviceTitle(item, clientName(item.clientId)) }), result => { onWorkspace(result.workspace); setPlanning(null); });
  }

  const status = (item: InstalledEquipment, due: string | null, planned: ReturnType<typeof plannedService>) => {
    if (item.archivedAt) return t('Archivé');
    if (planned) return t('Entretien planifié le {date} à {time}', { date: formatDate(planned.event.startDate), time: planned.event.startTime ?? '' });
    if (!item.serviceIntervalMonths) return t('Sans entretien périodique');
    if (!due) return t('Indiquez la date de pose ou du dernier entretien');
    const days = daysBetween(today, due);
    if (days < 0) return t('Entretien en retard depuis le {date}', { date: formatDate(due) });
    return t('Prochain entretien le {date}', { date: formatDate(due) });
  };

  return <section className="erp-register terrain-equipment" aria-labelledby="equipment-title">
    <h2 id="equipment-title" className="sr-only">{t('Parc installé')}</h2>
    <p>{t('Ce que vous avez posé chez vos clients, avec la garantie et l’entretien. Autopilote vous propose l’entretien 30 jours avant l’échéance.')}</p>
    {error ? <ErrorPanel message={error} /> : null}
    {!draft ? <div className="erp-register__actions">
      <Button disabled={locked || !clients.length} onClick={() => { setDraft(emptyDraft(clients[0]?.id ?? '')); setPlanning(null); setError(''); }}>{t('Ajouter un équipement')}</Button>
      {!clients.length ? <p>{t('Ajoutez d’abord un client.')}</p> : null}
    </div> : <div className="erp-register__form">
      <Field label={t('Client')}>
        <select value={draft.clientId} disabled={locked} onChange={event => setDraft({ ...draft, clientId: event.target.value })}>
          {clients.map(client => <option key={client.id} value={client.id}>{clientLabel(client)}</option>)}
        </select>
      </Field>
      <Field label={t('Type')} hint={t('Par exemple : chaudière, pompe à chaleur, porte de garage')}><input value={draft.kind} maxLength={120} disabled={locked} onChange={event => setDraft({ ...draft, kind: event.target.value })} /></Field>
      <Field label={t('Marque')}><input value={draft.brand} maxLength={120} disabled={locked} onChange={event => setDraft({ ...draft, brand: event.target.value })} /></Field>
      <Field label={t('Modèle')}><input value={draft.model} maxLength={120} disabled={locked} onChange={event => setDraft({ ...draft, model: event.target.value })} /></Field>
      <Field label={t('Numéro de série')}><input value={draft.serialNumber} maxLength={120} disabled={locked} onChange={event => setDraft({ ...draft, serialNumber: event.target.value })} /></Field>
      <Field label={t('Lieu')} hint={t('Adresse et emplacement, par exemple « Sous-sol »')}><input value={draft.location} maxLength={300} disabled={locked} onChange={event => setDraft({ ...draft, location: event.target.value })} /></Field>
      <Field label={t('Date de pose')}><input type="date" value={draft.installedOn ?? ''} disabled={locked} onChange={event => setDraft({ ...draft, installedOn: event.target.value || null })} /></Field>
      <Field label={t('Fin de garantie')}><input type="date" value={draft.warrantyUntil ?? ''} disabled={locked} onChange={event => setDraft({ ...draft, warrantyUntil: event.target.value || null })} /></Field>
      <Field label={t('Entretien tous les (mois)')} hint={t('Laissez vide sans entretien périodique')}><input inputMode="numeric" value={draft.intervalText} disabled={locked} onChange={event => setDraft({ ...draft, intervalText: event.target.value })} /></Field>
      <Field label={t('Dernier entretien')}><input type="date" value={draft.lastServiceOn ?? ''} disabled={locked} onChange={event => setDraft({ ...draft, lastServiceOn: event.target.value || null })} /></Field>
      <div className="erp-register__wide"><Field label={t('Notes')}><textarea rows={2} value={draft.notes} maxLength={4000} disabled={locked} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></Field></div>
      <div className="erp-register__actions">
        <Button disabled={locked || !draft.clientId || !draft.kind.trim()} onClick={save}>{busy ? t('Enregistrement…') : t('Enregistrer')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
      </div>
    </div>}
    {(workspace.installedEquipment ?? []).length ? <div className="terrain-equipment__filters">
      <input type="search" value={query} placeholder={t('Rechercher un client, un modèle, un numéro de série')} aria-label={t('Rechercher dans le parc installé')} onChange={event => setQuery(event.target.value)} />
      <label className="terrain-equipment__toggle"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} /><span>{t('Afficher les archivés')}</span></label>
    </div> : null}
    {rows.length ? <ul className="erp-register__list">
      {rows.map(({ item, due, planned }) => {
        const last = lastService(item, services);
        const warranty = item.warrantyUntil ? (item.warrantyUntil >= today ? t('Garantie jusqu’au {date}', { date: formatDate(item.warrantyUntil) }) : t('Garantie terminée le {date}', { date: formatDate(item.warrantyUntil) })) : '';
        const isPlanning = planning?.equipmentId === item.id;
        return <li key={item.id}>
          <span>
            <strong>{equipmentLabel(item)}</strong>
            <small>{[clientName(item.clientId), item.location].filter(Boolean).join(' · ')}</small>
            <small>{[item.serialNumber ? t('N° {serial}', { serial: item.serialNumber }) : '', item.installedOn ? t('Posé le {date}', { date: formatDate(item.installedOn) }) : '', warranty].filter(Boolean).join(' · ')}</small>
          </span>
          <span className="erp-register__amount terrain-equipment__due">
            <span>{status(item, due, planned)}</span>
            {due && !planned && !item.archivedAt && daysBetween(today, due) >= 0 && daysBetween(today, due) <= 30 ? <small>{t('Dans {n} jours', { n: daysBetween(today, due) })}</small>
              : last && item.serviceIntervalMonths ? <small>{t('Dernier entretien le {date}', { date: formatDate(last) })}</small> : null}
          </span>
          {isPlanning && planning ? <span className="erp-register__wide terrain-equipment__plan">
            <Field label={t('Date')}><input type="date" value={planning.date} disabled={locked} onChange={event => setPlanning({ ...planning, date: event.target.value })} /></Field>
            <Field label={t('Début')}><input type="time" value={planning.startTime} disabled={locked} onChange={event => setPlanning({ ...planning, startTime: event.target.value })} /></Field>
            <Field label={t('Fin')}><input type="time" value={planning.endTime} disabled={locked} onChange={event => setPlanning({ ...planning, endTime: event.target.value })} /></Field>
            <Field label={t('Collaborateur')}>
              <select value={planning.employeeId} disabled={locked} onChange={event => setPlanning({ ...planning, employeeId: event.target.value })}>
                <option value="">{t('À attribuer')}</option>
                {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
              </select>
            </Field>
            <span className="erp-register__actions">
              <Button disabled={locked || !planning.date || !planning.startTime || planning.endTime <= planning.startTime} onClick={() => confirmPlanning(item)}>{t('Planifier')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setPlanning(null)}>{t('Annuler')}</Button>
            </span>
          </span> : null}
          <span className="erp-register__links">
            {!item.archivedAt && item.serviceIntervalMonths && !planned && !isPlanning ? <button type="button" disabled={locked} onClick={() => startPlanning(item)}>{t('Planifier l’entretien')}</button> : null}
            {planned ? <>
              <button type="button" disabled={locked} onClick={() => void run(() => desktopApi.completeEquipmentService(item.id, planned.id, planned.event.startDate <= today ? planned.event.startDate : today, ''), onWorkspace)}>{t('Entretien fait')}</button>
              <button type="button" onClick={onOpenPlanning}>{t('Voir dans le planning')}</button>
              <button type="button" disabled={locked} onClick={() => void run(() => desktopApi.cancelEquipmentService(planned.id), onWorkspace)}>{t('Annuler le rendez-vous')}</button>
            </> : !item.archivedAt && item.serviceIntervalMonths ? <button type="button" disabled={locked} onClick={() => void run(() => desktopApi.completeEquipmentService(item.id, null, today, ''), onWorkspace)}>{t('Entretien fait aujourd’hui')}</button> : null}
            <button type="button" disabled={locked} onClick={() => { setDraft({ ...item, intervalText: item.serviceIntervalMonths ? String(item.serviceIntervalMonths) : '', archived: Boolean(item.archivedAt) }); setPlanning(null); setError(''); }}>{t('Modifier')}</button>
            <button type="button" disabled={locked} onClick={() => void run(() => desktopApi.saveInstalledEquipment({ ...item, archived: !item.archivedAt }), result => onWorkspace(result.workspace))}>{item.archivedAt ? t('Réactiver') : t('Archiver')}</button>
          </span>
        </li>;
      })}
    </ul> : !draft ? <p>{(workspace.installedEquipment ?? []).length ? t('Aucun équipement ne correspond à la recherche.') : t('Aucun équipement pour l’instant.')}</p> : null}
  </section>;
}
