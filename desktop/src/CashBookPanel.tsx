import { useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { cashBookLines, countedCents, DENOMINATIONS, localDate, uncorrectedCount } from './cashBook';
import { t, useAppLanguage } from './language';
import type { CashBookEntry, Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import './erp-registers.css';

type EntryKind = Exclude<CashBookEntry['kind'], 'correction'>;
const KINDS: readonly [EntryKind, string][] = [
  ['receipt', 'Encaissement'],
  ['expense', 'Dépense payée en espèces'],
  ['bank_deposit', 'Versement à la banque'],
  ['bank_withdrawal', 'Retrait à la banque'],
  ['opening', 'Fond de caisse initial'],
];
const KIND_LABEL: Record<CashBookEntry['kind'] | 'invoice_payment', string> = {
  opening: 'Fond de caisse initial', receipt: 'Encaissement', expense: 'Dépense', bank_deposit: 'Versement à la banque',
  bank_withdrawal: 'Retrait à la banque', correction: 'Correction après comptage', invoice_payment: 'Facture {number} payée en espèces',
};

const centsFromText = (value: string) => {
  const match = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*$/.exec(value.replace(/['’\s]/g, ''));
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
};

/** Livre de caisse : solde, mouvements et comptage du soir. */
export function CashBookPanel({ workspace, disabled, onWorkspace }: { workspace: Workspace; disabled: boolean; onWorkspace: (next: Workspace) => void }) {
  useAppLanguage();
  const today = localDate(new Date());
  const [mode, setMode] = useState<'idle' | 'entry' | 'count'>('idle');
  const [kind, setKind] = useState<EntryKind>('receipt');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => cashBookLines(workspace), [workspace]);
  const balance = lines.length ? lines[lines.length - 1].balanceCents : 0;
  const openingDone = (workspace.cashBookEntries ?? []).some((entry) => entry.kind === 'opening');
  const pending = uncorrectedCount(workspace.cashCounts, workspace.cashBookEntries);
  const counted = countedCents(counts);
  const expectedToday = lines.filter((line) => line.date <= today).reduce((sum, line) => sum + line.amountCents, 0);
  const locked = disabled || busy;

  async function run(action: () => Promise<Workspace>, after?: () => void) {
    setBusy(true);
    setError('');
    try {
      onWorkspace(await action());
      after?.();
    } catch (reason) {
      setError(errorMessage(reason, t('L’opération n’a pas pu être enregistrée.')));
    } finally {
      setBusy(false);
    }
  }

  function saveEntry() {
    const cents = centsFromText(amount);
    if (!cents) { setError(t('Saisissez un montant positif.')); return; }
    if (!description.trim()) { setError(t('Décrivez le mouvement.')); return; }
    void run(() => desktopApi.addCashEntry({ entryDate: date, kind, amountCents: cents, description: description.trim() }), () => { setMode('idle'); setAmount(''); setDescription(''); });
  }

  function saveCount() {
    void run(async () => (await desktopApi.recordCashCount({ countDate: today, denominations: counts })).workspace, () => { setMode('idle'); setCounts({}); });
  }

  return <section className="erp-register" aria-labelledby="cash-book-title">
    <h2 id="cash-book-title">{t('Caisse')}</h2>
    <p>{t('Le journal de vos espèces. Les factures payées en espèces y apparaissent seules ; le soir, comptez la caisse pour vérifier le solde.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Saisissez une fois le fond de caisse initial.')}</li>
        <li>{t('Ajoutez chaque encaissement, dépense ou versement à la banque. Une ligne ne se modifie pas : corrigez par un comptage.')}</li>
        <li>{t('Le soir, comptez les billets et les pièces. S’il y a un écart, Autopilote vous propose de corriger le livre de caisse.')}</li>
      </ol>
    </details>
    <div className="erp-register__figure"><strong>{formatMoney(balance)}</strong><span>{t('en caisse')}</span></div>
    {error ? <ErrorPanel message={error} /> : null}
    {pending ? <div className="erp-register__actions" role="status">
      <p>{t('Comptage du {date} : écart de {amount}.', { date: formatDate(pending.countDate), amount: formatMoney(pending.differenceCents) })}</p>
      <Button variant="secondary" disabled={locked} onClick={() => void run(() => desktopApi.correctCashCount(pending.id))}>{t('Corriger le livre de caisse')}</Button>
    </div> : null}
    {mode === 'idle' ? <div className="erp-register__actions">
      <Button disabled={locked} onClick={() => { setMode('count'); setError(''); }}>{t('Compter la caisse')}</Button>
      <Button variant="secondary" disabled={locked} onClick={() => { setKind(openingDone ? 'receipt' : 'opening'); setMode('entry'); setError(''); }}>{t('Ajouter un mouvement')}</Button>
    </div> : null}
    {mode === 'entry' ? <div className="erp-register__form">
      <Field label={t('Mouvement')}>
        <select value={kind} disabled={locked} onChange={(event) => setKind(event.target.value as EntryKind)}>
          {KINDS.filter(([value]) => value !== 'opening' || !openingDone).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </Field>
      <Field label={t('Date')}><input type="date" value={date} max={today} disabled={locked} onChange={(event) => setDate(event.target.value)} /></Field>
      <Field label={t('Montant (CHF)')}><input inputMode="decimal" placeholder="0.00" value={amount} disabled={locked} onChange={(event) => setAmount(event.target.value)} /></Field>
      <Field label={t('Description')}><input value={description} maxLength={300} disabled={locked} onChange={(event) => setDescription(event.target.value)} /></Field>
      <div className="erp-register__actions">
        <Button disabled={locked} onClick={saveEntry}>{busy ? t('Enregistrement…') : t('Enregistrer')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setMode('idle')}>{t('Annuler')}</Button>
      </div>
    </div> : null}
    {mode === 'count' ? <div className="erp-register__form">
      <div className="erp-register__wide erp-register__denominations">
        {DENOMINATIONS.map((value) => <Field key={value} label={value >= 1_000 ? t('Billets de {value}', { value: value / 100 }) : t('Pièces de {value}', { value: value >= 100 ? value / 100 : (value / 100).toFixed(2) })}>
          <input inputMode="numeric" placeholder="0" value={counts[value] ? String(counts[value]) : ''} disabled={locked}
            onChange={(event) => { const next = Number(event.target.value.replace(/\D/g, '')); setCounts((current) => ({ ...current, [value]: Number.isFinite(next) ? Math.min(next, 100_000) : 0 })); }} />
        </Field>)}
      </div>
      <p className="erp-register__wide">{t('Compté : {counted} · attendu : {expected} · écart : {difference}', { counted: formatMoney(counted), expected: formatMoney(expectedToday), difference: formatMoney(counted - expectedToday) })}</p>
      <div className="erp-register__actions">
        <Button disabled={locked} onClick={saveCount}>{busy ? t('Enregistrement…') : t('Enregistrer le comptage')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setMode('idle')}>{t('Annuler')}</Button>
      </div>
    </div> : null}
    {lines.length ? <ul className="erp-register__list" aria-label={t('Mouvements de caisse')}>
      {[...lines].reverse().slice(0, 100).map((line) => <li key={line.id}>
        <span><strong>{line.kind === 'invoice_payment' ? t(KIND_LABEL.invoice_payment, { number: line.label }) : line.label}</strong><small>{formatDate(line.date)} · {t(line.kind === 'invoice_payment' ? 'Encaissement' : KIND_LABEL[line.kind])}</small></span>
        <span className="erp-register__amount"><span className={line.amountCents < 0 ? 'is-negative' : ''}>{line.amountCents > 0 ? '+' : ''}{formatMoney(line.amountCents)}</span><small>{t('Solde {amount}', { amount: formatMoney(line.balanceCents) })}</small></span>
      </li>)}
    </ul> : <p>{t('Aucun mouvement pour l’instant. Commencez par le fond de caisse initial.')}</p>}
  </section>;
}
