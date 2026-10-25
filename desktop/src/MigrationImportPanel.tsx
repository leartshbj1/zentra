import { useEffect, useMemo, useRef, useState } from 'react';
import { diagnosticInvoke as invoke } from './diagnostics';
import { FileUp } from 'lucide-react';
import { Button, ErrorPanel, Field } from './ui';
import {
  catalogHeaders,
  catalogMappingSource,
  type CatalogMappingSource,
} from './catalogImport';
import { deferView } from './DeferredView';
const CatalogImportWizard = deferView(() => import('./CatalogImportWizard').then(module => ({ default: module.CatalogImportWizard })), {
  label: { fr: 'Ouverture du catalogue…', de: 'Katalog wird geöffnet…', it: 'Apertura del catalogo…', en: 'Opening the catalogue…' }, diagnosticName: 'CatalogImportWizard', close: props => props.close,
});
import {
  contactFields,
  contactHeaderIndex,
  contactHeaderScore,
  defaultContactMapping,
  previewContacts,
  type ContactTarget,
} from './bexioImport';
import { desktopApi } from './bridge';
import { BexioOpenInvoices, BexioOpeningBalance } from './BexioOpeningImport';
import { ChartImportPanel } from './ChartImportPanel';
import { DataImportHistory, UndoImportButton, UndoReportView } from './DataImportHistory';
import type { UndoReport } from './dataImports';
import { migrationGuide, migrationKinds, migrationSources, sourceName, type MigrationKind, type MigrationSource } from './migrationSources';
import { refreshWorkspaceAfterMutation } from './workspaceMutation';
import type { Workspace } from './types';
import { errorMessage } from './utils';
import './BexioImportPanel.css';
import { t, useAppLanguage } from './language';

type ContactReceipt = { created: number; skipped: number; import_id: string };

/** Clients ou fournisseurs d'un export : aperçu, correspondance des colonnes, erreurs par ligne. */
function ContactImport({
  workspace,
  target,
  source,
  scope,
  disabled,
  workspaceScope,
  onWorkspace,
  onImported,
}: {
  workspace: Workspace;
  target: ContactTarget;
  source: MigrationSource;
  scope: string;
  disabled: boolean;
  workspaceScope?: string;
  onWorkspace: (workspace: Workspace) => void;
  onImported: () => void;
}) {
  useAppLanguage();
  const [file, setFile] = useState<CatalogMappingSource | null>(null),
    [header, setHeader] = useState(0),
    [mapping, setMapping] = useState<string[]>([]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<ContactReceipt | null>(null),
    [undone, setUndone] = useState<UndoReport | null>(null);
  const [page, setPage] = useState(0),
    [excluded, setExcluded] = useState<Set<number>>(new Set()),
    [onlyErrors, setOnlyErrors] = useState(false);
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const running = useRef(false),
    fileInput = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => {
    if (!file) return { rows: [], error: '' };
    try {
      return {
        rows: previewContacts(
          file,
          header,
          mapping,
          target,
          (target === 'clients' ? workspace.clients : workspace.suppliers).map((row) => row.name),
          sourceName(source),
        ),
        error: '',
      };
    } catch (reason) {
      return { rows: [], error: errorMessage(reason, 'Vérifiez les colonnes.') };
    }
  }, [file, header, mapping, target, source, workspace.clients, workspace.suppliers]);
  const selected = preview.rows.filter((row) => !row.duplicate && !excluded.has(row.line)),
    invalid = selected.filter((row) => row.errors.length > 0),
    locked = busy || disabled;
  const visible = onlyErrors ? preview.rows.filter((row) => row.errors.length > 0) : preview.rows;
  function reset() {
    setFile(null);
    setMapping([]);
    setReceipt(null);
    setUndone(null);
    setError('');
    setPage(0);
    setExcluded(new Set());
    setOnlyErrors(false);
  }
  async function inspect(next?: File) {
    if (!next || locked) return;
    setBusy(true);
    reset();
    try {
      const read = await catalogMappingSource(next, contactHeaderScore);
      const row = contactHeaderIndex(read);
      setFile(read);
      setHeader(row);
      setMapping(defaultContactMapping(catalogHeaders(read, row)));
    } catch (reason) {
      setError(errorMessage(reason, 'Choisissez un export Excel .xlsx ou CSV.'));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function refresh() {
    try {
      onWorkspace(await refreshWorkspaceAfterMutation(() => desktopApi.loadWorkspace()));
      setRefreshNeeded(false);
    } catch {
      setRefreshNeeded(true);
    }
  }
  async function confirm() {
    if (running.current || locked || invalid.length || !selected.length || !scope) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await desktopApi.importMigrationContacts(
        { source, fileName: file?.fileName },
        { scope, entity: target, rows: selected.map((row) => ({ line: row.line, data: row.data })) },
        workspaceScope,
      );
      setReceipt(result);
      onImported();
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, 'L’import n’a pas pu être confirmé. Vous pouvez réessayer : les fiches déjà présentes seront conservées.'));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  if (receipt) {
    return (
      <div role="status" className="bexio-import-receipt">
        <h3>{undone ? t('Import annulé') : t(receipt.created === 1 ? '{count} fiche ajoutée' : '{count} fiches ajoutées', { count: receipt.created })}</h3>
        {undone ? <UndoReportView report={undone} /> : <p>{t('{count} fiches déjà présentes, conservées sans modification.', { count: receipt.skipped })}</p>}
        {refreshNeeded ? (
          <>
            <p>{t('L’import est enregistré. Actualisez la liste pour le voir.')}</p>
            <Button onClick={() => void refresh()}>{t('Actualiser la liste')}</Button>
          </>
        ) : null}
        <div className="migration-receipt-actions">
          <Button variant="secondary" onClick={reset}>{t('Importer un autre fichier')}</Button>
          {!undone && receipt.created > 0 ? (
            <UndoImportButton importId={receipt.import_id} kind={target} disabled={disabled} expectedWorkspaceScope={workspaceScope} onUndone={(report, next) => { setUndone(report); onWorkspace(next); onImported(); }} />
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <>
      {error && <ErrorPanel message={error} />}
      <label className="bexio-import-file">
        <FileUp size={22} />
        <span>
          {busy ? t('Lecture en cours…') : file ? file.fileName : t('Choisir l’export de contacts')}
          <small>{t('Excel (.xlsx), CSV ou texte tabulé · 20 Mo maximum')}</small>
        </span>
        <input ref={fileInput} type="file" accept=".xlsx,.csv,.tsv,.txt" disabled={locked || !scope} onChange={(event) => void inspect(event.target.files?.[0])} />
      </label>
      {file && (
        <>
          <details className="bexio-import-mapping" open={!!preview.error}>
            <summary>{t('Vérifier les colonnes · ')}{file.sheetName}</summary>
            <Field label={t('Ligne des en-têtes')}>
              <select
                disabled={locked}
                value={header}
                onChange={(event) => {
                  const index = Number(event.target.value);
                  setHeader(index);
                  setMapping(defaultContactMapping(catalogHeaders(file, index)));
                  setExcluded(new Set());
                  setPage(0);
                }}
              >
                {file.rows.slice(0, 20).map((_, index) => <option key={index} value={index}>{t('Ligne {number}', { number: index + 1 })}</option>)}
              </select>
            </Field>
            <div>
              {catalogHeaders(file, header).map((label, index) => (
                <Field key={index} label={label || t('Colonne {number}', { number: index + 1 })}>
                  <select
                    disabled={locked}
                    value={mapping[index] ?? 'ignore'}
                    onChange={(event) => {
                      setMapping((current) => current.map((value, i) => (i === index ? event.target.value : value)));
                      setExcluded(new Set());
                      setPage(0);
                    }}
                  >
                    <option value="ignore">{t('Ne pas reprendre')}</option>
                    {Object.entries(contactFields).map(([key, title]) => <option key={key} value={key}>{t(title)}</option>)}
                  </select>
                </Field>
              ))}
            </div>
          </details>
          {preview.error ? <ErrorPanel message={preview.error} /> : (
            <>
              <div className="bexio-import-summary">
                <h3>{t('{count} fiches à ajouter', { count: selected.length })}</h3>
                <p>{t('{count} doublons possibles écartés. Les fiches qui portent déjà le même nom restent intactes.', { count: preview.rows.filter((row) => row.duplicate).length })}</p>
              </div>
              {invalid.length ? (
                <label className="migration-only-errors">
                  <input type="checkbox" checked={onlyErrors} onChange={(event) => { setOnlyErrors(event.target.checked); setPage(0); }} />
                  {t('Voir seulement les {count} lignes à corriger', { count: invalid.length })}
                </label>
              ) : null}
              <div className="bexio-import-rows">
                {visible.slice(page * 50, (page + 1) * 50).map((row) => (
                  <label key={row.line} className={row.duplicate ? 'is-skipped' : ''}>
                    <input
                      type="checkbox"
                      disabled={locked || row.duplicate}
                      checked={!row.duplicate && !excluded.has(row.line)}
                      onChange={() => setExcluded((current) => {
                        const next = new Set(current);
                        if (next.has(row.line)) next.delete(row.line); else next.add(row.line);
                        return next;
                      })}
                    />
                    <span>
                      <strong>{row.name || t('Ligne {number}', { number: row.line })}</strong>
                      <small>{row.email || row.address || t('Coordonnées non renseignées')}</small>
                      {row.errors.length > 0 && <span className="bexio-import-error">{row.errors.map((message) => t(message)).join(' · ')}</span>}
                    </span>
                    <small>{row.duplicate ? t('Déjà présent ou même nom') : t('Ligne {number}', { number: row.line })}</small>
                  </label>
                ))}
              </div>
              {visible.length > 50 && (
                <nav aria-label={t('Pages de l’import')}>
                  <Button variant="secondary" disabled={page === 0 || locked} onClick={() => setPage(page - 1)}>{t('Précédent')}</Button>
                  <span>{page + 1} / {Math.ceil(visible.length / 50)}</span>
                  <Button variant="secondary" disabled={(page + 1) * 50 >= visible.length || locked} onClick={() => setPage(page + 1)}>{t('Suivant')}</Button>
                </nav>
              )}
              {invalid.length > 0 && <p role="alert">{t('Corrigez les lignes indiquées dans votre fichier, ou décochez-les pour importer les autres.')}</p>}
              <Button disabled={locked || invalid.length > 0 || !selected.length || !scope} onClick={() => void confirm()}>
                {busy ? t('Import en cours…') : t(target === 'clients' ? 'Ajouter {count} clients' : 'Ajouter {count} fournisseurs', { count: selected.length })}
              </Button>
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * Reprendre ses données d'un autre logiciel : bexio, WinBIZ, Crésus, Banana,
 * AbaNinja/Swiss21 ou un fichier Excel/CSV. Chaque import est gardé dans
 * l'historique et peut être annulé.
 */
export function MigrationImportPanel({
  workspace,
  disabled,
  onWorkspace,
}: {
  workspace: Workspace;
  disabled: boolean;
  onWorkspace: (workspace: Workspace) => void;
}) {
  useAppLanguage();
  const originalWorkspaceScope = useRef(workspace.workNotesScope).current;
  const [source, setSource] = useState<MigrationSource>('bexio');
  const [target, setTarget] = useState<MigrationKind>('clients');
  const [scope, setScope] = useState('');
  const [scopeAttempt, setScopeAttempt] = useState(0);
  const [scopeStatus, setScopeStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalog, setCatalog] = useState(false);
  const [history, setHistory] = useState(0);
  // Un nouveau choix de logiciel ou de données repart d'un écran vide.
  const [session, setSession] = useState(0);
  useEffect(() => {
    let live = true;
    setScopeStatus('loading');
    invoke<string>('bexio_import_scope')
      .then((value) => { if (live) { setScope(value); setScopeStatus('ready'); } })
      .catch(() => { if (live) { setScope(''); setScopeStatus('error'); } });
    return () => { live = false; };
  }, [scopeAttempt]);
  const locked = disabled || scopeStatus !== 'ready';
  const imported = () => setHistory((value) => value + 1);
  const origin = { source };
  return (
    <section className="bexio-import">
      <header>
        <h2>{t('Reprendre vos données')}</h2>
        <p>{t('Retrouvez vos contacts, votre catalogue, votre plan comptable, vos factures ouvertes et vos soldes dans {company}.', { company: workspace.settings?.organization.legalName || t('cette entreprise') })}</p>
      </header>
      {scopeStatus === 'error' && <div className="bexio-import-retry" role="alert"><p>{t('L’entreprise n’a pas pu être vérifiée. Réessayez pour autoriser l’import. Aucune donnée n’a été ajoutée.')}</p><Button variant="secondary" disabled={disabled} onClick={() => setScopeAttempt(attempt => attempt + 1)}>{t('Réessayer la vérification')}</Button></div>}
      {scopeStatus === 'loading' && <p role="status">{t('Vérification de l’entreprise…')}</p>}
      <div className="migration-source">
        <Field label={t('Votre ancien logiciel')}>
          <select value={source} disabled={disabled} onChange={(event) => { setSource(event.target.value as MigrationSource); setSession((value) => value + 1); }}>
            {migrationSources.map((entry) => <option key={entry.id} value={entry.id}>{t(entry.name)}</option>)}
          </select>
        </Field>
      </div>
      <div className="bexio-import-choices" role="group" aria-label={t('Données à reprendre')}>
        {migrationKinds.map(({ id, label }) => (
          <Button
            key={id}
            variant={target === id ? 'primary' : 'secondary'}
            disabled={disabled}
            aria-pressed={target === id}
            onClick={() => { setTarget(id); setSession((value) => value + 1); }}
          >
            {t(label)}
          </Button>
        ))}
      </div>
      <details className="bexio-import-instructions"><summary>{t('Préparer l’export')}</summary><p>{t(migrationGuide(source, target))}</p></details>
      <p className="bexio-import-note">{t('Les pièces jointes et les stocks ne sont pas repris. Chaque import peut être annulé.')}</p>
      <div key={`${source}-${target}-${session}`}>
        {target === 'invoices' ? (
          <BexioOpenInvoices workspace={workspace} disabled={locked} onWorkspace={onWorkspace} origin={origin} onImported={imported} />
        ) : target === 'balance' ? (
          <BexioOpeningBalance disabled={locked} origin={origin} onImported={imported} />
        ) : target === 'accounts' ? (
          <ChartImportPanel disabled={locked} origin={origin} expectedWorkspaceScope={originalWorkspaceScope} onImported={imported} />
        ) : target === 'catalog' ? (
          <>
            <p>{t('Vérifiez les prix hors taxe en CHF et les taux de TVA. Si l’export utilise un code TVA, remplacez-le par son taux avant de confirmer.')}</p>
            <Button disabled={locked} onClick={() => setCatalog(true)}><FileUp size={18} />{t('Choisir le catalogue')}</Button>
          </>
        ) : (
          <ContactImport workspace={workspace} target={target} source={source} scope={scope} disabled={locked} workspaceScope={originalWorkspaceScope} onWorkspace={onWorkspace} onImported={imported} />
        )}
      </div>
      <DataImportHistory refreshKey={history} disabled={locked} expectedWorkspaceScope={originalWorkspaceScope} onWorkspace={onWorkspace} />
      {source === 'bexio' ? (
        <a className="bexio-import-help" href="https://zentraapp.ch/comparatif/bexio#importer" target="_blank" rel="noreferrer">{t('Consulter le guide d’import')}</a>
      ) : null}
      {catalog && (
        <CatalogImportWizard
          workspaceScope={originalWorkspaceScope}
          migration
          existingItems={workspace.catalogItems}
          vatRatesBp={workspace.settings?.billing.vatRatesBp ?? [810, 260, 380, 0]}
          busy={disabled}
          close={() => setCatalog(false)}
          onImport={async (rows, policy, onError, expectedWorkspaceScope) => {
            try {
              const next = await desktopApi.importMigrationCatalog({ source }, rows, policy, expectedWorkspaceScope);
              onWorkspace(next);
              imported();
              return true;
            } catch (reason) {
              onError?.(reason);
              return false;
            }
          }}
        />
      )}
    </section>
  );
}
