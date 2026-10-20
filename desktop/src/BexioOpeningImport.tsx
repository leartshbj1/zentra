import { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { Button, ErrorPanel, Field } from './ui';
import { catalogHeaders, catalogMappingSource, type CatalogMappingSource } from './catalogImport';
import {
  balanceFields,
  balanceHeaderIndex,
  balanceHeaderScore,
  defaultBalanceMapping,
  defaultOpeningDate,
  defaultOpenInvoiceMapping,
  openingBalanceLines,
  openingReceivableRows,
  openInvoiceFields,
  openInvoiceHeaderIndex,
  openInvoiceHeaderScore,
  previewBalance,
  previewOpenInvoices,
  type OpeningBalancePlan,
} from './bexioOpening';
import { desktopApi } from './bridge';
import type { Workspace } from './types';
import { errorMessage, formatDate, formatMoney } from './utils';
import { t, useAppLanguage } from './language';

type Mapped = { source: CatalogMappingSource; header: number; mapping: string[] };

/** Fichier, ligne d'en-tête et colonnes : la même vérification que pour les contacts. */
function MappedFile({
  label,
  fields,
  mapped,
  disabled,
  defaults,
  score,
  headerIndex,
  onChange,
  onError,
}: {
  label: string;
  fields: Readonly<Record<string, string>>;
  mapped: Mapped | null;
  disabled: boolean;
  defaults: (headers: string[]) => string[];
  score: (headers: string[]) => number;
  headerIndex: (source: CatalogMappingSource) => number;
  onChange: (next: Mapped | null) => void;
  onError: (message: string) => void;
}) {
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function read(file?: File) {
    if (!file || disabled) return;
    setReading(true);
    onError('');
    onChange(null);
    try {
      const source = await catalogMappingSource(file, score);
      const header = headerIndex(source);
      onChange({ source, header, mapping: defaults(catalogHeaders(source, header)) });
    } catch (reason) {
      onError(errorMessage(reason, 'Choisissez un export Excel .xlsx ou CSV.'));
    } finally {
      setReading(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <>
      <label className="bexio-import-file">
        <FileUp size={22} />
        <span>
          {reading ? t('Lecture en cours…') : mapped ? mapped.source.fileName : t(label)}
          <small>{t('Excel (.xlsx) ou CSV · 20 Mo maximum')}</small>
        </span>
        <input ref={input} type="file" accept=".xlsx,.csv,.tsv" disabled={disabled} onChange={(event) => void read(event.target.files?.[0])} />
      </label>
      {mapped ? (
        <details className="bexio-import-mapping">
          <summary>{t('Vérifier les colonnes · ')}{mapped.source.sheetName}</summary>
          <Field label={t('Ligne des en-têtes')}>
            <select
              disabled={disabled}
              value={mapped.header}
              onChange={(event) => {
                const header = Number(event.target.value);
                onChange({ ...mapped, header, mapping: defaults(catalogHeaders(mapped.source, header)) });
              }}
            >
              {mapped.source.rows.slice(0, 20).map((_, index) => (
                <option key={index} value={index}>{t('Ligne {number}', { number: index + 1 })}</option>
              ))}
            </select>
          </Field>
          <div>
            {catalogHeaders(mapped.source, mapped.header).map((title, index) => (
              <Field key={index} label={title || t('Colonne {number}', { number: index + 1 })}>
                <select
                  disabled={disabled}
                  value={mapped.mapping[index] ?? 'ignore'}
                  onChange={(event) => onChange({ ...mapped, mapping: mapped.mapping.map((value, i) => (i === index ? event.target.value : value)) })}
                >
                  <option value="ignore">{t('Ne pas reprendre')}</option>
                  {Object.entries(fields).map(([key, name]) => <option key={key} value={key}>{t(name)}</option>)}
                </select>
              </Field>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}

/** Factures bexio encore ouvertes : créances d'ouverture suivies par les relances et la banque. */
export function BexioOpenInvoices({ workspace, disabled, onWorkspace }: { workspace: Workspace; disabled: boolean; onWorkspace: (workspace: Workspace) => void }) {
  useAppLanguage();
  const [mapped, setMapped] = useState<Mapped | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ created: number; skipped: number } | null>(null);
  const preview = useMemo(() => {
    if (!mapped) return { rows: [], error: '' };
    try {
      return {
        rows: previewOpenInvoices(mapped.source, mapped.header, mapped.mapping, workspace.clients,
          workspace.invoices.map((invoice) => invoice.number).filter(Boolean), workspace.settings?.billing.paymentTermsDays ?? 30),
        error: '',
      };
    } catch (reason) {
      return { rows: [], error: errorMessage(reason, 'Vérifiez les colonnes.') };
    }
  }, [mapped, workspace.clients, workspace.invoices, workspace.settings?.billing.paymentTermsDays]);
  const candidates = preview.rows.filter((row) => !row.skipped);
  const selected = candidates.filter((row) => !excluded.has(row.line));
  const invalid = selected.some((row) => row.errors.length > 0);
  const total = selected.reduce((sum, row) => sum + row.openCents, 0);
  const locked = busy || disabled;
  async function confirm() {
    if (locked || invalid || !selected.length) return;
    setBusy(true);
    setError('');
    try {
      const result = await desktopApi.importOpeningReceivables(openingReceivableRows(selected));
      setReceipt(result.receipt);
      onWorkspace(result.workspace);
    } catch (reason) {
      setError(errorMessage(reason, 'La reprise n’a pas pu être enregistrée. Rien n’a été ajouté : vous pouvez réessayer.'));
    } finally {
      setBusy(false);
    }
  }
  if (receipt) {
    return (
      <div role="status" className="bexio-import-receipt">
        <h3>{t(receipt.created === 1 ? '{count} facture reprise' : '{count} factures reprises', { count: receipt.created })}</h3>
        <p>{t('Elles apparaissent dans Factures et suivent les relances et la banque comme les autres.')}</p>
        {receipt.skipped ? <p>{t('{count} factures déjà présentes, conservées sans modification.', { count: receipt.skipped })}</p> : null}
        <Button variant="secondary" onClick={() => { setReceipt(null); setMapped(null); setExcluded(new Set()); }}>{t('Importer un autre fichier')}</Button>
      </div>
    );
  }
  return (
    <>
      <p className="bexio-opening-intro">{t('Chaque facture garde son numéro bexio. Elle est reprise sans TVA ni chiffre d’affaires, déjà comptés dans bexio, et reçoit une QR-facture pour les relances.')}</p>
      {error ? <ErrorPanel message={error} /> : null}
      <MappedFile
        label="Choisir la liste des factures ouvertes"
        fields={openInvoiceFields}
        mapped={mapped}
        disabled={locked}
        defaults={defaultOpenInvoiceMapping}
        score={openInvoiceHeaderScore}
        headerIndex={openInvoiceHeaderIndex}
        onChange={(next) => { setMapped(next); setExcluded(new Set()); }}
        onError={setError}
      />
      {mapped ? preview.error ? <ErrorPanel message={preview.error} /> : (
        <>
          <div className="bexio-import-summary">
            <h3>{t('{count} factures à reprendre · {amount}', { count: selected.length, amount: formatMoney(total) })}</h3>
            <p>{t(preview.rows.length - candidates.length === 1 ? '{count} ligne écartée : payée, annulée ou déjà dans Zentra.' : '{count} lignes écartées : payées, annulées ou déjà dans Zentra.', { count: preview.rows.length - candidates.length })}</p>
          </div>
          <div className="bexio-import-rows">
            {preview.rows.slice(0, 200).map((row) => (
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
                  <strong>{[row.number || t('Ligne {number}', { number: row.line }), row.clientName].filter(Boolean).join(' · ')}</strong>
                  <small>{row.dueDate ? t('{amount} · échéance {date}', { amount: formatMoney(row.openCents), date: formatDate(row.dueDate) }) : formatMoney(row.openCents)}</small>
                  {row.errors.length ? <span className="bexio-import-error">{row.errors.map((message) => t(message)).join(' · ')}</span> : null}
                </span>
                <small>{row.skipped ? t(row.skipped) : t('Ligne {number}', { number: row.line })}</small>
              </label>
            ))}
          </div>
          {preview.rows.length > 200 ? <p className="bexio-import-note">{t('Les 200 premières lignes sont affichées ; toutes seront reprises.')}</p> : null}
          {invalid ? <p role="alert">{t('Corrigez les lignes indiquées dans votre fichier, ou décochez-les pour importer les autres.')}</p> : null}
          <Button disabled={locked || invalid || !selected.length} onClick={() => void confirm()}>
            {busy ? t('Reprise en cours…') : t('Reprendre {count} factures', { count: selected.length })}
          </Button>
        </>
      ) : null}
    </>
  );
}

/** Bilan d'ouverture bexio : une écriture, équilibrée sur le compte 9100. */
export function BexioOpeningBalance({ disabled }: { disabled: boolean }) {
  useAppLanguage();
  const [date, setDate] = useState(defaultOpeningDate());
  const [mapped, setMapped] = useState<Mapped | null>(null);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<OpeningBalancePlan | null>(null);
  const [planError, setPlanError] = useState('');
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState('');
  const rows = useMemo(() => {
    if (!mapped) return { rows: [], error: '' };
    try {
      return { rows: previewBalance(mapped.source, mapped.header, mapped.mapping), error: '' };
    } catch (reason) {
      return { rows: [], error: errorMessage(reason, 'Vérifiez les colonnes.') };
    }
  }, [mapped]);
  const lines = useMemo(() => openingBalanceLines(rows.rows), [rows.rows]);
  const invalid = rows.rows.filter((row) => row.errors.length);
  useEffect(() => {
    setPlan(null);
    setPlanError('');
    if (!lines.length || invalid.length || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let live = true;
    // L'app native calcule l'aperçu : comptes, factures déjà reprises et écart.
    desktopApi.previewOpeningBalance(date, lines)
      .then((next) => { if (live) setPlan(next); })
      .catch((reason) => { if (live) setPlanError(errorMessage(reason, 'Le bilan n’a pas pu être vérifié.')); });
    return () => { live = false; };
  }, [date, lines, invalid.length]);
  const locked = busy || disabled;
  async function confirm() {
    if (locked || !plan) return;
    setBusy(true);
    setError('');
    try {
      const result = await desktopApi.importOpeningBalance(date, lines);
      setPosted(result.journalNumber);
    } catch (reason) {
      setError(errorMessage(reason, 'L’écriture n’a pas pu être passée. Rien n’a été enregistré.'));
    } finally {
      setBusy(false);
    }
  }
  if (posted) {
    return (
      <div role="status" className="bexio-import-receipt">
        <h3>{t('Bilan d’ouverture repris')}</h3>
        <p>{t('L’écriture {number} est dans le journal. Pour la corriger, extournez-la depuis le journal, puis reprenez le bilan.', { number: posted })}</p>
      </div>
    );
  }
  const amount = (debit: number, credit: number) => (debit ? t('Débit {amount}', { amount: formatMoney(debit) }) : t('Crédit {amount}', { amount: formatMoney(credit) }));
  return (
    <>
      <p className="bexio-opening-intro">{t('Reprenez les soldes de vos comptes de bilan (classes 1 et 2) en une seule écriture. Les factures ouvertes déjà reprises sont déduites des créances.')}</p>
      {error ? <ErrorPanel message={error} /> : null}
      <div className="bexio-opening-date"><Field label={t('Date du bilan d’ouverture')} hint={t('En général le premier jour de l’exercice.')}>
        <input type="date" value={date} disabled={locked} onChange={(event) => setDate(event.target.value)} />
      </Field></div>
      <MappedFile
        label="Choisir le bilan bexio"
        fields={balanceFields}
        mapped={mapped}
        disabled={locked}
        defaults={defaultBalanceMapping}
        score={balanceHeaderScore}
        headerIndex={balanceHeaderIndex}
        onChange={setMapped}
        onError={setError}
      />
      {rows.error ? <ErrorPanel message={rows.error} /> : null}
      {invalid.length ? (
        <p role="alert">{invalid.map((row) => t('Ligne {line} : {message}', { line: row.line, message: row.errors.map((message) => t(message)).join(' · ') })).join(' · ')}</p>
      ) : null}
      {planError ? <ErrorPanel message={planError} /> : null}
      {plan ? (
        <>
          <div className="bexio-import-summary">
            <h3>{plan.differenceCents === 0 ? t('Le bilan est équilibré') : t('Écart de {amount}', { amount: formatMoney(Math.abs(plan.differenceCents)) })}</h3>
            <p>{plan.differenceCents === 0
              ? t('L’écriture se solde exactement sur le compte 9100 Bilan d’ouverture.')
              : t('L’écart reste sur le compte 9100 Bilan d’ouverture. Vérifiez-le avec votre fiduciaire : c’est souvent le bénéfice de l’exercice.')}</p>
          </div>
          <div className="bexio-import-rows bexio-opening-lines">
            {plan.lines.map((line) => (
              <div key={line.code}>
                <span>
                  <strong>{line.code} · {line.name}</strong>
                  {line.note || line.create ? <small>{[line.note ? t('dont {amount} déjà repris avec les factures ouvertes', { amount: formatMoney(plan.receivablesCents) }) : '', line.create ? t('Compte ajouté au plan comptable') : ''].filter(Boolean).join(' · ')}</small> : null}
                </span>
                <small>{amount(line.debitCents, line.creditCents)}</small>
              </div>
            ))}
            {plan.opening.debitCents || plan.opening.creditCents ? (
              <div>
                <span><strong>{plan.opening.code} · {t(plan.opening.name)}</strong></span>
                <small>{amount(plan.opening.debitCents, plan.opening.creditCents)}</small>
              </div>
            ) : null}
          </div>
          <Button disabled={locked} onClick={() => void confirm()}>{busy ? t('Écriture en cours…') : t('Passer l’écriture d’ouverture')}</Button>
        </>
      ) : null}
    </>
  );
}
