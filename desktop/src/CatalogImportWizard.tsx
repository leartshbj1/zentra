import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload, X } from 'lucide-react';
import {
  CATALOG_IMPORT_MAX_BYTES,
  applyCatalogVatFallback,
  previewCatalogFile,
  type CatalogImportPreview,
  type CatalogImportRow,
} from './catalogImport';
import type { CatalogItem } from './types';
import { formatMoney } from './utils';
import { Button, Field, Modal } from './ui';

export type CatalogImportConflictPolicy = 'update' | 'skip';

export function CatalogImportWizard({
  existingItems,
  vatRatesBp,
  busy,
  close,
  onImport,
}: {
  existingItems: CatalogItem[];
  vatRatesBp: number[];
  busy: boolean;
  close: () => void;
  onImport: (
    rows: CatalogImportRow[],
    conflictPolicy: CatalogImportConflictPolicy,
  ) => Promise<boolean>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);
  const [error, setError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [conflictPolicy, setConflictPolicy] =
    useState<CatalogImportConflictPolicy>('update');
  const [fallbackVatBp, setFallbackVatBp] = useState(vatRatesBp[0] ?? 0);
  const existingBySku = useMemo(() => {
    const result = new Map<string, CatalogItem[]>();
    for (const item of existingItems) {
      const key = item.sku?.trim().toLocaleLowerCase('fr-CH');
      if (!key) continue;
      result.set(key, [...(result.get(key) ?? []), item]);
    }
    return result;
  }, [existingItems]);
  const rows = preview?.rows ?? [];
  const rowsMissingVat = rows.filter(
    (row) => row.vatBp === null && !row.errors.includes('Taux TVA invalide'),
  );
  const importedRows = applyCatalogVatFallback(rows, fallbackVatBp);
  const invalidRows = rows.filter((row) => row.errors.length > 0);
  const ambiguousRows = rows.filter(
    (row) => (existingBySku.get(row.sku.toLocaleLowerCase('fr-CH'))?.length ?? 0) > 1,
  );
  const updates = rows.filter(
    (row) => (existingBySku.get(row.sku.toLocaleLowerCase('fr-CH'))?.length ?? 0) === 1,
  ).length;
  const creates = rows.length - updates - ambiguousRows.length;
  const ready = Boolean(preview && rows.length && !invalidRows.length && !ambiguousRows.length);

  async function inspectFile(file: File | undefined) {
    if (!file) return;
    setError('');
    setPreview(null);
    setParsing(true);
    try {
      setPreview(await previewCatalogFile(file));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Le fichier n’a pas pu être analysé.');
    } finally {
      setParsing(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <Modal
      title="Importer un catalogue fournisseur"
      description="Zentra lit le fichier localement, montre les valeurs détectées puis attend votre validation avant tout enregistrement."
      onClose={close}
      wide
    >
      <div className="catalog-import-wizard">
        <input
          ref={fileInput}
          className="sr-only"
          type="file"
          accept=".xlsx,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/tab-separated-values"
          onChange={(event) => void inspectFile(event.target.files?.[0])}
        />
        <button
          className="catalog-import-dropzone"
          type="button"
          disabled={busy || parsing}
          onClick={() => fileInput.current?.click()}
        >
          <span><FileSpreadsheet size={25} /></span>
          <strong>{parsing ? 'Analyse du fichier…' : preview ? 'Choisir un autre fichier' : 'Choisir le catalogue'}</strong>
          <small>.xlsx, .csv ou .tsv · {Math.round(CATALOG_IMPORT_MAX_BYTES / 1024 / 1024)} Mo maximum · analyse locale</small>
        </button>

        {error ? (
          <div className="warning-card" role="alert">
            <AlertTriangle size={18} />
            <div><strong>Import impossible</strong><p>{error}</p></div>
          </div>
        ) : null}

        {preview ? (
          <>
            <div className="catalog-import-summary" aria-label="Résumé de l’import">
              <div><span>Lignes détectées</span><strong>{rows.length}</strong></div>
              <div><span>Nouvelles références</span><strong>{creates}</strong></div>
              <div><span>Déjà au catalogue</span><strong>{updates}</strong></div>
              <div className={invalidRows.length || ambiguousRows.length ? 'is-warning' : ''}>
                <span>À corriger</span><strong>{invalidRows.length + ambiguousRows.length}</strong>
              </div>
            </div>
            <div className="catalog-import-source">
              <CheckCircle2 size={16} />
              <div>
                <strong>{preview.fileName}</strong>
                <small>Feuille « {preview.sheetName} » · en-têtes à la ligne {preview.headerRowNumber}</small>
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={() => setPreview(null)} aria-label="Retirer le fichier">
                <X size={15} />
              </Button>
            </div>
            {preview.warnings.map((warning) => (
              <p className="catalog-import-warning" key={warning}><AlertTriangle size={14} /> {warning}</p>
            ))}
            {ambiguousRows.length ? (
              <p className="catalog-import-warning" role="alert">
                <AlertTriangle size={14} /> Certaines références existent plusieurs fois dans le catalogue actuel. Corrigez ces doublons avant l’import.
              </p>
            ) : null}
            {rowsMissingVat.length > 0 ? (
              <Field
                label="TVA à appliquer"
                hint={preview.columns.vatBp
                  ? `Ce taux sera appliqué uniquement aux ${rowsMissingVat.length} ligne${rowsMissingVat.length > 1 ? 's' : ''} dont la TVA est vide. Les taux saisis, y compris 0 %, restent inchangés.`
                  : 'Ce taux sera appliqué à toutes les lignes car le fichier ne contient pas de colonne TVA.'}
              >
                <select
                  value={fallbackVatBp}
                  onChange={(event) => setFallbackVatBp(Number(event.target.value))}
                >
                  {[...new Set([0, ...vatRatesBp])].map((rate) => (
                    <option key={rate} value={rate}>
                      {(rate / 100).toLocaleString('fr-CH')} %
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field
              label="Références déjà existantes"
              hint="La comparaison utilise la référence fournisseur, sans tenir compte des majuscules."
            >
              <select
                value={conflictPolicy}
                onChange={(event) => setConflictPolicy(event.target.value as CatalogImportConflictPolicy)}
              >
                <option value="update">Mettre à jour les prix et informations</option>
                <option value="skip">Conserver les fiches actuelles</option>
              </select>
            </Field>
            <div className="catalog-import-table-wrap">
              <table className="catalog-import-table">
                <thead>
                  <tr>
                    <th>Ligne</th><th>Référence</th><th>Désignation</th><th>Type</th><th>Unité</th><th>Achat</th><th>Vente</th><th>TVA</th><th>Contrôle</th>
                  </tr>
                </thead>
                <tbody>
                  {importedRows.slice(0, 100).map((row) => {
                    const existingCount = existingBySku.get(row.sku.toLocaleLowerCase('fr-CH'))?.length ?? 0;
                    const rowErrors = [
                      ...row.errors,
                      ...(existingCount > 1 ? ['Plusieurs fiches existantes ont cette référence'] : []),
                    ];
                    return (
                      <tr key={row.rowNumber} className={rowErrors.length ? 'is-invalid' : ''}>
                        <td>{row.rowNumber}</td>
                        <td><code>{row.sku || '—'}</code></td>
                        <td><strong>{row.name || '—'}</strong>{row.description ? <small>{row.description}</small> : null}</td>
                        <td>{row.kind === 'service' ? 'Service' : 'Produit'}</td>
                        <td>{row.unit}</td>
                        <td>{formatMoney(row.purchaseCostCents)}</td>
                        <td>{formatMoney(row.salesPriceCents)}</td>
                        <td>{(row.vatBp / 100).toLocaleString('fr-CH')} %</td>
                        <td>{rowErrors.length ? rowErrors.join(' · ') : existingCount === 1 ? 'Mise à jour' : 'Nouvelle fiche'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length > 100 ? <p>100 premières lignes affichées sur {rows.length}. Toutes les lignes seront importées après validation.</p> : null}
            </div>
          </>
        ) : null}
        <div className="form-actions">
          <Button type="button" variant="secondary" disabled={busy || parsing} onClick={close}>
            Annuler
          </Button>
          <Button
            type="button"
            disabled={busy || parsing || !ready}
            onClick={() => void (async () => {
              if (await onImport(importedRows, conflictPolicy)) close();
            })()}
          >
            <Upload size={15} />
            {busy
              ? 'Import en cours…'
              : ready
                ? `Importer ${rows.length} référence${rows.length > 1 ? 's' : ''}`
                : 'Import à vérifier'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
