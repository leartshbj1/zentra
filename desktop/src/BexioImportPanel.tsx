import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
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

export function BexioImportPanel({
  workspace,
  disabled,
  onWorkspace,
}: {
  workspace: Workspace;
  disabled: boolean;
  onWorkspace: (workspace: Workspace) => void;
}) {
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
  const running = useRef(false),
    fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    invoke<string>('bexio_import_scope')
      .then((value) => {
        if (live) setScope(value);
      })
      .catch((reason) => {
        if (live)
          setError(
            errorMessage(reason, 'Rouvrez l’import depuis votre entreprise.'),
          );
      });
    return () => {
      live = false;
    };
  }, []);
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
        <h2>Reprendre vos données bexio</h2>
        <p>
          Retrouvez vos contacts et votre catalogue dans{' '}
          {workspace.settings?.organization.legalName || 'cette entreprise'}.
        </p>
      </header>
      {error && <ErrorPanel message={error} />}
      {receipt ? (
        <div role="status" className="bexio-import-receipt">
          <h3>
            {receipt.created} fiche{receipt.created > 1 ? 's' : ''} ajoutée
            {receipt.created > 1 ? 's' : ''}
          </h3>
          <p>
            {receipt.skipped} fiche{receipt.skipped > 1 ? 's' : ''} déjà
            présente{receipt.skipped > 1 ? 's' : ''}, conservée
            {receipt.skipped > 1 ? 's' : ''} sans modification.
          </p>
          {refreshNeeded ? (
            <>
              <p>L’import est enregistré. Actualisez la liste pour le voir.</p>
              <Button onClick={() => void refresh()}>
                Actualiser la liste
              </Button>
            </>
          ) : null}
          <Button variant="secondary" onClick={reset}>
            Importer un autre fichier
          </Button>
        </div>
      ) : (
        <>
          <div
            className="bexio-import-choices"
            role="group"
            aria-label="Données à reprendre"
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
                {label}
              </Button>
            ))}
          </div>
          <p>
            Dans bexio, exportez la liste souhaitée au format Excel. Séparez vos
            clients et vos fournisseurs à l’aide du filtre Catégorie. Choisissez
            les adresses principales.
          </p>
          <p className="bexio-import-note">
            Les factures, écritures, soldes, pièces jointes et stocks ne sont
            pas repris par cet import.
          </p>
          {target === 'catalog' ? (
            <>
              <p>
                Vérifiez les prix hors taxe en CHF et les taux de TVA. Si
                l’export utilise un code TVA, remplacez-le par son taux avant de
                confirmer.
              </p>
              <Button disabled={locked} onClick={() => setCatalog(true)}>
                <FileUp size={18} />
                Choisir le catalogue
              </Button>
            </>
          ) : (
            <>
              <label className="bexio-import-file">
                <FileUp size={22} />
                <span>
                  {busy
                    ? 'Lecture en cours…'
                    : source
                      ? source.fileName
                      : 'Choisir l’export de contacts'}
                  <small>Excel (.xlsx) ou CSV · 20 Mo maximum</small>
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
                    <summary>
                      Vérifier les colonnes · {source.sheetName}
                    </summary>
                    <Field label="Ligne des en-têtes">
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
                          <option key={index} value={index}>
                            Ligne {index + 1}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div>
                      {catalogHeaders(source, header).map((label, index) => (
                        <Field
                          key={index}
                          label={label || `Colonne ${index + 1}`}
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
                            <option value="ignore">Ne pas reprendre</option>
                            {Object.entries(contactFields).map(
                              ([key, title]) => (
                                <option key={key} value={key}>
                                  {title}
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
                          {selected.length} fiche
                          {selected.length > 1 ? 's' : ''} à ajouter
                        </h3>
                        <p>
                          {preview.rows.filter((row) => row.duplicate).length}{' '}
                          doublon
                          {preview.rows.filter((row) => row.duplicate).length >
                          1
                            ? 's'
                            : ''}{' '}
                          possible
                          {preview.rows.filter((row) => row.duplicate).length >
                          1
                            ? 's'
                            : ''}{' '}
                          écarté
                          {preview.rows.filter((row) => row.duplicate).length >
                          1
                            ? 's'
                            : ''}
                          . Les fiches qui portent déjà le même nom restent
                          intactes.
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
                                  {row.name || `Ligne ${row.line}`}
                                </strong>
                                <small>
                                  {row.email ||
                                    row.address ||
                                    'Coordonnées non renseignées'}
                                </small>
                                {row.errors.length > 0 && (
                                  <span className="bexio-import-error">
                                    {row.errors.join(' · ')}
                                  </span>
                                )}
                              </span>
                              <small>
                                {row.duplicate
                                  ? 'Déjà présent ou même nom'
                                  : `Ligne ${row.line}`}
                              </small>
                            </label>
                          ))}
                      </div>
                      {preview.rows.length > 50 && (
                        <nav aria-label="Pages de l’import">
                          <Button
                            variant="secondary"
                            disabled={page === 0 || locked}
                            onClick={() => setPage(page - 1)}
                          >
                            Précédent
                          </Button>
                          <span>
                            {page + 1} / {Math.ceil(preview.rows.length / 50)}
                          </span>
                          <Button
                            variant="secondary"
                            disabled={
                              (page + 1) * 50 >= preview.rows.length || locked
                            }
                            onClick={() => setPage(page + 1)}
                          >
                            Suivant
                          </Button>
                        </nav>
                      )}
                      {invalid && (
                        <p role="alert">
                          Corrigez les lignes indiquées dans votre fichier, ou
                          décochez-les pour importer les autres.
                        </p>
                      )}
                      <Button
                        disabled={
                          locked || invalid || !selected.length || !scope
                        }
                        onClick={() => void confirm()}
                      >
                        {busy
                          ? 'Import en cours…'
                          : `Ajouter ${selected.length} ${target === 'clients' ? 'client' : 'fournisseur'}${selected.length > 1 ? 's' : ''}`}
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
      >
        Consulter le guide d’import
      </a>
      {catalog && (
        <CatalogImportWizard
          migration
          existingItems={workspace.catalogItems}
          vatRatesBp={
            workspace.settings?.billing.vatRatesBp ?? [810, 260, 380, 0]
          }
          busy={disabled}
          close={() => setCatalog(false)}
          onImport={async (rows, policy, onError) => {
            try {
              const next = await desktopApi.importCatalogItems(rows, policy);
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
