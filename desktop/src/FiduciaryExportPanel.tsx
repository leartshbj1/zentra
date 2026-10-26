import { useEffect, useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import {
  buildAccountingExport,
  defaultVatCodes,
  entriesFromJournal,
  exportFileName,
  exportFormats,
  vatAccountsFrom,
  type ExportEntry,
  type ExportFormat,
  type VatMode,
} from './accountingExport';
import { computeHealthSummary, readSharing, writeSharing, type HealthSummary } from './fiduciaryHealth';
import type { Account, AccountingSettings, PeriodFilter, Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage, formatDate, formatDateTime } from './utils';
import { t, useAppLanguage } from './language';
import './erp-registers.css';

type Saved = { format: ExportFormat; vatMode: VatMode; accountMaps: Partial<Record<ExportFormat, Record<string, string>>>; vatCodes: Partial<Record<ExportFormat, Record<string, string>>> };

const guides: Record<ExportFormat, string> = {
  banana: 'Dans Banana : Actions › Importer en comptabilité › Écritures, puis « Fichier texte avec en-têtes ».',
  cresus: 'Dans Crésus Comptabilité : importez les écritures au format texte étendu. Faites un premier essai sur une copie du dossier.',
  abacus: 'Dans Abacus : import ASCII des écritures (FIBU). Faites un premier essai : le séparateur peut devoir être adapté.',
  winbiz: 'Dans WinBIZ : import paramétrable des écritures, en associant les colonnes du fichier.',
  csv: 'Une ligne par mouvement : date, pièce, comptes au débit et au crédit, libellé, montant et TVA.',
};

const storageKey = (scope: string | undefined) => `zentra.fiduciaryExport.v1:${scope ?? 'local'}`;

function readSaved(scope: string | undefined): Saved {
  const empty: Saved = { format: 'banana', vatMode: 'lines', accountMaps: {}, vatCodes: {} };
  try {
    const raw = JSON.parse(window.localStorage.getItem(storageKey(scope)) ?? 'null') as Partial<Saved> | null;
    if (!raw || typeof raw !== 'object') return empty;
    return {
      format: exportFormats.some((entry) => entry.id === raw.format) ? raw.format! : 'banana',
      vatMode: raw.vatMode === 'codes' ? 'codes' : 'lines',
      accountMaps: raw.accountMaps && typeof raw.accountMaps === 'object' ? raw.accountMaps : {},
      vatCodes: raw.vatCodes && typeof raw.vatCodes === 'object' ? raw.vatCodes : {},
    };
  } catch {
    return empty;
  }
}

function writeSaved(scope: string | undefined, saved: Saved) {
  try { window.localStorage.setItem(storageKey(scope), JSON.stringify(saved)); } catch { /* La correspondance est seulement un confort. */ }
}

const yearStart = () => `${new Date().getFullYear()}-01-01`;
const yearEnd = () => `${new Date().getFullYear()}-12-31`;
const percent = (bp: number) => (bp / 100).toLocaleString('fr-CH', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

/** État du dossier montré à la fiduciaire : des nombres et des dates, envoyés seulement si l'entreprise le veut. */
function DossierSharing({ workspace, accountingEnabled }: { workspace: Workspace; accountingEnabled: boolean }) {
  useAppLanguage();
  const scope = workspace.workNotesScope;
  const [on, setOn] = useState(() => readSharing(scope));
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void Promise.all([
      desktopApi.getBankWorkspace(scope).catch(() => null),
      desktopApi.listVatReturnExports({}).catch(() => []),
      desktopApi.listAccountingPeriods().catch(() => []),
    ]).then(([bank, vatExports, periods]) => {
      if (!live) return;
      setSummary(computeHealthSummary({
        expenses: workspace.expenses,
        supplierInvoices: workspace.supplierInvoices,
        attachments: workspace.attachments ?? [],
        unreconciledBank: bank?.summary.unreconciledCount ?? 0,
        vatExports,
        periods,
        accountingEnabled,
        now: new Date(),
      }));
    });
    return () => { live = false; };
  }, [workspace, scope, accountingEnabled]);
  async function publish(next: HealthSummary) {
    const result = await desktopApi.publishFiduciarySummary(next);
    setSentAt(result.receivedAt);
  }
  // Partage actif : l'état envoyé suit le dossier à chaque ouverture de l'écran.
  useEffect(() => {
    if (on && summary && sentAt === null) void publish(summary).catch(() => undefined);
  }, [on, summary]);
  async function toggle(next: boolean) {
    if (busy || !summary) return;
    setBusy(true);
    setError('');
    try {
      if (next) await publish(summary);
      else { await desktopApi.stopFiduciarySummary(); setSentAt(null); }
      writeSharing(scope, next);
      setOn(next);
    } catch (reason) {
      setError(errorMessage(reason, t('Le partage n’a pas pu être mis à jour.')));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fiduciary-sharing">
      <h3>{t('État du dossier pour votre fiduciaire')}</h3>
      <p>{t('Votre fiduciaire voit dans son espace Zentra ce qui manque encore. Seuls ces nombres et ces dates sont envoyés, jamais un montant ni une pièce.')}</p>
      {summary ? (
        <dl>
          <div><dt>{t('Justificatifs manquants')}</dt><dd>{summary.missingReceipts}</dd></div>
          <div><dt>{t('Mouvements bancaires à rapprocher')}</dt><dd>{summary.unreconciledBank}</dd></div>
          <div><dt>{t('TVA déclarée jusqu’au')}</dt><dd>{summary.vatFiledThrough ? formatDate(summary.vatFiledThrough) : t('Pas encore')}</dd></div>
          <div><dt>{t('Exercice clôturé jusqu’au')}</dt><dd>{summary.closedThrough ? formatDate(summary.closedThrough) : t('Pas encore')}</dd></div>
        </dl>
      ) : null}
      {error ? <ErrorPanel message={error} /> : null}
      <label className="fiduciary-sharing__toggle">
        <input type="checkbox" checked={on} disabled={busy || !summary} onChange={(event) => void toggle(event.target.checked)} />
        {t('Partager l’état du dossier')}
      </label>
      {on && sentAt ? <small>{t('Envoyé le {date}', { date: formatDateTime(new Date(sentAt * 1000).toISOString()) })}</small> : null}
    </div>
  );
}

/** Fichier d'écritures pour le logiciel de la fiduciaire, par période. */
export function FiduciaryExportPanel({ filter, workspaceScope, workspace }: { filter: PeriodFilter; workspaceScope?: string; workspace?: Workspace }) {
  useAppLanguage();
  const [saved, setSaved] = useState<Saved>(() => readSaved(workspaceScope));
  const [dateFrom, setDateFrom] = useState(filter.dateFrom || yearStart());
  const [dateTo, setDateTo] = useState(filter.dateTo || yearEnd());
  const [entries, setEntries] = useState<ExportEntry[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([desktopApi.listAccounts(), desktopApi.getAccountingSettings()])
      .then(([nextAccounts, nextSettings]) => { if (live) { setAccounts(nextAccounts); setSettings(nextSettings); } })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  useEffect(() => {
    setEntries(null);
    setDone(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) return;
    let live = true;
    setError('');
    desktopApi
      .getJournal({ dateFrom, dateTo })
      .then((report) => { if (live) setEntries(entriesFromJournal(report)); })
      .catch((reason) => { if (live) setError(errorMessage(reason, t('Le journal de la période n’a pas pu être lu.'))); });
    return () => { live = false; };
  }, [dateFrom, dateTo]);
  const update = (patch: Partial<Saved>) => setSaved((current) => { const next = { ...current, ...patch }; writeSaved(workspaceScope, next); return next; });
  const format = saved.format;
  const accountMap = useMemo(() => saved.accountMaps[format] ?? {}, [saved.accountMaps, format]);
  const vatCodes = useMemo(() => ({ ...defaultVatCodes[format], ...(saved.vatCodes[format] ?? {}) }), [saved.vatCodes, format]);
  const vatAccounts = useMemo(() => vatAccountsFrom(accounts, settings), [accounts, settings]);
  const result = useMemo(
    () => (entries ? buildAccountingExport(entries, { format, vatMode: saved.vatMode, accountMap, vatCodes, vatAccounts }) : null),
    [entries, format, saved.vatMode, accountMap, vatCodes, vatAccounts],
  );
  const used = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of entries ?? []) for (const line of entry.lines) if (!seen.has(line.code)) seen.set(line.code, line.name);
    return [...seen].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);
  async function exportFile() {
    if (!result || !entries?.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const file = await desktopApi.saveAccountingExport({ fileName: exportFileName(format, dateFrom, dateTo), extension: result.extension, format, dateFrom, dateTo, entries: result.entries, content: result.content });
      if (file) setDone(file.path);
    } catch (reason) {
      setError(errorMessage(reason, t('Le fichier n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="erp-register fiduciary-export" aria-labelledby="fiduciary-export-title">
      <h2 id="fiduciary-export-title">{t('Exporter pour la fiduciaire')}</h2>
      {workspace ? <DossierSharing workspace={workspace} accountingEnabled={Boolean(settings?.enabled)} /> : null}
      <h3>{t('Fichier d’écritures')}</h3>
      <p>{t('Un fichier d’écritures que votre fiduciaire importe dans son logiciel. Les montants sont ceux de votre journal, en CHF, compte par compte.')}</p>
      {error ? <ErrorPanel message={error} /> : null}
      <div className="fiduciary-export__fields">
        <Field label={t('Du')}><input type="date" value={dateFrom} disabled={busy} onChange={(event) => setDateFrom(event.target.value)} /></Field>
        <Field label={t('Au')}><input type="date" value={dateTo} disabled={busy} onChange={(event) => setDateTo(event.target.value)} /></Field>
        <Field label={t('Logiciel de la fiduciaire')}>
          <select value={format} disabled={busy} onChange={(event) => update({ format: event.target.value as ExportFormat })}>
            {exportFormats.map((entry) => <option key={entry.id} value={entry.id}>{t(entry.name)}</option>)}
          </select>
        </Field>
        <Field label={t('TVA')}>
          <select value={saved.vatMode} disabled={busy} onChange={(event) => update({ vatMode: event.target.value as VatMode })}>
            <option value="lines">{t('Lignes de TVA séparées')}</option>
            <option value="codes">{t('Codes TVA du logiciel')}</option>
          </select>
        </Field>
      </div>
      <p className="fiduciary-export__hint">{t(saved.vatMode === 'lines'
        ? 'Chaque écriture garde ses lignes de TVA : les soldes sont identiques à ceux de Zentra.'
        : 'Les écritures à un seul taux portent le code TVA et le logiciel refait la TVA. Les autres gardent leurs lignes de TVA.')}</p>
      {dateFrom > dateTo ? <p role="alert">{t('La période commence après sa fin.')}</p> : null}
      {result ? (
        <>
          <div className="fiduciary-export__summary" role="status">
            <h3>{result.entries === 0 ? t('Aucune écriture sur cette période') : t(result.entries === 1 ? '{count} écriture' : '{count} écritures', { count: result.entries })}</h3>
            {result.entries ? <p>{t('{rows} lignes dans le fichier.', { rows: result.rows })}{saved.vatMode === 'codes' ? ` ${t('{coded} avec code TVA, {explicit} avec lignes de TVA (taux mixtes ou code manquant).', { coded: result.coded, explicit: result.explicitVat })}` : ''}</p> : null}
          </div>
          {used.length ? (
            <details className="fiduciary-export__map">
              <summary>{t('Correspondance des comptes · {count}', { count: used.length })}</summary>
              <p>{t('Laissez vide pour garder le même numéro.')}</p>
              <ul>
                {used.map(([code, name]) => (
                  <li key={code}>
                    <span><strong>{code}</strong><small>{name}</small></span>
                    <input
                      aria-label={t('Numéro dans le logiciel de la fiduciaire pour {code}', { code })}
                      inputMode="numeric"
                      placeholder={code}
                      value={accountMap[code] ?? ''}
                      disabled={busy}
                      onChange={(event) => update({ accountMaps: { ...saved.accountMaps, [format]: { ...accountMap, [code]: event.target.value.trim().slice(0, 20) } } })}
                    />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {saved.vatMode === 'codes' && result.vatKeys.length ? (
            <details className="fiduciary-export__map" open={result.vatKeys.some((key) => !vatCodes[key])}>
              <summary>{t('Codes TVA · {count}', { count: result.vatKeys.length })}</summary>
              <ul>
                {result.vatKeys.map((key) => {
                  const [direction, rateBp] = key.split(':');
                  const label = t(direction === 'sales' ? 'Ventes à {rate} %' : 'Achats à {rate} %', { rate: percent(Number(rateBp)) });
                  return (
                    <li key={key}>
                      <span><strong>{label}</strong></span>
                      <input
                        aria-label={t('Code TVA pour {label}', { label })}
                        value={vatCodes[key] ?? ''}
                        disabled={busy}
                        onChange={(event) => update({ vatCodes: { ...saved.vatCodes, [format]: { ...(saved.vatCodes[format] ?? {}), [key]: event.target.value.trim().slice(0, 12) } } })}
                      />
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
          <p className="fiduciary-export__hint">{t(guides[format])}</p>
          <div className="erp-register__actions">
            <Button type="button" disabled={busy || !result.entries} onClick={() => void exportFile()}>{busy ? t('Enregistrement…') : t('Exporter le fichier')}</Button>
            {done ? <p role="status">{t('Fichier enregistré : {path}', { path: done })}</p> : null}
          </div>
        </>
      ) : !error && dateFrom <= dateTo ? <p role="status">{t('Lecture du journal…')}</p> : null}
    </section>
  );
}
