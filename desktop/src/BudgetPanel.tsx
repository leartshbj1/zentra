import { useEffect, useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { assignedCenter, budgetFromActual, compareBudget, parseBudgetAmount, spreadYearly, type BudgetReport, type CostCenter, type CostCenterAssignment } from './budget';
import { t, useAppLanguage } from './language';
import type { Account, Employee, Project } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatMoney } from './utils';
import './erp-registers.css';

type Draft = Map<string, number[]>;
const sum = (months: readonly number[]) => months.reduce((total, value) => total + value, 0);

/** Budget annuel par compte, comparé chaque mois au réel du journal, pour l'entreprise ou par centre de coûts. */
export function BudgetPanel({ accounts, projects, employees, readOnly }: { accounts: Account[]; projects: Project[]; employees: Employee[]; readOnly: boolean }) {
  useAppLanguage();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [filter, setFilter] = useState('all');
  const [report, setReport] = useState<BudgetReport | null>(null);
  const [previous, setPrevious] = useState<BudgetReport | null>(null);
  const [centers, setCenters] = useState<CostCenter[]>([]);
  const [assignments, setAssignments] = useState<CostCenterAssignment[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [percent, setPercent] = useState('0');
  const [centerForm, setCenterForm] = useState<{ code: string; name: string } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const [nextReport, nextPrevious, nextCenters] = await Promise.all([desktopApi.getBudgetReport(year), desktopApi.getBudgetReport(year - 1), desktopApi.listCostCenters()]);
    setReport(nextReport);
    setPrevious(nextPrevious);
    setCenters(nextCenters.centers);
    setAssignments(nextCenters.assignments);
  };
  useEffect(() => { void refresh().catch(() => undefined); }, [year]);
  const throughMonth = year < thisYear ? 12 : year > thisYear ? 12 : new Date().getMonth() + 1;
  const comparison = useMemo(() => report ? compareBudget(accounts, report, filter, throughMonth) : null, [accounts, report, filter, throughMonth]);
  const budgetAccounts = accounts.filter(account => account.active && (account.accountType === 'revenue' || account.accountType === 'expense')).sort((a, b) => a.code.localeCompare(b.code));
  const activeCenters = centers.filter(center => !center.archivedAt);
  // Le budget se saisit pour toute l'entreprise ou pour un centre.
  const editCenter = filter === 'all' ? '' : filter;
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(Date.UTC(2026, throughMonth - 1, 15)));

  function startEditing(from?: Draft) {
    const next: Draft = from ?? new Map();
    if (!from) for (const line of report?.budget ?? []) {
      if (line.costCenterId !== editCenter) continue;
      const months = next.get(line.accountId) ?? Array(12).fill(0);
      months[line.month - 1] = line.amountCents;
      next.set(line.accountId, months);
    }
    setDraft(next);
    setTexts(Object.fromEntries([...next].map(([id, months]) => [id, (sum(months) / 100).toFixed(2)])));
  }
  function setAnnual(accountId: string, text: string) {
    setTexts(current => ({ ...current, [accountId]: text }));
    const cents = parseBudgetAmount(text);
    if (cents === null || !draft) return;
    const next = new Map(draft);
    if (cents === 0) next.delete(accountId); else next.set(accountId, spreadYearly(cents));
    setDraft(next);
  }
  async function saveBudget() {
    if (!draft) return;
    setBusy(true);
    setMessage('');
    try {
      const total = await desktopApi.saveBudget(year, editCenter, [...draft].map(([accountId, months]) => ({ accountId, months })));
      setMessage(t('Budget {year} enregistré : {amount} au total.', { year, amount: formatMoney(total) }));
      setDraft(null);
      await refresh();
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le budget n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }
  async function saveCenter() {
    if (!centerForm) return;
    setBusy(true);
    setMessage('');
    try {
      await desktopApi.saveCostCenter({ id: null, code: centerForm.code, name: centerForm.name, archived: false });
      setCenterForm(null);
      await refresh();
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le centre de coûts n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }
  async function assign(kind: CostCenterAssignment['kind'], targetId: string, centerId: string) {
    setBusy(true);
    try {
      await desktopApi.assignCostCenter(kind, targetId, centerId || null);
      await refresh();
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le rattachement n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }
  const gapText = (gap: number, type: string) => gap === 0 ? t('Dans le budget') : gap > 0 ? t('{amount} mieux que prévu', { amount: formatMoney(gap) })
    : type === 'revenue' ? t('{amount} en dessous du budget', { amount: formatMoney(-gap) }) : t('{amount} au-dessus du budget', { amount: formatMoney(-gap) });
  const centerSelect = (kind: CostCenterAssignment['kind'], targetId: string, label: string) =>
    <Field label={label} key={kind + targetId}><select value={assignedCenter(assignments, kind, targetId)} disabled={readOnly || busy} onChange={event => void assign(kind, targetId, event.target.value)}>
      <option value="">{t('Aucun centre')}</option>
      {activeCenters.map(center => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}
    </select></Field>;

  return <section className="erp-register" aria-labelledby="budget-title">
    <h2 id="budget-title">{t('Budget et centres de coûts')}</h2>
    <p>{t('Fixez un budget par compte pour l’année : Zentra le compare chaque mois au réel du journal, pour toute l’entreprise ou par centre de coûts.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Créez vos centres de coûts (par exemple Atelier, Chantiers, Administration) et rattachez-y des projets, des personnes ou des comptes.')}</li>
        <li>{t('Saisissez le montant annuel par compte, ou reprenez l’année précédente avec un pourcentage ; il est réparti sur les douze mois.')}</li>
        <li>{t('Le réel suit le journal : une ligne va au centre de son projet, sinon de la personne, sinon du compte.')}</li>
      </ol>
    </details>
    <div className="erp-register__form">
      <Field label={t('Année')}><select value={year} disabled={busy} onChange={event => { setYear(Number(event.target.value)); setDraft(null); }}>{[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map(value => <option key={value} value={value}>{value}</option>)}</select></Field>
      <Field label={t('Centre de coûts')}><select value={filter} disabled={busy} onChange={event => { setFilter(event.target.value); setDraft(null); }}>
        <option value="all">{t('Toute l’entreprise')}</option>
        {activeCenters.map(center => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}
        {centers.length ? <option value="">{t('Sans centre')}</option> : null}
      </select></Field>
    </div>
    {comparison ? <dl className="erp-register__horizons">
      {([['revenue', t('Produits')], ['expense', t('Charges')], ['result', t('Résultat')]] as const).map(([key, label]) => <div key={key}>
        <dt>{label}</dt>
        <dd>{formatMoney(comparison[key].actualToDate)}</dd>
        <dd className="erp-register__note">{t('budget {amount}', { amount: formatMoney(comparison[key].budgetToDate) })}</dd>
      </div>)}
    </dl> : null}
    {comparison ? <p>{year === thisYear ? t('De janvier à fin {month}.', { month: monthLabel }) : t('Toute l’année {year}.', { year })}</p> : null}
    {report?.entriesWaitingForRate ? <p role="status">{t('{n} écriture(s) en devise attendent leur cours et ne sont pas encore comptées.', { n: report.entriesWaitingForRate })}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {draft ? <div className="erp-register__form">
      <p className="erp-register__wide">{editCenter ? t('Budget {year} du centre {name}, montant annuel par compte en CHF.', { year, name: centers.find(center => center.id === editCenter)?.name ?? '' }) : t('Budget {year} de toute l’entreprise, montant annuel par compte en CHF.', { year })}</p>
      <div className="erp-register__wide erp-register__actions erp-register__actions--fields">
        <Field label={t('Variation par rapport à {year}, en %', { year: year - 1 })}><input inputMode="decimal" value={percent} disabled={busy} onChange={event => setPercent(event.target.value)} /></Field>
        <Button type="button" variant="secondary" disabled={busy || !previous || !Number.isFinite(Number(percent.replace(',', '.')))} onClick={() => startEditing(budgetFromActual(budgetAccounts, previous?.actual ?? [], filter === 'all' ? 'all' : filter, Number(percent.replace(',', '.'))))}>{t('Reprendre le réel {year}', { year: year - 1 })}</Button>
      </div>
      {budgetAccounts.map(account => <Field key={account.id} label={`${account.code} · ${account.name}`}>
        <input inputMode="decimal" placeholder="0.00" value={texts[account.id] ?? ''} disabled={busy} aria-invalid={parseBudgetAmount(texts[account.id] ?? '') === null} onChange={event => setAnnual(account.id, event.target.value)} />
      </Field>)}
      <div className="erp-register__actions">
        <Button type="button" disabled={busy || Object.values(texts).some(text => parseBudgetAmount(text) === null)} onClick={() => void saveBudget()}>{busy ? t('Enregistrement…') : t('Enregistrer le budget')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
      </div>
    </div> : <div className="erp-register__actions">
      <Button type="button" variant="secondary" disabled={readOnly || busy || filter === ''} onClick={() => startEditing()}>{t('Modifier le budget {year}', { year })}</Button>
    </div>}
    {comparison?.rows.length ? <ul className="erp-register__list" aria-label={t('Budget et réel par compte')}>
      {comparison.rows.map(row => <li key={row.account.id}>
        <span><strong>{row.account.code} · {row.account.name}</strong><small>{t('Réel {actual} · budget {budget} (année {year})', { actual: formatMoney(row.actualToDate), budget: formatMoney(row.budgetToDate), year: formatMoney(row.budgetYear) })}</small></span>
        <span className="erp-register__amount"><span>{gapText(row.gap, row.account.accountType)}</span></span>
      </li>)}
    </ul> : comparison ? <p>{t('Aucun budget ni montant réel pour cette sélection.')}</p> : null}

    <h3>{t('Centres de coûts')}</h3>
    {centers.length ? <ul className="erp-register__list" aria-label={t('Centres de coûts')}>
      {centers.map(center => {
        const linked = assignments.filter(row => row.costCenterId === center.id).length;
        return <li key={center.id}><span><strong>{center.code} · {center.name}</strong><small>{center.archivedAt ? t('Archivé') : t('{n} rattachement(s)', { n: linked })}</small></span><span /></li>;
      })}
    </ul> : <p>{t('Aucun centre de coûts : le budget et le réel portent alors sur toute l’entreprise.')}</p>}
    {centerForm ? <div className="erp-register__form">
      <Field label={t('Code')}><input value={centerForm.code} maxLength={12} placeholder="ATELIER" disabled={busy} onChange={event => setCenterForm({ ...centerForm, code: event.target.value })} /></Field>
      <Field label={t('Nom')}><input value={centerForm.name} maxLength={80} placeholder={t('Atelier')} disabled={busy} onChange={event => setCenterForm({ ...centerForm, name: event.target.value })} /></Field>
      <div className="erp-register__actions">
        <Button type="button" disabled={busy || !centerForm.code.trim() || !centerForm.name.trim()} onClick={() => void saveCenter()}>{t('Ajouter le centre')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setCenterForm(null)}>{t('Annuler')}</Button>
      </div>
    </div> : <div className="erp-register__actions"><Button type="button" variant="secondary" disabled={readOnly || busy} onClick={() => setCenterForm({ code: '', name: '' })}>{t('Nouveau centre de coûts')}</Button></div>}
    {activeCenters.length ? <details>
      <summary>{t('Rattacher projets, personnes et comptes')}</summary>
      <div className="erp-register__form">
        {projects.filter(project => !project.archivedAt).map(project => centerSelect('project', project.id, t('Projet · {name}', { name: project.name })))}
        {employees.filter(employee => !employee.archivedAt).map(employee => centerSelect('employee', employee.id, t('Personne · {name}', { name: employee.name })))}
        {budgetAccounts.filter(account => account.accountType === 'expense').map(account => centerSelect('account', account.id, t('Compte · {code} {name}', { code: account.code, name: account.name })))}
      </div>
    </details> : null}
  </section>;
}
