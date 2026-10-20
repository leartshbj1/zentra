import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { localDate } from './cashBook';
import { currentEnd, nextDecision } from './contracts';
import { t, useAppLanguage } from './language';
import type { Contract, Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import './erp-registers.css';

type Draft = Omit<Contract, 'id' | 'status' | 'terminatedOn'> & { id?: string; amountText: string };
const FREQUENCIES: readonly [Contract['frequency'], string][] = [['monthly', 'par mois'], ['quarterly', 'par trimestre'], ['yearly', 'par an'], ['once', 'une fois']];

const centsFromText = (value: string) => {
  if (!value.trim()) return 0;
  const match = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*$/.exec(value.replace(/['’\s]/g, ''));
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
};

function empty(side: Contract['side'], today: string): Draft {
  return { side, clientId: null, supplierId: null, partyName: '', title: '', startDate: today, endDate: null, noticeMonths: 3, autoRenew: true, renewalMonths: 12, amountCents: 0, currency: 'CHF', frequency: 'monthly', indexation: '', note: '', amountText: '' };
}

/** Contrats et abonnements d'un côté (clients ou fournisseurs) : échéances et préavis. */
export function ContractsPanel({ side, workspace, disabled, onWorkspace, focusId, onFocusHandled }: { side: Contract['side']; workspace: Workspace; disabled: boolean; onWorkspace: (next: Workspace) => void; focusId?: string | null; onFocusHandled?: () => void }) {
  useAppLanguage();
  const today = localDate(new Date());
  const contracts = (workspace.contracts ?? []).filter((row) => row.side === side);
  const parties = side === 'customer' ? workspace.clients.filter((row) => !row.archivedAt).map((row) => ({ id: row.id, name: row.name })) : workspace.suppliers.filter((row) => !row.archivedAt).map((row) => ({ id: row.id, name: row.name }));
  const focused = focusId ? contracts.find((row) => row.id === focusId) : undefined;
  const [draft, setDraft] = useState<Draft | null>(focused ? { ...focused, amountText: (focused.amountCents / 100).toFixed(2) } : null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = disabled || busy;
  // The contract opened from an Autopilote card is read once, then released.
  useEffect(() => { if (focusId) onFocusHandled?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(action: () => Promise<Workspace>, after?: () => void) {
    setBusy(true);
    setError('');
    try {
      onWorkspace(await action());
      after?.();
    } catch (reason) {
      setError(errorMessage(reason, t('Le contrat n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;
    const amountCents = centsFromText(draft.amountText);
    if (amountCents === null) { setError(t('Saisissez un montant valide.')); return; }
    const { amountText: _text, ...contract } = draft;
    void run(() => desktopApi.saveContract({ ...contract, amountCents }), () => setDraft(null));
  }

  const status = (contract: Contract) => {
    if (contract.status === 'terminated') return t('Résilié au {date}', { date: formatDate(contract.terminatedOn) });
    const end = currentEnd(contract, today);
    if (!end) return t('Durée indéterminée · préavis {months} mois', { months: contract.noticeMonths });
    if (!contract.autoRenew) return t('Se termine le {date}', { date: formatDate(end) });
    const next = nextDecision(contract, today);
    return next ? t('Reconduit le {date} · résiliable jusqu’au {deadline}', { date: formatDate(next.end), deadline: formatDate(next.deadline) }) : t('Se termine le {date}', { date: formatDate(end) });
  };
  const amount = (contract: Contract) => contract.amountCents ? `${formatMoney(contract.amountCents, contract.currency)} ${t(FREQUENCIES.find(([value]) => value === contract.frequency)?.[1] ?? '')}` : '';
  const set = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  return <section className="erp-register" aria-labelledby={`contracts-${side}-title`}>
    <h2 id={`contracts-${side}-title`}>{t(side === 'customer' ? 'Contrats clients' : 'Contrats et abonnements')}</h2>
    <p>{t(side === 'customer'
      ? 'Contrats de maintenance, mandats et abonnements de vos clients, avec leur échéance.'
      : 'Loyer, assurances, leasing, logiciels : Autopilote vous prévient avant le dernier jour pour résilier.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Indiquez le début, la fin s’il y en a une, et le préavis en mois.')}</li>
        <li>{t('Reconduction tacite : le contrat repart pour la durée choisie si personne ne le résilie à temps.')}</li>
        <li>{t('60 jours avant le dernier jour pour résilier, ou avant la fin, une carte apparaît dans Autopilote.')}</li>
      </ol>
    </details>
    {error ? <ErrorPanel message={error} /> : null}
    {!draft ? <div className="erp-register__actions"><Button disabled={locked} onClick={() => { setDraft(empty(side, today)); setError(''); }}>{t('Ajouter un contrat')}</Button></div> : <div className="erp-register__form">
      <Field label={t(side === 'customer' ? 'Client' : 'Fournisseur')}>
        <input list={`contract-parties-${side}`} value={draft.partyName} maxLength={200} disabled={locked} onChange={(event) => {
          const match = parties.find((row) => row.name === event.target.value);
          set({ partyName: event.target.value, clientId: side === 'customer' ? match?.id ?? null : null, supplierId: side === 'supplier' ? match?.id ?? null : null });
        }} />
        <datalist id={`contract-parties-${side}`}>{parties.map((row) => <option key={row.id} value={row.name} />)}</datalist>
      </Field>
      <Field label={t('Objet du contrat')}><input value={draft.title} maxLength={200} disabled={locked} onChange={(event) => set({ title: event.target.value })} /></Field>
      <Field label={t('Début')}><input type="date" value={draft.startDate} disabled={locked} onChange={(event) => set({ startDate: event.target.value })} /></Field>
      <Field label={t('Fin')} hint={t('Laissez vide pour une durée indéterminée.')}><input type="date" value={draft.endDate ?? ''} disabled={locked} onChange={(event) => set({ endDate: event.target.value || null })} /></Field>
      <Field label={t('Préavis (mois)')}><input inputMode="numeric" value={String(draft.noticeMonths)} disabled={locked} onChange={(event) => set({ noticeMonths: Math.min(36, Number(event.target.value.replace(/\D/g, '')) || 0) })} /></Field>
      <Field label={t('Montant')}><input inputMode="decimal" placeholder="0.00" value={draft.amountText} disabled={locked} onChange={(event) => set({ amountText: event.target.value })} /></Field>
      <Field label={t('Périodicité')}>
        <select value={draft.frequency} disabled={locked} onChange={(event) => set({ frequency: event.target.value as Contract['frequency'] })}>
          {FREQUENCIES.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </Field>
      <Field label={t('Indexation')} hint={t('Par exemple : IPC chaque janvier')}><input value={draft.indexation} maxLength={200} disabled={locked} onChange={(event) => set({ indexation: event.target.value })} /></Field>
      <label className="erp-register__switch erp-register__wide">
        <input type="checkbox" role="switch" aria-checked={draft.autoRenew} checked={draft.autoRenew} disabled={locked || !draft.endDate} onChange={(event) => set({ autoRenew: event.target.checked })} />
        <span>{t('Reconduction tacite de {months} mois', { months: draft.renewalMonths })}</span>
      </label>
      {draft.autoRenew && draft.endDate ? <Field label={t('Durée de reconduction (mois)')}><input inputMode="numeric" value={String(draft.renewalMonths)} disabled={locked} onChange={(event) => set({ renewalMonths: Math.max(1, Math.min(120, Number(event.target.value.replace(/\D/g, '')) || 1)) })} /></Field> : null}
      <div className="erp-register__actions">
        <Button disabled={locked || !draft.partyName.trim() || !draft.title.trim()} onClick={save}>{busy ? t('Enregistrement…') : t('Enregistrer le contrat')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
      </div>
    </div>}
    {contracts.length ? <ul className="erp-register__list">
      {contracts.map((contract) => <li key={contract.id}>
        <span><strong>{contract.title} · {contract.partyName}</strong><small>{status(contract)}</small></span>
        <span className="erp-register__amount">{amount(contract)}</span>
        {contract.status === 'active' ? <span className="erp-register__links">
          <button type="button" disabled={locked} onClick={() => { setDraft({ ...contract, amountText: (contract.amountCents / 100).toFixed(2) }); setError(''); }}>{t('Modifier')}</button>
          <button type="button" disabled={locked} onClick={() => {
            const end = currentEnd(contract, today) ?? today;
            if (window.confirm(t('Marquer « {title} » comme résilié au {date} ?', { title: contract.title, date: formatDate(end) }))) void run(() => desktopApi.terminateContract(contract.id, end));
          }}>{t('Marquer comme résilié')}</button>
        </span> : null}
      </li>)}
    </ul> : !draft ? <p>{t('Aucun contrat pour l’instant.')}</p> : null}
  </section>;
}
