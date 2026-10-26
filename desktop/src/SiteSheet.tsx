import { useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { getAppLocale, t, useAppLanguage } from './language';
import { parseRateAmount } from './laborRates';
import { SITE_CATEGORIES, budgetFromQuotes, siteLedger, type SiteCategory } from './siteLedger';
import type { Project, Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatMinutes, formatMoney } from './utils';

const CATEGORY_LABELS: Record<SiteCategory, string> = {
  labor: 'Main-d’œuvre', material: 'Matériel', subcontract: 'Sous-traitance', machine: 'Machines', other: 'Divers',
};
type BudgetDraft = { category: SiteCategory; label: string; amount: string; hours: string };
type SubcontractDraft = { id: string | null; supplierId: string; label: string; agreed: string; closed: boolean };

const amountText = (cents: number) => (cents / 100).toFixed(2);
const hoursText = (minutes: number | null) => (minutes ? String(Math.round((minutes / 60) * 100) / 100).replace('.', ',') : '');
const parseHours = (value: string) => {
  if (!value.trim()) return null;
  const number = Number(value.replace(',', '.'));
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 60) : NaN;
};

/** Fiche chantier : prévu, réel, marge en temps réel, sous-traitance et post-calcul. */
export function SiteSheet({ project, workspace, readOnly, onWorkspaceChange }: { project: Project; workspace: Workspace; readOnly: boolean; onWorkspaceChange: (next: Workspace) => void }) {
  useAppLanguage();
  const ledger = useMemo(() => siteLedger(project, workspace), [project, workspace]);
  const budget = (workspace.projectBudgetLines ?? []).filter(line => line.projectId === project.id);
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft[] | null>(null);
  const [subcontractDraft, setSubcontractDraft] = useState<SubcontractDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const locked = readOnly || busy;

  async function run(action: () => Promise<Workspace>, done: string) {
    setBusy(true);
    setMessage('');
    try {
      onWorkspaceChange(await action());
      setMessage(done);
      return true;
    } catch (reason) {
      setMessage(errorMessage(reason, t('L’enregistrement a échoué. Vos saisies sont conservées.')));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const rows = SITE_CATEGORIES.filter(key => ledger.planned[key].cents || ledger.actual[key].cents);
  const plannedMinutes = ledger.planned.labor.minutes || project.plannedMinutes;
  const actualMinutes = ledger.actual.labor.minutes;
  const marginPermille = ledger.invoicedNetCents > 0 ? Math.round((ledger.actualMarginCents / ledger.invoicedNetCents) * 1_000) : null;
  const budgetValid = !!budgetDraft && budgetDraft.every(line => line.label.trim() && parseRateAmount(line.amount || '0') !== null && !Number.isNaN(parseHours(line.hours)));
  const subcontractCents = subcontractDraft ? parseRateAmount(subcontractDraft.agreed || '') : null;
  const projectInvoices = workspace.supplierInvoices.filter(invoice => invoice.projectId === project.id);
  const links = new Map((workspace.subcontractLinks ?? []).map(link => [link.supplierInvoiceId, link.subcontractId]));

  return <section className="site-sheet" aria-labelledby={`site-sheet-${project.id}`}>
    <h3 id={`site-sheet-${project.id}`}>{ledger.finished ? t('Post-calcul du chantier') : t('Fiche chantier')}</h3>
    <dl className="site-sheet__figures">
      <div><dt>{t('Contrat (devis acceptés, HT)')}</dt><dd>{ledger.contractNetCents ? formatMoney(ledger.contractNetCents) : '—'}</dd></div>
      <div><dt>{t('Facturé (HT)')}</dt><dd>{formatMoney(ledger.invoicedNetCents)}{ledger.invoicedPermille !== null ? <small>{t('{percent} % du contrat', { percent: (ledger.invoicedPermille / 10).toLocaleString(getAppLocale()) })}</small> : null}</dd></div>
      <div><dt>{ledger.finished ? t('Marge finale') : t('Marge à ce jour')}</dt><dd>{formatMoney(ledger.actualMarginCents)}{marginPermille !== null ? <small>{t('{percent} % du facturé', { percent: (marginPermille / 10).toLocaleString(getAppLocale()) })}</small> : null}</dd></div>
      <div><dt>{t('Marge prévue')}</dt><dd>{ledger.plannedMarginCents === null ? '—' : formatMoney(ledger.plannedMarginCents)}</dd></div>
    </dl>

    <table className="site-sheet__table">
      <caption>{t('Prévu et réel')}</caption>
      <thead><tr><th scope="col">{t('Nature')}</th><th scope="col">{t('Prévu')}</th><th scope="col">{t('Réel')}</th><th scope="col">{t('Écart')}</th></tr></thead>
      <tbody>
        {rows.length ? rows.map(key => {
          const gap = ledger.actual[key].cents - ledger.planned[key].cents;
          return <tr key={key}>
            <th scope="row">{t(CATEGORY_LABELS[key])}</th>
            <td>{ledger.planned[key].cents ? formatMoney(ledger.planned[key].cents) : '—'}</td>
            <td>{formatMoney(ledger.actual[key].cents)}</td>
            <td className={gap > 0 && ledger.planned[key].cents ? 'site-sheet__over' : undefined}>{ledger.planned[key].cents ? (gap > 0 ? '+' : '') + formatMoney(gap) : '—'}</td>
          </tr>;
        }) : <tr><td colSpan={4}>{t('Aucun coût ni budget pour l’instant.')}</td></tr>}
        <tr className="site-sheet__total">
          <th scope="row">{t('Total des coûts')}</th>
          <td>{ledger.plannedCents ? formatMoney(ledger.plannedCents) : '—'}</td>
          <td>{formatMoney(ledger.actualCents)}</td>
          <td>{ledger.plannedCents ? (ledger.actualCents > ledger.plannedCents ? '+' : '') + formatMoney(ledger.actualCents - ledger.plannedCents) : '—'}</td>
        </tr>
        <tr>
          <th scope="row">{t('Heures')}</th>
          <td>{plannedMinutes ? formatMinutes(plannedMinutes) : '—'}</td>
          <td>{actualMinutes ? formatMinutes(actualMinutes) : '—'}</td>
          <td>{plannedMinutes ? (actualMinutes >= plannedMinutes ? '+' : '−') + formatMinutes(Math.abs(actualMinutes - plannedMinutes)) : '—'}</td>
        </tr>
      </tbody>
    </table>
    {ledger.uncostedRegieMinutes ? <p className="site-sheet__note">{t('{hours} de régie sans coût connu : ajoutez le coût dans les tarifs de régie pour les compter dans la marge.', { hours: formatMinutes(ledger.uncostedRegieMinutes) })}</p> : null}
    {ledger.draftSupplierInvoices ? <p className="site-sheet__note">{t('{count} facture(s) fournisseur en brouillon ne sont pas encore comptées.', { count: ledger.draftSupplierInvoices })}</p> : null}
    {message ? <p role="status" className="site-sheet__note">{message}</p> : null}

    <section className="site-sheet__block" aria-label={t('Budget prévu')}>
      <header><h4>{t('Budget prévu')}</h4>
        {!budgetDraft ? <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => setBudgetDraft(budget.length
          ? budget.map(line => ({ category: line.category, label: line.label, amount: amountText(line.amountCents), hours: hoursText(line.minutes) }))
          : [{ category: 'labor', label: '', amount: '', hours: '' }])}>{budget.length ? t('Modifier le budget') : t('Saisir le budget')}</Button> : null}
      </header>
      {budgetDraft ? <div className="site-sheet__form">
        {budgetDraft.map((line, index) => <div className="site-sheet__budget-row" key={index}>
          <select aria-label={t('Nature')} value={line.category} disabled={locked} onChange={event => setBudgetDraft(budgetDraft.map((row, position) => position === index ? { ...row, category: event.target.value as SiteCategory } : row))}>
            {SITE_CATEGORIES.map(key => <option key={key} value={key}>{t(CATEGORY_LABELS[key])}</option>)}
          </select>
          <input aria-label={t('Poste')} value={line.label} maxLength={160} placeholder={t('Poste')} disabled={locked} onChange={event => setBudgetDraft(budgetDraft.map((row, position) => position === index ? { ...row, label: event.target.value } : row))} />
          <input aria-label={t('Montant CHF')} inputMode="decimal" placeholder="0.00" value={line.amount} disabled={locked} onChange={event => setBudgetDraft(budgetDraft.map((row, position) => position === index ? { ...row, amount: event.target.value } : row))} />
          <input aria-label={t('Heures')} inputMode="decimal" placeholder={t('heures')} value={line.hours} disabled={locked} onChange={event => setBudgetDraft(budgetDraft.map((row, position) => position === index ? { ...row, hours: event.target.value } : row))} />
          <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => setBudgetDraft(budgetDraft.filter((_, position) => position !== index))}>{t('Retirer')}</Button>
        </div>)}
        <div className="site-sheet__actions">
          <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => setBudgetDraft([...budgetDraft, { category: 'material', label: '', amount: '', hours: '' }])}>{t('Ajouter un poste')}</Button>
          <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => {
            const proposal = budgetFromQuotes(project, workspace);
            if (!proposal.length) { setMessage(t('Aucun devis accepté avec des heures ou des articles chiffrés pour ce chantier.')); return; }
            setBudgetDraft(proposal.map(line => ({ category: line.category, label: t(line.label), amount: amountText(line.amountCents), hours: hoursText(line.minutes) })));
            setMessage(t('Budget repris des devis acceptés. Vérifiez les montants avant d’enregistrer.'));
          }}>{t('Reprendre des devis acceptés')}</Button>
        </div>
        <div className="site-sheet__actions">
          <Button type="button" disabled={locked || !budgetValid} onClick={() => void run(() => desktopApi.saveProjectBudget(project.id, budgetDraft.map(line => ({ category: line.category, label: line.label.trim(), amountCents: parseRateAmount(line.amount || '0') ?? 0, minutes: parseHours(line.hours) }))), t('Budget du chantier enregistré.')).then(ok => { if (ok) setBudgetDraft(null); })}>{t('Enregistrer le budget')}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setBudgetDraft(null)}>{t('Annuler')}</Button>
        </div>
      </div> : budget.length ? <ul className="site-sheet__list">{budget.map(line => <li key={line.id}><span>{line.label}<small>{t(CATEGORY_LABELS[line.category])}{line.minutes ? ` · ${formatMinutes(line.minutes)}` : ''}</small></span><strong>{formatMoney(line.amountCents)}</strong></li>)}</ul>
        : <p className="site-sheet__note">{t('Sans budget, la marge se calcule seulement sur le facturé et les coûts réels.')}</p>}
    </section>

    <section className="site-sheet__block" aria-label={t('Sous-traitance')}>
      <header><h4>{t('Sous-traitance')}</h4>
        {!subcontractDraft ? <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => setSubcontractDraft({ id: null, supplierId: '', label: '', agreed: '', closed: false })}>{t('Ajouter une sous-traitance')}</Button> : null}
      </header>
      {subcontractDraft ? <div className="site-sheet__form">
        <Field label={t('Travaux sous-traités')}><input value={subcontractDraft.label} maxLength={160} disabled={locked} onChange={event => setSubcontractDraft({ ...subcontractDraft, label: event.target.value })} /></Field>
        <Field label={t('Sous-traitant')}>
          <select value={subcontractDraft.supplierId} disabled={locked} onChange={event => setSubcontractDraft({ ...subcontractDraft, supplierId: event.target.value })}>
            <option value="">{t('Choisir plus tard')}</option>
            {workspace.suppliers.filter(supplier => !supplier.archivedAt).map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          </select>
        </Field>
        <Field label={t('Montant convenu selon devis (CHF, HT)')}><input inputMode="decimal" value={subcontractDraft.agreed} disabled={locked} onChange={event => setSubcontractDraft({ ...subcontractDraft, agreed: event.target.value })} /></Field>
        <label className="site-sheet__check"><input type="checkbox" checked={subcontractDraft.closed} disabled={locked} onChange={event => setSubcontractDraft({ ...subcontractDraft, closed: event.target.checked })} />{t('Travaux terminés et entièrement facturés')}</label>
        <div className="site-sheet__actions">
          <Button type="button" disabled={locked || !subcontractDraft.label.trim() || subcontractCents === null} onClick={() => void run(() => desktopApi.saveProjectSubcontract({ id: subcontractDraft.id, projectId: project.id, supplierId: subcontractDraft.supplierId || null, label: subcontractDraft.label.trim(), agreedCents: subcontractCents ?? 0, closed: subcontractDraft.closed }), t('Sous-traitance enregistrée.')).then(ok => { if (ok) setSubcontractDraft(null); })}>{t('Enregistrer')}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setSubcontractDraft(null)}>{t('Annuler')}</Button>
        </div>
      </div> : null}
      {ledger.subcontracts.length ? <ul className="site-sheet__list">{ledger.subcontracts.map(({ subcontract, billedCents, remainingCents }) => {
        const supplier = workspace.suppliers.find(candidate => candidate.id === subcontract.supplierId);
        const candidates = projectInvoices.filter(invoice => !links.has(invoice.id) && (!subcontract.supplierId || invoice.supplierId === subcontract.supplierId));
        return <li key={subcontract.id}>
          <span>{subcontract.label}<small>{[supplier?.name, t('convenu {amount}', { amount: formatMoney(subcontract.agreedCents) }), t('facturé {amount}', { amount: formatMoney(billedCents) }), subcontract.closed ? t('terminé') : ''].filter(Boolean).join(' · ')}</small></span>
          <strong className={remainingCents < 0 ? 'site-sheet__over' : undefined}>{remainingCents < 0 ? t('dépassé de {amount}', { amount: formatMoney(-remainingCents) }) : t('reste {amount}', { amount: formatMoney(remainingCents) })}</strong>
          <span className="site-sheet__links">
            <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => setSubcontractDraft({ id: subcontract.id, supplierId: subcontract.supplierId ?? '', label: subcontract.label, agreed: amountText(subcontract.agreedCents), closed: subcontract.closed })}>{t('Modifier')}</Button>
            {candidates.length ? <select aria-label={t('Relier une facture fournisseur')} value="" disabled={locked} onChange={event => { const id = event.target.value; if (id) void run(async () => (await desktopApi.linkSupplierInvoiceSubcontract(id, subcontract.id)).workspace, t('Facture reliée à la sous-traitance.')); }}>
              <option value="">{t('Relier une facture…')}</option>
              {candidates.map(invoice => <option key={invoice.id} value={invoice.id}>{invoice.supplierName} · {invoice.reference} · {formatMoney(invoice.netCents)}</option>)}
            </select> : null}
          </span>
        </li>;
      })}</ul> : !subcontractDraft ? <p className="site-sheet__note">{t('Notez ici les travaux confiés à un sous-traitant et le montant de son devis : Zentra compare avec ses factures.')}</p> : null}
    </section>
  </section>;
}
