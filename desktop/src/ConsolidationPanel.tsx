import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { MappedFile, type Mapped } from './BexioOpeningImport';
import { balanceFields, balanceHeaderIndex, balanceHeaderScore, defaultBalanceMapping, previewBalance } from './bexioOpening';
import { balanceFromRows, balanceFromTrial, consolidate, consolidationCsv, type CompanyBalance, type ConsolidatedLine, type Elimination } from './consolidation';
import { desktopApi } from './bridge';
import type { Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { createId, errorMessage, formatMoney } from './utils';
import { t, useAppLanguage } from './language';
import './erp-registers.css';

const yearStart = () => `${new Date().getFullYear()}-01-01`;
const yearEnd = () => `${new Date().getFullYear()}-12-31`;
const parseCents = (value: string) => {
  const number = Number(value.replace(/['\s]/g, '').replace(',', '.'));
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : 0;
};

/** Société ajoutée depuis un fichier de balance. */
function OtherCompany({ onAdd }: { onAdd: (company: CompanyBalance) => void }) {
  useAppLanguage();
  const [mapped, setMapped] = useState<Mapped | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const rows = useMemo(() => {
    if (!mapped) return null;
    try { return previewBalance(mapped.source, mapped.header, mapped.mapping); } catch (reason) { return errorMessage(reason, 'Vérifiez les colonnes.'); }
  }, [mapped]);
  const readable = Array.isArray(rows) ? rows.filter((row) => !row.errors.length) : [];
  return (
    <div className="consolidation__add">
      <MappedFile
        label="Choisir la balance d’une autre société"
        fields={balanceFields}
        mapped={mapped}
        disabled={false}
        defaults={defaultBalanceMapping}
        score={balanceHeaderScore}
        headerIndex={balanceHeaderIndex}
        onChange={(next) => { setMapped(next); setName(next ? next.source.fileName.replace(/\.[a-z]+$/i, '') : ''); }}
        onError={setError}
      />
      {error ? <ErrorPanel message={error} /> : null}
      {typeof rows === 'string' ? <ErrorPanel message={rows} /> : null}
      {Array.isArray(rows) ? (
        <div className="consolidation__add-confirm">
          <Field label={t('Nom de la société')}><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></Field>
          <p>{t('{count} comptes lus', { count: readable.length })}{rows.length > readable.length ? ` · ${t('{count} lignes illisibles écartées', { count: rows.length - readable.length })}` : ''}</p>
          <Button variant="secondary" disabled={!readable.length || !name.trim()} onClick={() => { onAdd(balanceFromRows(createId(), name.trim(), rows)); setMapped(null); setName(''); }}>{t('Ajouter cette société')}</Button>
        </div>
      ) : null}
    </div>
  );
}

/** Montants dans le sens normal du compte : passifs, fonds propres et produits en positif. */
const shown = (line: ConsolidatedLine, cents: number) => (cents !== 0 && (line.type === 'liability' || line.type === 'equity' || line.type === 'revenue') ? -cents : cents);

function Lines({ title, lines, companies }: { title: string; lines: ConsolidatedLine[]; companies: CompanyBalance[] }) {
  useAppLanguage();
  if (!lines.length) return null;
  return (
    <div className="table-panel consolidation__table">
      <h3>{t(title)}</h3>
      <table data-apple-records>
        <thead><tr><th>{t('Compte')}</th>{companies.map((company) => <th key={company.id}>{company.name}</th>)}<th>{t('Éliminations')}</th><th>{t('Consolidé')}</th></tr></thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.code}>
              <td data-label={t('Compte')}><strong>{line.code}</strong> <small>{line.name}</small></td>
              {companies.map((company, index) => <td key={company.id} data-label={company.name}>{formatMoney(shown(line, line.byCompany[index]))}</td>)}
              <td data-label={t('Éliminations')}>{formatMoney(shown(line, line.eliminationCents))}</td>
              <td data-label={t('Consolidé')}><strong>{formatMoney(shown(line, line.totalCents))}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Consolidation simple : bilan et résultat combinés de plusieurs sociétés, éliminations manuelles. */
export function ConsolidationPanel({ workspace }: { workspace: Workspace }) {
  useAppLanguage();
  const [dateFrom, setDateFrom] = useState(yearStart());
  const [dateTo, setDateTo] = useState(yearEnd());
  const [own, setOwn] = useState<CompanyBalance | null>(null);
  const [includeOwn, setIncludeOwn] = useState(true);
  const [others, setOthers] = useState<CompanyBalance[]>([]);
  const [eliminations, setEliminations] = useState<Elimination[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const companyName = workspace.settings?.organization.legalName || t('Cette entreprise');
  useEffect(() => {
    let live = true;
    setOwn(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) return;
    desktopApi
      .getTrialBalance({ dateFrom, dateTo })
      .then((trial) => { if (live) setOwn(balanceFromTrial('own', companyName, trial.rows)); })
      .catch((reason) => { if (live) setError(errorMessage(reason, t('La balance de cette entreprise n’a pas pu être lue.'))); });
    return () => { live = false; };
  }, [dateFrom, dateTo, companyName]);
  const companies = useMemo(() => [...(includeOwn && own ? [own] : []), ...others], [includeOwn, own, others]);
  const result = useMemo(() => consolidate(companies, eliminations), [companies, eliminations]);
  const patch = (id: string, change: Partial<Elimination>) => setEliminations((rows) => rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
  async function exportCsv() {
    setSaved('');
    try {
      const content = consolidationCsv(companies, result);
      const file = await desktopApi.saveAccountingExport({ fileName: `Zentra-consolidation-${dateFrom}-${dateTo}.csv`, extension: 'csv', format: 'csv', dateFrom, dateTo, entries: 0, content });
      if (file) setSaved(file.path);
    } catch (reason) {
      setError(errorMessage(reason, t('Le fichier n’a pas pu être enregistré.')));
    }
  }
  return (
    <section className="erp-register consolidation" aria-labelledby="consolidation-title">
      <h2 id="consolidation-title">{t('Consolidation')}</h2>
      <p>{t('Le bilan et le résultat de plusieurs sociétés, additionnés compte par compte. Ajoutez la balance de chaque autre société, puis les éliminations entre elles. Rien n’est écrit dans votre comptabilité.')}</p>
      {error ? <ErrorPanel message={error} /> : null}
      <div className="fiduciary-export__fields">
        <Field label={t('Du')}><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></Field>
        <Field label={t('Au')}><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></Field>
      </div>
      <h3>{t('Sociétés')}</h3>
      <ul className="erp-register__list">
        <li>
          <label className="fiduciary-sharing__toggle"><input type="checkbox" checked={includeOwn} onChange={(event) => setIncludeOwn(event.target.checked)} />{companyName}</label>
          <small>{own ? t('{count} comptes avec un solde', { count: Object.keys(own.accounts).length }) : t('Lecture de la balance…')}</small>
        </li>
        {others.map((company) => (
          <li key={company.id}>
            <span><strong>{company.name}</strong><small>{t('{count} comptes avec un solde', { count: Object.keys(company.accounts).length })}</small></span>
            <Button variant="ghost" size="small" aria-label={t('Retirer {name}', { name: company.name })} onClick={() => setOthers((rows) => rows.filter((row) => row.id !== company.id))}><Trash2 size={16} /></Button>
          </li>
        ))}
      </ul>
      <OtherCompany onAdd={(company) => setOthers((rows) => [...rows, company])} />
      <h3>{t('Éliminations')}</h3>
      <p>{t('Par exemple une créance d’une société envers une autre, ou une vente interne. Chaque élimination se saisit au débit et au crédit.')}</p>
      {eliminations.length ? (
        <ul className="consolidation__eliminations">
          {eliminations.map((row) => (
            <li key={row.id}>
              <Field label={t('Compte')}><input value={row.code} inputMode="numeric" maxLength={10} onChange={(event) => patch(row.id, { code: event.target.value.trim() })} /></Field>
              <Field label={t('Libellé')}><input value={row.label} maxLength={120} onChange={(event) => patch(row.id, { label: event.target.value })} /></Field>
              <Field label={t('Débit')}><input inputMode="decimal" defaultValue={row.debitCents ? String(row.debitCents / 100) : ''} onChange={(event) => patch(row.id, { debitCents: parseCents(event.target.value) })} /></Field>
              <Field label={t('Crédit')}><input inputMode="decimal" defaultValue={row.creditCents ? String(row.creditCents / 100) : ''} onChange={(event) => patch(row.id, { creditCents: parseCents(event.target.value) })} /></Field>
              <Button variant="ghost" size="small" aria-label={t('Retirer cette élimination')} onClick={() => setEliminations((rows) => rows.filter((item) => item.id !== row.id))}><Trash2 size={16} /></Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div><Button variant="secondary" onClick={() => setEliminations((rows) => [...rows, { id: createId(), code: '', label: '', debitCents: 0, creditCents: 0 }])}><Plus size={16} />{t('Ajouter une élimination')}</Button></div>
      {!result.eliminationsBalanced ? <p role="alert">{t('Les éliminations ne sont pas équilibrées : le total au débit doit égaler le total au crédit.')}</p> : null}
      {companies.length ? (
        <>
          <dl className="consolidation__totals">
            <div><dt>{t('Actifs')}</dt><dd>{formatMoney(result.totals.assetsCents)}</dd></div>
            <div><dt>{t('Passifs et fonds propres')}</dt><dd>{formatMoney(result.totals.liabilitiesAndEquityCents)}</dd></div>
            <div><dt>{t('Produits')}</dt><dd>{formatMoney(result.totals.revenueCents)}</dd></div>
            <div><dt>{t('Charges')}</dt><dd>{formatMoney(result.totals.expenseCents)}</dd></div>
            <div><dt>{t('Résultat consolidé')}</dt><dd>{formatMoney(result.totals.resultCents)}</dd></div>
          </dl>
          <p role="status">{result.balanced ? t('Le bilan consolidé est équilibré.') : t('Le bilan consolidé ne s’équilibre pas : vérifiez les balances reprises et les éliminations.')}</p>
          {result.unclassified.length ? <p>{t('{count} comptes sans nature connue ne sont comptés ni au bilan ni au résultat.', { count: result.unclassified.length })}</p> : null}
          <Lines title="Bilan" lines={result.balanceSheet} companies={companies} />
          <Lines title="Compte de résultat" lines={result.income} companies={companies} />
          <div className="erp-register__actions">
            <Button disabled={!result.eliminationsBalanced} onClick={() => void exportCsv()}>{t('Exporter en CSV')}</Button>
            {saved ? <p role="status">{t('Fichier enregistré : {path}', { path: saved })}</p> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
