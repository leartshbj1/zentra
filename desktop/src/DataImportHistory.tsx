import { useEffect, useState } from 'react';
import { Button, ErrorPanel } from './ui';
import { desktopApi } from './bridge';
import { canUndo, dataImportKindLabels, importSummary, undoExplanation, type DataImport, type DataImportKind, type UndoReport } from './dataImports';
import { sourceName } from './migrationSources';
import type { Workspace } from './types';
import { errorMessage, formatDate } from './utils';
import { t, useAppLanguage } from './language';

/** Ce que l'annulation a fait, en clair, avec les fiches gardées et pourquoi. */
export function UndoReportView({ report }: { report: UndoReport }) {
  useAppLanguage();
  const parts = [
    report.removed ? t(report.removed === 1 ? '{count} retirée' : '{count} retirées', { count: report.removed }) : '',
    report.restored ? t(report.restored === 1 ? '{count} rétablie' : '{count} rétablies', { count: report.restored }) : '',
    report.reversed ? t(report.reversed === 1 ? '{count} écriture extournée' : '{count} écritures extournées', { count: report.reversed }) : '',
  ].filter(Boolean);
  return (
    <div className="migration-undo-report" role="status">
      <p>{parts.length ? parts.join(' · ') : t('Rien à retirer : tout avait déjà été supprimé.')}</p>
      {report.kept.length ? (
        <>
          <p>{t(report.kept.length === 1 ? '{count} fiche gardée parce qu’elle sert déjà :' : '{count} fiches gardées parce qu’elles servent déjà :', { count: report.kept.length })}</p>
          <ul>
            {report.kept.slice(0, 50).map((item) => <li key={`${item.entity}-${item.id}`}>{item.name || item.id} <small>{t(item.reason)}</small></li>)}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Annuler un import, avec ce que cela fera dit avant de confirmer. */
export function UndoImportButton({
  importId,
  kind,
  disabled,
  expectedWorkspaceScope,
  onUndone,
}: {
  importId: string;
  kind: DataImportKind;
  disabled: boolean;
  expectedWorkspaceScope?: string;
  onUndone: (report: UndoReport, workspace: Workspace) => void;
}) {
  useAppLanguage();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function undo() {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      const result = await desktopApi.undoDataImport(importId, expectedWorkspaceScope);
      setAsking(false);
      onUndone(result.report, result.workspace);
    } catch (reason) {
      setError(errorMessage(reason, 'L’import n’a pas pu être annulé. Rien n’a été changé.'));
    } finally {
      setBusy(false);
    }
  }
  if (!asking) {
    return <Button variant="secondary" disabled={disabled} onClick={() => setAsking(true)}>{t('Annuler cet import')}</Button>;
  }
  return (
    <div className="migration-undo-confirm">
      <p>{t(undoExplanation(kind))}</p>
      {error ? <ErrorPanel message={error} /> : null}
      <div>
        <Button variant="danger" disabled={busy || disabled} onClick={() => void undo()}>{busy ? t('Annulation…') : t('Annuler l’import')}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => { setAsking(false); setError(''); }}>{t('Garder')}</Button>
      </div>
    </div>
  );
}

/** Imports précédents : quand, d'où, combien, et Annuler tant que c'est possible. */
export function DataImportHistory({
  refreshKey,
  disabled,
  expectedWorkspaceScope,
  onWorkspace,
}: {
  refreshKey: number;
  disabled: boolean;
  expectedWorkspaceScope?: string;
  onWorkspace: (workspace: Workspace) => void;
}) {
  useAppLanguage();
  const [imports, setImports] = useState<DataImport[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [reports, setReports] = useState<Record<string, UndoReport>>({});
  useEffect(() => {
    let live = true;
    setFailed(false);
    desktopApi
      .listDataImports()
      .then((next) => { if (live) setImports(next); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [refreshKey, reload]);
  if (failed) {
    return (
      <section className="migration-history">
        <h3>{t('Imports précédents')}</h3>
        <p>{t('L’historique n’a pas pu être lu.')}</p>
        <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>{t('Réessayer')}</Button>
      </section>
    );
  }
  if (!imports?.length) return null;
  return (
    <section className="migration-history" aria-labelledby="migration-history-title">
      <h3 id="migration-history-title">{t('Imports précédents')}</h3>
      <ul>
        {imports.map((entry) => (
          <li key={entry.id}>
            <div>
              <strong>{t(dataImportKindLabels[entry.kind])} · {t(sourceName(entry.source))}</strong>
              <small>
                {[formatDate(entry.createdAt), ...importSummary(entry).map((part) => t(part.message, { count: part.count })), entry.fileName].filter(Boolean).join(' · ')}
              </small>
              {entry.undoneAt ? <small>{t('Annulé le {date}', { date: formatDate(entry.undoneAt) })}</small> : null}
              {reports[entry.id] ? <UndoReportView report={reports[entry.id]} /> : entry.undoReport?.kept.length ? <UndoReportView report={entry.undoReport} /> : null}
            </div>
            {canUndo(entry) ? (
              <UndoImportButton
                importId={entry.id}
                kind={entry.kind}
                disabled={disabled}
                expectedWorkspaceScope={expectedWorkspaceScope}
                onUndone={(report, workspace) => {
                  setReports((current) => ({ ...current, [entry.id]: report }));
                  onWorkspace(workspace);
                  setReload((value) => value + 1);
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
