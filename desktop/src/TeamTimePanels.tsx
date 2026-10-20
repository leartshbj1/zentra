import { useState } from 'react';
import { desktopApi } from './bridge';
import { localDate } from './cashBook';
import { t, useAppLanguage } from './language';
import { ijmToDeclare, vacationBalance, workingDays } from './teamTime';
import type { Absence, Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import './erp-registers.css';

const KIND_LABEL: Record<Absence['kind'], string> = {
  vacation: 'Vacances', sick: 'Maladie', accident: 'Accident', military: 'Service militaire ou civil', maternity: 'Congé maternité',
  paternity: 'Congé paternité', training: 'Formation', other: 'Autre absence',
};

function useRunner(onWorkspace: (next: Workspace) => void, fallback: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<Workspace>, after?: () => void) => {
    setBusy(true);
    setError('');
    try { onWorkspace(await action()); after?.(); } catch (reason) { setError(errorMessage(reason, t(fallback))); } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

/** Absences et vacances : soldes de l'année et arrêts maladie à déclarer à l'IJM. */
export function AbsencesPanel({ workspace, disabled, onWorkspace }: { workspace: Workspace; disabled: boolean; onWorkspace: (next: Workspace) => void }) {
  useAppLanguage();
  const today = localDate(new Date()), year = Number(today.slice(0, 4));
  const employees = workspace.employees.filter((employee) => !employee.archivedAt);
  const absences = workspace.absences ?? [], settings = workspace.leaveSettings ?? [];
  const { busy, error, setError, run } = useRunner(onWorkspace, 'L’absence n’a pas pu être enregistrée.');
  const [draft, setDraft] = useState<(Omit<Absence, 'id' | 'ijmDeclaredAt'> & { daysText: string }) | null>(null);
  const [rights, setRights] = useState<{ employeeId: string; perYear: string; carried: string } | null>(null);
  const locked = disabled || busy;
  const name = (id: string) => workspace.employees.find((employee) => employee.id === id)?.name ?? '';
  const spells = ijmToDeclare(absences, today);
  const startDraft = () => setDraft({ employeeId: employees[0]?.id ?? '', kind: 'vacation', startDate: today, endDate: today, days: 1, daysText: '1', incapacityPercent: 100, certificate: false, note: '' });
  const setDates = (patch: { startDate?: string; endDate?: string }) => setDraft((current) => {
    if (!current) return current;
    const next = { ...current, ...patch };
    const days = workingDays(next.startDate, next.endDate);
    return { ...next, days, daysText: String(days) };
  });

  return <section className="erp-register" aria-labelledby="absences-title">
    <h2 id="absences-title">{t('Absences et vacances')}</h2>
    <p>{t('Vacances, maladie, accident ou service : le solde de vacances se calcule seul, et un arrêt maladie de plus de 30 jours est signalé pour l’assurance IJM.')}</p>
    {error ? <ErrorPanel message={error} /> : null}
    {spells.map((spell) => <div key={spell.absenceIds.join('+')} className="erp-register__actions" role="status">
      <p>{t('{name} est en arrêt maladie depuis {days} jours (depuis le {date}). Déclarez-le à votre assurance perte de gain maladie (IJM) avec le certificat médical.', { name: name(spell.employeeId), days: spell.days, date: formatDate(spell.start) })}</p>
      <Button variant="secondary" disabled={locked} onClick={() => void run(() => desktopApi.markIjmDeclared(spell.absenceIds[spell.absenceIds.length - 1]))}>{t('Marquer comme déclaré')}</Button>
    </div>)}
    {employees.length ? <ul className="erp-register__list" aria-label={t('Soldes de vacances {year}', { year })}>
      {employees.map((employee) => {
        const balance = vacationBalance(employee.id, settings, absences, year);
        return <li key={employee.id}>
          <span><strong>{employee.name}</strong><small>{t('{taken} j pris sur {entitlement} j', { taken: balance.taken, entitlement: balance.entitlement })}</small></span>
          <span className="erp-register__amount"><span className={balance.remaining < 0 ? 'is-negative' : ''}>{t('{days} j restants', { days: balance.remaining })}</span></span>
          <span className="erp-register__links"><button type="button" disabled={locked} onClick={() => {
            const own = settings.find((row) => row.employeeId === employee.id);
            setRights({ employeeId: employee.id, perYear: String(own?.vacationDaysPerYear ?? 20), carried: String(own?.carriedOverDays ?? 0) });
          }}>{t('Modifier le droit annuel')}</button></span>
        </li>;
      })}
    </ul> : <p>{t('Ajoutez d’abord un collaborateur.')}</p>}
    {rights ? <div className="erp-register__form">
      <Field label={t('Jours de vacances par an')} hint={t('Minimum légal : 20 jours, 25 jusqu’à 20 ans.')}><input inputMode="decimal" value={rights.perYear} disabled={locked} onChange={(event) => setRights({ ...rights, perYear: event.target.value })} /></Field>
      <Field label={t('Report de l’an dernier (jours)')}><input inputMode="decimal" value={rights.carried} disabled={locked} onChange={(event) => setRights({ ...rights, carried: event.target.value })} /></Field>
      <div className="erp-register__actions">
        <Button disabled={locked} onClick={() => void run(() => desktopApi.saveLeaveSettings(rights.employeeId, Number(rights.perYear.replace(',', '.')) || 0, Number(rights.carried.replace(',', '.')) || 0), () => setRights(null))}>{t('Enregistrer')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setRights(null)}>{t('Annuler')}</Button>
      </div>
    </div> : null}
    {!draft ? <div className="erp-register__actions"><Button disabled={locked || !employees.length} onClick={() => { startDraft(); setError(''); }}>{t('Ajouter une absence')}</Button></div> : <div className="erp-register__form">
      <Field label={t('Collaborateur')}><select value={draft.employeeId} disabled={locked} onChange={(event) => setDraft({ ...draft, employeeId: event.target.value })}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></Field>
      <Field label={t('Motif')}><select value={draft.kind} disabled={locked} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Absence['kind'] })}>{(Object.keys(KIND_LABEL) as Absence['kind'][]).map((kind) => <option key={kind} value={kind}>{t(KIND_LABEL[kind])}</option>)}</select></Field>
      <Field label={t('Du')}><input type="date" value={draft.startDate} disabled={locked} onChange={(event) => setDates({ startDate: event.target.value })} /></Field>
      <Field label={t('Au')}><input type="date" value={draft.endDate} disabled={locked} onChange={(event) => setDates({ endDate: event.target.value })} /></Field>
      <Field label={t('Jours ouvrés')} hint={t('Demi-journée : 0.5')}><input inputMode="decimal" value={draft.daysText} disabled={locked} onChange={(event) => setDraft({ ...draft, daysText: event.target.value })} /></Field>
      {draft.kind === 'sick' || draft.kind === 'accident' ? <Field label={t('Incapacité (%)')}><input inputMode="numeric" value={String(draft.incapacityPercent)} disabled={locked} onChange={(event) => setDraft({ ...draft, incapacityPercent: Math.min(100, Math.max(1, Number(event.target.value.replace(/\D/g, '')) || 100)) })} /></Field> : null}
      {draft.kind === 'sick' || draft.kind === 'accident' ? <label className="erp-register__switch erp-register__wide"><input type="checkbox" role="switch" aria-checked={draft.certificate} checked={draft.certificate} disabled={locked} onChange={(event) => setDraft({ ...draft, certificate: event.target.checked })} /><span>{t('Certificat médical reçu')}</span></label> : null}
      <div className="erp-register__actions">
        <Button disabled={locked || !draft.employeeId} onClick={() => {
          const days = Number(draft.daysText.replace(',', '.'));
          if (!(days > 0)) { setError(t('Indiquez le nombre de jours ouvrés.')); return; }
          void run(() => desktopApi.saveAbsence({ ...draft, days }), () => setDraft(null));
        }}>{busy ? t('Enregistrement…') : t('Enregistrer l’absence')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
      </div>
    </div>}
    {absences.length ? <ul className="erp-register__list" aria-label={t('Absences enregistrées')}>
      {[...absences].sort((a, b) => b.startDate.localeCompare(a.startDate)).slice(0, 60).map((row) => <li key={row.id}>
        <span><strong>{name(row.employeeId)} · {t(KIND_LABEL[row.kind])}</strong><small>{formatDate(row.startDate)} – {formatDate(row.endDate)}{row.ijmDeclaredAt ? ` · ${t('déclaré à l’IJM')}` : ''}</small></span>
        <span className="erp-register__amount">{t('{days} j', { days: row.days })}</span>
        {!row.ijmDeclaredAt ? <span className="erp-register__links"><button type="button" disabled={locked} onClick={() => { if (window.confirm(t('Supprimer cette absence ?'))) void run(() => desktopApi.deleteAbsence(row.id)); }}>{t('Supprimer')}</button></span> : null}
      </li>)}
    </ul> : null}
  </section>;
}

/** Notes de frais : saisie avec justificatif, validation, puis remboursement avec le salaire. */
export function ExpenseClaimsPanel({ workspace, disabled, onWorkspace }: { workspace: Workspace; disabled: boolean; onWorkspace: (next: Workspace) => void }) {
  useAppLanguage();
  const today = localDate(new Date());
  const employees = workspace.employees.filter((employee) => !employee.archivedAt);
  const claims = [...(workspace.expenseClaims ?? [])].sort((a, b) => b.claimDate.localeCompare(a.claimDate));
  const { busy, error, setError, run } = useRunner(onWorkspace, 'La note de frais n’a pas pu être enregistrée.');
  const [draft, setDraft] = useState<{ employeeId: string; claimDate: string; category: string; description: string; amount: string; receipt: File | null } | null>(null);
  const locked = disabled || busy;
  const name = (id: string) => workspace.employees.find((employee) => employee.id === id)?.name ?? '';
  const status: Record<string, string> = { submitted: 'À valider', approved: 'Validée · remboursée avec le prochain salaire', rejected: 'Refusée', reimbursed: 'Remboursée avec le salaire' };
  const draftPayslip = (employeeId: string) => workspace.payslips.find((slip) => slip.employeeId === employeeId && (slip.status === 'draft' || slip.status === 'incomplete'));

  return <section className="erp-register" aria-labelledby="claims-title">
    <h2 id="claims-title">{t('Notes de frais')}</h2>
    <p>{t('Photographiez le ticket, saisissez le montant ; après validation, il est remboursé avec le salaire, sans cotisations.')}</p>
    {error ? <ErrorPanel message={error} /> : null}
    {!draft ? <div className="erp-register__actions"><Button disabled={locked || !employees.length} onClick={() => { setDraft({ employeeId: employees[0]?.id ?? '', claimDate: today, category: 'Repas', description: '', amount: '', receipt: null }); setError(''); }}>{t('Ajouter une note de frais')}</Button></div> : <div className="erp-register__form">
      <Field label={t('Collaborateur')}><select value={draft.employeeId} disabled={locked} onChange={(event) => setDraft({ ...draft, employeeId: event.target.value })}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></Field>
      <Field label={t('Date')}><input type="date" value={draft.claimDate} max={today} disabled={locked} onChange={(event) => setDraft({ ...draft, claimDate: event.target.value })} /></Field>
      <Field label={t('Catégorie')}><select value={draft.category} disabled={locked} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>{['Repas', 'Transport', 'Hébergement', 'Matériel', 'Autre'].map((value) => <option key={value} value={value}>{t(value)}</option>)}</select></Field>
      <Field label={t('Montant (CHF)')}><input inputMode="decimal" placeholder="0.00" value={draft.amount} disabled={locked} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></Field>
      <div className="erp-register__wide"><Field label={t('Description')}><input value={draft.description} maxLength={500} disabled={locked} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field></div>
      <div className="erp-register__wide"><Field label={t('Justificatif')} hint={t('Photo ou PDF du ticket.')}><input type="file" accept="image/*,application/pdf" capture="environment" disabled={locked} onChange={(event) => setDraft({ ...draft, receipt: event.target.files?.[0] ?? null })} /></Field></div>
      <div className="erp-register__actions">
        <Button disabled={locked || !draft.employeeId || !draft.description.trim()} onClick={() => {
          const match = /^\s*(\d{1,6})(?:[.,](\d{1,2}))?\s*$/.exec(draft.amount);
          const cents = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : 0;
          if (!cents) { setError(t('Saisissez un montant positif.')); return; }
          void run(() => desktopApi.addExpenseClaim({ ...draft, amountCents: cents }), () => setDraft(null));
        }}>{busy ? t('Enregistrement…') : t('Enregistrer la note de frais')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
      </div>
    </div>}
    {claims.length ? <ul className="erp-register__list">
      {claims.slice(0, 100).map((claim) => {
        const payslip = claim.status === 'approved' ? draftPayslip(claim.employeeId) : undefined;
        return <li key={claim.id}>
          <span><strong>{name(claim.employeeId)} · {claim.description}</strong><small>{formatDate(claim.claimDate)} · {t(claim.category)} · {t(status[claim.status])}{claim.attachmentId ? ` · ${t('justificatif joint')}` : ''}</small></span>
          <span className="erp-register__amount">{formatMoney(claim.amountCents)}</span>
          <span className="erp-register__links">
            {claim.status === 'submitted' || claim.status === 'rejected' ? <button type="button" disabled={locked} onClick={() => void run(() => desktopApi.decideExpenseClaim(claim.id, true))}>{t('Valider')}</button> : null}
            {claim.status === 'submitted' ? <button type="button" disabled={locked} onClick={() => { const note = window.prompt(t('Motif du refus (facultatif)')) ?? undefined; void run(() => desktopApi.decideExpenseClaim(claim.id, false, note)); }}>{t('Refuser')}</button> : null}
            {payslip ? <button type="button" disabled={locked} onClick={() => void run(async () => (await desktopApi.addApprovedClaimsToPayslip(payslip.id)).workspace)}>{t('Ajouter à la fiche de {period}', { period: payslip.period })}</button> : null}
            {claim.status === 'submitted' || claim.status === 'rejected' ? <button type="button" disabled={locked} onClick={() => { if (window.confirm(t('Supprimer cette note de frais ?'))) void run(() => desktopApi.deleteExpenseClaim(claim.id)); }}>{t('Supprimer')}</button> : null}
          </span>
        </li>;
      })}
    </ul> : !draft ? <p>{t('Aucune note de frais pour l’instant.')}</p> : null}
  </section>;
}
