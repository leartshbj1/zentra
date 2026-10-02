import { useEffect, useMemo, useRef, useState } from 'react';
import { diagnosticInvoke as invoke } from './diagnostics';
import { FileUp } from 'lucide-react';
import { Button, ErrorPanel, Field } from './ui';
import {
  catalogHeaders,
  catalogMappingSource,
  type CatalogMappingSource,
} from './catalogImport';
import { CatalogImportWizard } from './CatalogImportWizard';
import {
  contactFields,
  contactHeaderIndex,
  defaultContactMapping,
  previewContacts,
  type ContactTarget,
  type BexioReceipt,
} from './bexioImport';
import { desktopApi } from './bridge';
import { refreshWorkspaceAfterMutation } from './workspaceMutation';
import type { Workspace } from './types';
import { errorMessage } from './utils';
import './BexioImportPanel.css';
import { t, useAppLanguage } from './language';

export function BexioImportPanel({
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
  const [target, setTarget] = useState<ContactTarget | 'catalog'>('clients');
  const [source, setSource] = useState<CatalogMappingSource | null>(null),
    [header, setHeader] = useState(0),
    [mapping, setMapping] = useState<string[]>([]);
  const [scope, setScope] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<BexioReceipt | null>(null);
  const [catalog, setCatalog] = useState(false),
    [page, setPage] = useState(0),
    [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [scopeAttempt, setScopeAttempt] = useState(0);
  const [scopeStatus, setScopeStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const running = useRef(false),
    fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    setScopeStatus('loading');
    invoke<string>('bexio_import_scope')
      .then((value) => {
        if (live) { setScope(value); setScopeStatus('ready'); }
      })
      .catch(() => {
        if (live) { setScope(''); setScopeStatus('error'); }
      });
    return () => {
      live = false;
    };
  }, [scopeAttempt]);
  const preview = useMemo(() => {
    if (!source || target === 'catalog') return { rows: [], error: '' };
    try {
      return {
        rows: previewContacts(
          source,
          header,
          mapping,
          target,
          (target === 'clients' ? workspace.clients : workspace.suppliers).map(
            (row) => row.name,
          ),
        ),
        error: '',
      };
    } catch (reason) {
      return {
        rows: [],
        error: errorMessage(reason, 'Vérifiez les colonnes.'),
      };
    }
  }, [source, header, mapping, target, workspace.clients, workspace.suppliers]);
  const selected = preview.rows.filter(
      (row) => !row.duplicate && !excluded.has(row.line),
    ),
    invalid = selected.some((row) => row.errors.length > 0),
    locked = busy || disabled;
  function reset() {
    setSource(null);
    setMapping([]);
    setReceipt(null);
    setError('');
    setPage(0);
    setExcluded(new Set());
  }
  async function inspect(file?: File) {
    if (!file || locked) return;
    setBusy(true);
    reset();
    try {
      const next = await catalogMappingSource(file);
      const row = contactHeaderIndex(next);
      setSource(next);
      setHeader(row);
      setMapping(defaultContactMapping(catalogHeaders(next, row)));
    } catch (reason) {
      setError(
        errorMessage(reason, 'Choisissez un export Excel .xlsx ou CSV.'),
      );
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function refresh() {
    try {
      const next = await refreshWorkspaceAfterMutation(() =>
        desktopApi.loadWorkspace(),
      );
      onWorkspace(next);
      setRefreshNeeded(false);
    } catch {
      setRefreshNeeded(true);
    }
  }
  async function confirm() {
    if (
      running.current ||
      locked ||
      invalid ||
      !selected.length ||
      !scope ||
      target === 'catalog'
    )
      return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await invoke<BexioReceipt>('import_bexio_contacts', {
        ...(originalWorkspaceScope === undefined ? {} : { expectedWorkspaceScope: originalWorkspaceScope }),
        input: {
          scope,
          entity: target,
          rows: selected.map((row) => ({ line: row.line, data: row.data })),
        },
      });
      setReceipt(result);
      await refresh();
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          'L’import n’a pas pu être confirmé. Vous pouvez réessayer : les fiches déjà présentes seront conservées.',
        ),
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="bexio-import">
      <header>
        <h2>{t("Reprendre vos données bexio")}</h2>
        <p>
          {t('Retrouvez vos contacts et votre catalogue dans {company}.', { company: workspace.settings?.organization.legalName || t('cette entreprise') })}
        </p>
      </header>
      {error && <ErrorPanel message={error} />}
      {scopeStatus === 'error' && <div className="bexio-import-retry" role="alert"><p>{t('L’entreprise n’a pas pu être vérifiée. Réessayez pour autoriser l’import. Aucune donnée n’a été ajoutée.')}</p><Button variant="secondary" disabled={locked} onClick={() => setScopeAttempt(attempt => attempt + 1)}>{t('Réessayer la vérification')}</Button></div>}
      {scopeStatus === 'loading' && <p role="status">{t('Vérification de l’entreprise…')}</p>}
      {receipt ? (
        <div role="status" className="bexio-import-receipt">
          <h3>
            {t(receipt.created === 1 ? '{count} fiche ajoutée' : '{count} fiches ajoutées', { count: receipt.created })}
          </h3>
          <p>
            {t('{count} fiches déjà présentes, conservées sans modification.', { count: receipt.skipped })}
          </p>
          {refreshNeeded ? (
            <>
              <p>{t("L’import est enregistré. Actualisez la liste pour le voir.")}</p>
              <Button onClick={() => void refresh()}>{t("Actualiser la liste")}</Button>
            </>
          ) : null}
          <Button variant="secondary" onClick={reset}>{t("Importer un autre fichier")}</Button>
        </div>
      ) : (
        <>
          <div
            className="bexio-import-choices"
            role="group"
            aria-label={t("Données à reprendre")}
          >
            {(
              [
                ['clients', 'Clients'],
                ['suppliers', 'Fournisseurs'],
                ['catalog', 'Articles et services'],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                variant={target === key ? 'primary' : 'secondary'}
                disabled={locked}
                aria-pressed={target === key}
                onClick={() => {
                  reset();
                  setTarget(key);
                }}
              >
                {t(label)}
              </Button>
            ))}
          </div>
          <details className="bexio-import-instructions"><summary>{t("Préparer l’export bexio")}</summary><p>{t("Dans bexio, exportez la liste souhaitée au format Excel. Séparez vos clients et vos fournisseurs à l’aide du filtre Catégorie. Choisissez les adresses principales.")}</p></details>
          <p className="bexio-import-note">{t("Les factures, écritures, soldes, pièces jointes et stocks ne sont pas repris par cet import.")}</p>
          {target === 'catalog' ? (
            <>
              <p>{t("Vérifiez les prix hors taxe en CHF et les taux de TVA. Si l’export utilise un code TVA, remplacez-le par son taux avant de confirmer.")}</p>
              <Button disabled={locked} onClick={() => setCatalog(true)}>
                <FileUp size={18} />{t("Choisir le catalogue")}</Button>
            </>
          ) : (
            <>
              <label className="bexio-import-file">
                <FileUp size={22} />
                <span>
                  {busy
                    ? t("Lecture en cours…")
                    : source
                      ? source.fileName
                      : t("Choisir l’export de contacts")}
                  <small>{t("Excel (.xlsx) ou CSV · 20 Mo maximum")}</small>
                </span>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".xlsx,.csv,.tsv"
                  disabled={locked || !scope}
                  onChange={(event) => void inspect(event.target.files?.[0])}
                />
              </label>
              {source && (
                <>
                  <details
                    className="bexio-import-mapping"
                    open={!!preview.error}
                  >
                    <summary>{t("Vérifier les colonnes · ")}{source.sheetName}
                    </summary>
                    <Field label={t("Ligne des en-têtes")}>
                      <select
                        disabled={locked}
                        value={header}
                        onChange={(event) => {
                          const index = Number(event.target.value);
                          setHeader(index);
                          setMapping(
                            defaultContactMapping(
                              catalogHeaders(source, index),
                            ),
                          );
                          setExcluded(new Set());
                          setPage(0);
                        }}
                      >
                        {source.rows.slice(0, 20).map((_, index) => (
                          <option key={index} value={index}>{t('Ligne {number}', { number: index + 1 })}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div>
                      {catalogHeaders(source, header).map((label, index) => (
                        <Field
                          key={index}
                          label={label || t('Colonne {number}', { number: index + 1 })}
                        >
                          <select
                            disabled={locked}
                            value={mapping[index] ?? 'ignore'}
                            onChange={(event) => {
                              setMapping((current) =>
                                current.map((value, i) =>
                                  i === index ? event.target.value : value,
                                ),
                              );
                              setExcluded(new Set());
                              setPage(0);
                            }}
                          >
                            <option value="ignore">{t("Ne pas reprendre")}</option>
                            {Object.entries(contactFields).map(
                              ([key, title]) => (
                                <option key={key} value={key}>
                                  {t(title)}
                                </option>
                              ),
                            )}
                          </select>
                        </Field>
                      ))}
                    </div>
                  </details>
                  {preview.error ? (
                    <ErrorPanel message={preview.error} />
                  ) : (
                    <>
                      <div className="bexio-import-summary">
                        <h3>
                          {t('{count} fiches à ajouter', { count: selected.length })}
                        </h3>
                        <p>
                          {t('{count} doublons possibles écartés. Les fiches qui portent déjà le même nom restent intactes.', { count: preview.rows.filter(row => row.duplicate).length })}
                        </p>
                      </div>
                      <div className="bexio-import-rows">
                        {preview.rows
                          .slice(page * 50, (page + 1) * 50)
                          .map((row) => (
                            <label
                              key={row.line}
                              className={row.duplicate ? 'is-skipped' : ''}
                            >
                              <input
                                type="checkbox"
                                disabled={locked || row.duplicate}
                                checked={
                                  !row.duplicate && !excluded.has(row.line)
                                }
                                onChange={() =>
                                  setExcluded((current) => {
                                    const next = new Set(current);
                                    next.has(row.line)
                                      ? next.delete(row.line)
                                      : next.add(row.line);
                                    return next;
                                  })
                                }
                              />
                              <span>
                                <strong>
                                  {row.name || t('Ligne {number}', { number: row.line })}
                                </strong>
                                <small>
                                  {row.email ||
                                    row.address ||
                                    t('Coordonnées non renseignées')}
                                </small>
                                {row.errors.length > 0 && (
                                  <span className="bexio-import-error">
                                    {row.errors.map(message => t(message)).join(' · ')}
                                  </span>
                                )}
                              </span>
                              <small>
                                {row.duplicate
                                  ? t('Déjà présent ou même nom')
                                  : t('Ligne {number}', { number: row.line })}
                              </small>
                            </label>
                          ))}
                      </div>
                      {preview.rows.length > 50 && (
                        <nav aria-label={t("Pages de l’import")}>
                          <Button
                            variant="secondary"
                            disabled={page === 0 || locked}
                            onClick={() => setPage(page - 1)}
                          >{t("Précédent")}</Button>
                          <span>
                            {page + 1} / {Math.ceil(preview.rows.length / 50)}
                          </span>
                          <Button
                            variant="secondary"
                            disabled={
                              (page + 1) * 50 >= preview.rows.length || locked
                            }
                            onClick={() => setPage(page + 1)}
                          >{t("Suivant")}</Button>
                        </nav>
                      )}
                      {invalid && (
                        <p role="alert">{t("Corrigez les lignes indiquées dans votre fichier, ou décochez-les pour importer les autres.")}</p>
                      )}
                      <Button
                        disabled={
                          locked || invalid || !selected.length || !scope
                        }
                        onClick={() => void confirm()}
                      >
                        {busy
                          ? t("Import en cours…")
                          : t(target === 'clients' ? 'Ajouter {count} clients' : 'Ajouter {count} fournisseurs', { count: selected.length })}
                      </Button>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      <a
        className="bexio-import-help"
        href="https://zentraapp.ch/comparatif/bexio#importer"
        target="_blank"
        rel="noreferrer"
      >{t("Consulter le guide d’import")}</a>
      {catalog && (
        <CatalogImportWizard
          workspaceScope={originalWorkspaceScope}
          migration
          existingItems={workspace.catalogItems}
          vatRatesBp={
            workspace.settings?.billing.vatRatesBp ?? [810, 260, 380, 0]
          }
          busy={disabled}
          close={() => setCatalog(false)}
          onImport={async (rows, policy, onError, expectedWorkspaceScope) => {
            try {
              const next = await desktopApi.importCatalogItems(rows, policy, expectedWorkspaceScope);
              onWorkspace(next);
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
