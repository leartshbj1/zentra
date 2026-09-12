import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload, X } from 'lucide-react';
import {
  CATALOG_IMPORT_MAX_BYTES,
  applyCatalogVatFallback,
  catalogRowFromEdit,
  previewCatalogFile,
  recheckCatalogRows,
  type CatalogImportPreview,
  type CatalogImportRow,
  type CatalogImportPreviewRow,
  type CatalogRowEdit,
} from './catalogImport';
import type { CatalogItem } from './types';
import { errorMessage, formatMoney } from './utils';
import { Button, ErrorPanel, Field, FormActions, Modal, submitForm } from './ui';
import './CatalogImportWizard.css';

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
    onError?: (reason: unknown) => void,
  ) => Promise<boolean>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);
  const [error, setError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const inFlight = useRef(false);
  const [editing, setEditing] = useState<CatalogImportPreviewRow | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [page, setPage] = useState(0);
  const locked = busy || parsing || importing;
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
  function issuesFor(row: CatalogImportPreviewRow): string[] {
    const matches = existingBySku.get(row.sku.toLocaleLowerCase('fr-CH')) ?? [];
    return [...row.errors,
      ...(matches.length > 1 ? ['Plusieurs fiches existantes ont cette référence'] : []),
      ...(conflictPolicy === 'update' && matches.length === 1 && matches[0].trackStock && row.kind === 'service' ? ['Cet article est suivi en stock : conservez le type Produit ou conservez la fiche actuelle'] : []),
    ];
  }
  const invalidRows = rows.filter((row) => issuesFor(row).length > 0);
  const ambiguousRows = rows.filter(
    (row) => (existingBySku.get(row.sku.toLocaleLowerCase('fr-CH'))?.length ?? 0) > 1,
  );
  const updates = rows.filter(
    (row) => (existingBySku.get(row.sku.toLocaleLowerCase('fr-CH'))?.length ?? 0) === 1,
  ).length;
  const creates = rows.length - updates - ambiguousRows.length;
  const ready = Boolean(preview && rows.length && !invalidRows.length && !ambiguousRows.length);
  const visibleRows = importedRows.filter(row => !onlyIssues || issuesFor(row).length > 0);
  const lastPage = Math.max(0, Math.ceil(visibleRows.length / 100) - 1);
  const currentPage = Math.min(page, lastPage);

  async function inspectFile(file: File | undefined) {
    if (!file || locked) return;
    setError('');
    setPreview(null);
    setParsing(true);
    try {
      const next = await previewCatalogFile(file);
      setPreview(next);
      setPage(0);
      setOnlyIssues(next.rows.some(row => row.errors.length > 0));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Le fichier n’a pas pu être analysé.');
    } finally {
      setParsing(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function importRows() {
    if (!ready || locked || inFlight.current) return;
    inFlight.current = true;
    setImporting(true);
    setError('');
    let reported = false;
    try {
      const success = await onImport(importedRows, conflictPolicy, reason => {
        reported = true;
        setError(errorMessage(reason, 'L’import a été refusé. Vos lignes corrigées sont conservées.'));
      });
      if (success) close();
      else if (!reported) setError('L’import n’a pas pu être terminé. Votre fichier et vos corrections sont conservés ; réessayez.');
    } catch (reason) {
      setError(errorMessage(reason, 'L’import n’a pas pu être terminé. Vos corrections sont conservées.'));
    } finally { inFlight.current = false; setImporting(false); }
  }

  return (
    <Modal
      title="Importer un catalogue fournisseur"
      description="Choisissez un fichier Excel ou CSV, puis vérifiez les prix en CHF avant de confirmer."
      onClose={close}
      dismissible={!locked}
      className="catalog-import-modal"
      wide
    >
      {editing ? <CatalogRowCorrection key={editing.rowNumber} row={editing} onCancel={() => setEditing(null)} onApply={(row) => {
        setPreview(current => current ? { ...current, rows: recheckCatalogRows(current.rows.map(existing => existing.rowNumber === row.rowNumber ? row : existing)) } : current);
        setEditing(null);
        setError('');
      }} /> :
      <div className="catalog-import-wizard">
        <fieldset disabled={locked}>
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

        {preview ? (
          <>
            <div className="catalog-import-summary" aria-label="Résumé de l’import">
              <div><span>Lignes détectées</span><strong>{rows.length}</strong></div>
              <div><span>Nouvelles références</span><strong>{creates}</strong></div>
              <div><span>Déjà au catalogue</span><strong>{updates}</strong></div>
              <div className={invalidRows.length || ambiguousRows.length ? 'is-warning' : ''}>
                <span>À corriger</span><strong>{invalidRows.length}</strong>
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
            <div className="catalog-import-review-tools">
              <label><input type="checkbox" checked={onlyIssues} onChange={event => { setOnlyIssues(event.target.checked); setPage(0); }} /> Afficher les lignes à corriger ({invalidRows.length})</label>
              <p>{invalidRows.length ? 'Ouvrez « Corriger » à côté de la ligne. Les autres lignes restent conservées.' : 'Toutes les lignes sont prêtes. Vérifiez les prix en CHF avant de confirmer.'}</p>
            </div>
            <div className="catalog-import-table-wrap">
              <table className="catalog-import-table">
                <thead>
                  <tr>
                    <th>Ligne</th><th>Référence</th><th>Désignation</th><th>Type</th><th>Unité</th><th>Achat</th><th>Vente</th><th>TVA</th><th>Contrôle</th><th>Correction</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.slice(currentPage * 100, (currentPage + 1) * 100).map((row) => {
                    const existingCount = existingBySku.get(row.sku.toLocaleLowerCase('fr-CH'))?.length ?? 0;
                    const rowErrors = issuesFor(row);
                    return (
                      <tr key={row.rowNumber} className={rowErrors.length ? 'is-invalid' : ''}>
                        <td data-label="Ligne">{row.rowNumber}</td>
                        <td data-label="Référence"><code>{row.sku || '—'}</code></td>
                        <td data-label="Désignation"><strong>{row.name || '—'}</strong>{row.description ? <small>{row.description}</small> : null}</td>
                        <td data-label="Type">{row.kind === 'service' ? 'Service' : 'Produit'}</td>
                        <td data-label="Unité">{row.unit}</td>
                        <td data-label="Achat">{formatMoney(row.purchaseCostCents)}</td>
                        <td data-label="Vente">{formatMoney(row.salesPriceCents)}</td>
                        <td data-label="TVA">{(row.vatBp / 100).toLocaleString('fr-CH')} %</td>
                        <td data-label="Contrôle">{rowErrors.length ? rowErrors.join(' · ') : existingCount === 1 ? conflictPolicy === 'skip' ? 'Fiche conservée' : 'Mise à jour' : 'Nouvelle fiche'}</td>
                        <td><Button type="button" variant="secondary" size="small" onClick={() => setEditing(rows.find(item => item.rowNumber === row.rowNumber)!)} aria-label={`Corriger la ligne ${row.rowNumber}`}>Corriger</Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!visibleRows.length ? <p>Aucune ligne à corriger. Désactivez le filtre pour consulter le catalogue.</p> : null}
            </div>
            {visibleRows.length > 100 ? <nav className="catalog-import-pagination" aria-label="Pages du catalogue"><Button type="button" variant="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Précédent</Button><span>Page {currentPage + 1} / {lastPage + 1}</span><Button type="button" variant="secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Suivant</Button></nav> : null}
          </>
        ) : null}
        </fieldset>
        {error ? <ErrorPanel title="Vérifions l’import" message={error} reveal /> : null}
        <div className="form-actions">
          <Button type="button" variant="secondary" disabled={locked} onClick={close}>
            Annuler
          </Button>
          <Button
            type="button"
            disabled={locked || !ready}
            onClick={() => void importRows()}
          >
            <Upload size={15} />
            {busy || importing
              ? 'Import en cours…'
              : ready
                ? `Importer (${rows.length})`
                : 'Import à vérifier'}
          </Button>
        </div>
      </div>}
    </Modal>
  );
}

function CatalogRowCorrection({ row, onCancel, onApply }: { row: CatalogImportPreviewRow; onCancel: () => void; onApply: (row: CatalogImportPreviewRow) => void }) {
  const [error, setError] = useState('');
  return <form className="catalog-row-correction" noValidate onSubmit={submitForm(async form => {
    const edit = Object.fromEntries(['sku', 'name', 'description', 'unit', 'purchase', 'sale', 'vat', 'kind'].map(key => [key, String(form.get(key) ?? '')])) as CatalogRowEdit;
    try {
      const corrected = catalogRowFromEdit(row.rowNumber, edit);
      if (corrected.errors.length) { setError(corrected.errors.join(' · ')); return; }
      onApply(corrected);
    } catch (reason) { setError(errorMessage(reason, 'Vérifiez les informations de cette ligne.')); }
  })}>
    <div><h3>Corriger la ligne {row.rowNumber}</h3><p>La correction sera utilisée pour cet import. Le fichier d’origine reste disponible tel quel.</p></div>
    <div className="form-grid">
      <Field label="Référence" required><input name="sku" defaultValue={row.sku} maxLength={80} required autoFocus /></Field>
      <Field label="Désignation" required><input name="name" defaultValue={row.name} maxLength={200} required /></Field>
      <Field label="Description" wide><textarea name="description" defaultValue={row.description} maxLength={10000} rows={3} /></Field>
      <Field label="Type"><select name="kind" defaultValue={row.kind}><option value="product">Produit</option><option value="service">Service</option></select></Field>
      <Field label="Unité" required><input name="unit" defaultValue={row.unit} maxLength={40} required /></Field>
      <Field label="Prix d’achat (CHF)" hint="Indiquez 0 si cet article n’a pas de coût d’achat." required><input name="purchase" inputMode="decimal" defaultValue={row.errors.includes('Prix d’achat invalide') ? '' : (row.purchaseCostCents / 100).toFixed(2)} required /></Field>
      <Field label="Prix de vente (CHF)" required><input name="sale" inputMode="decimal" defaultValue={row.errors.includes('Prix de vente invalide') ? '' : (row.salesPriceCents / 100).toFixed(2)} required /></Field>
      <Field label="TVA (%)" hint="Laissez vide pour utiliser le taux choisi avant l’import."><input name="vat" inputMode="decimal" defaultValue={row.errors.includes('Taux TVA invalide') || row.vatBp === null ? '' : String(row.vatBp / 100)} /></Field>
    </div>
    {error ? <ErrorPanel title="Vérifions cette ligne" message={error} reveal /> : null}
    <FormActions busy={false} onCancel={onCancel} cancelLabel="Retour au catalogue" submitLabel="Appliquer la correction" />
  </form>;
}
