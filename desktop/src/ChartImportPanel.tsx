import { useEffect, useMemo, useState } from 'react';
import { Button, ErrorPanel } from './ui';
import { MappedFile, type Mapped } from './BexioOpeningImport';
import { UndoImportButton, UndoReportView } from './DataImportHistory';
import {
  accountTypeLabels,
  chartFields,
  chartHeaderIndex,
  chartHeaderScore,
  chartImportRows,
  defaultChartMapping,
  previewChart,
} from './chartImport';
import type { UndoReport } from './dataImports';
import { desktopApi } from './bridge';
import type { ImportOrigin } from './migrationSources';
import type { AccountType } from './types';
import { errorMessage } from './utils';
import { t, useAppLanguage } from './language';

const natures = Object.keys(accountTypeLabels) as AccountType[];

/** Plan comptable d'un autre logiciel : seuls les comptes absents sont ajoutés. */
export function ChartImportPanel({ disabled, origin, expectedWorkspaceScope, onImported }: { disabled: boolean; origin: ImportOrigin; expectedWorkspaceScope?: string; onImported?: () => void }) {
  useAppLanguage();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mapped, setMapped] = useState<Mapped | null>(null);
  const [overrides, setOverrides] = useState<Record<number, AccountType>>({});
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ created: number; skipped: number; import_id: string } | null>(null);
  const [undone, setUndone] = useState<UndoReport | null>(null);
  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    desktopApi
      .listAccounts()
      .then((accounts) => { if (live) setCodes(accounts.map((account) => account.code)); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [attempt, receipt]);
  const preview = useMemo(() => {
    if (!mapped || !codes) return { rows: [], error: '' };
    try {
      return { rows: previewChart(mapped.source, mapped.header, mapped.mapping, codes, overrides), error: '' };
    } catch (reason) {
      return { rows: [], error: errorMessage(reason, 'Vérifiez les colonnes.') };
    }
  }, [mapped, codes, overrides]);
  const candidates = preview.rows.filter((row) => !row.skipped);
  const selected = candidates.filter((row) => !excluded.has(row.line));
  const invalid = selected.filter((row) => row.errors.length > 0);
  const locked = busy || disabled;
  const shown = (onlyErrors ? preview.rows.filter((row) => row.errors.length) : preview.rows).slice(0, 300);
  function reset() {
    setMapped(null);
    setOverrides({});
    setExcluded(new Set());
    setOnlyErrors(false);
    setReceipt(null);
    setUndone(null);
  }
  async function confirm() {
    if (locked || invalid.length || !selected.length) return;
    setBusy(true);
    setError('');
    try {
      const result = await desktopApi.importMigrationAccounts({ ...origin, fileName: mapped?.source.fileName }, chartImportRows(selected), expectedWorkspaceScope);
      setReceipt(result);
      onImported?.();
    } catch (reason) {
      setError(errorMessage(reason, 'Le plan comptable n’a pas pu être repris. Rien n’a été ajouté : vous pouvez réessayer.'));
    } finally {
      setBusy(false);
    }
  }
  if (loadFailed) {
    return (
      <div className="bexio-import-retry" role="alert">
        <p>{t('Le plan comptable actuel n’a pas pu être lu. Réessayez pour comparer les comptes.')}</p>
        <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>{t('Réessayer')}</Button>
      </div>
    );
  }
  if (receipt) {
    return (
      <div role="status" className="bexio-import-receipt">
        <h3>{undone ? t('Import annulé') : t(receipt.created === 1 ? '{count} compte ajouté' : '{count} comptes ajoutés', { count: receipt.created })}</h3>
        {undone ? <UndoReportView report={undone} /> : (
          <p>{t('{count} comptes déjà présents, gardés tels quels.', { count: receipt.skipped })}</p>
        )}
        <div className="migration-receipt-actions">
          <Button variant="secondary" onClick={reset}>{t('Importer un autre fichier')}</Button>
          {!undone && receipt.created > 0 ? <UndoImportButton importId={receipt.import_id} kind="accounts" disabled={disabled} expectedWorkspaceScope={expectedWorkspaceScope} onUndone={(report) => { setUndone(report); onImported?.(); }} /> : null}
        </div>
      </div>
    );
  }
  return (
    <>
      <p className="bexio-opening-intro">{t('Zentra ajoute les comptes qui manquent à votre plan. Un numéro déjà présent n’est ni renommé ni reclassé. La nature de chaque compte vient du fichier ou de son numéro dans le plan PME suisse.')}</p>
      {error ? <ErrorPanel message={error} /> : null}
      <MappedFile
        label="Choisir le plan comptable"
        fields={chartFields}
        mapped={mapped}
        disabled={locked || !codes}
        defaults={defaultChartMapping}
        score={chartHeaderScore}
        headerIndex={chartHeaderIndex}
        onChange={(next) => { setMapped(next); setOverrides({}); setExcluded(new Set()); setOnlyErrors(false); }}
        onError={setError}
      />
      {mapped ? preview.error ? <ErrorPanel message={preview.error} /> : (
        <>
          <div className="bexio-import-summary">
            <h3>{t('{count} comptes à ajouter', { count: selected.length })}</h3>
            <p>{t(preview.rows.length - candidates.length === 1 ? '{count} ligne écartée : titre, groupe ou compte déjà présent.' : '{count} lignes écartées : titres, groupes ou comptes déjà présents.', { count: preview.rows.length - candidates.length })}</p>
          </div>
          {invalid.length ? (
            <label className="migration-only-errors">
              <input type="checkbox" checked={onlyErrors} onChange={(event) => setOnlyErrors(event.target.checked)} />
              {t(invalid.length === 1 ? 'Voir seulement la ligne à corriger' : 'Voir seulement les {count} lignes à corriger', { count: invalid.length })}
            </label>
          ) : null}
          <div className="bexio-import-rows">
            {shown.map((row) => (
              <label key={row.line} className={row.skipped ? 'is-skipped' : ''}>
                <input
                  type="checkbox"
                  disabled={locked || Boolean(row.skipped)}
                  checked={!row.skipped && !excluded.has(row.line)}
                  onChange={() => setExcluded((current) => {
                    const next = new Set(current);
                    if (next.has(row.line)) next.delete(row.line); else next.add(row.line);
                    return next;
                  })}
                />
                <span>
                  <strong>{[row.code, row.name].filter(Boolean).join(' · ') || t('Ligne {number}', { number: row.line })}</strong>
                  {row.class ? <small>{t(accountTypeLabels[row.class.accountType])}</small> : null}
                  {row.errors.length ? <span className="bexio-import-error">{row.errors.map((message) => t(message)).join(' · ')}</span> : null}
                </span>
                {row.skipped ? <small>{t(row.skipped)}</small> : (
                  <select
                    aria-label={t('Nature du compte {code}', { code: row.code })}
                    disabled={locked}
                    value={row.class?.accountType ?? ''}
                    onChange={(event) => setOverrides((current) => ({ ...current, [row.line]: event.target.value as AccountType }))}
                  >
                    {!row.class ? <option value="">{t('Choisir la nature')}</option> : null}
                    {natures.map((nature) => <option key={nature} value={nature}>{t(accountTypeLabels[nature])}</option>)}
                  </select>
                )}
              </label>
            ))}
          </div>
          {preview.rows.length > shown.length && !onlyErrors ? <p className="bexio-import-note">{t('Les 300 premières lignes sont affichées ; toutes seront reprises.')}</p> : null}
          {invalid.length ? <p role="alert">{t('Corrigez les lignes indiquées, ou décochez-les pour importer les autres.')}</p> : null}
          <Button disabled={locked || invalid.length > 0 || !selected.length} onClick={() => void confirm()}>
            {busy ? t('Import en cours…') : t('Ajouter {count} comptes', { count: selected.length })}
          </Button>
        </>
      ) : null}
    </>
  );
}
