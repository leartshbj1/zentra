import { useRef, useState } from 'react';
import { desktopApi } from './bridge';
import { fileTextGrid } from './catalogImport';
import { t, useAppLanguage } from './language';
import { parseRateAmount, parseRateGrid, type LaborRate, type LaborRateTable } from './laborRates';
import type { Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatMoney } from './utils';
import './erp-registers.css';

type RateDraft = { id: string | null; kind: LaborRate['kind']; code: string; label: string; unit: string; rate: string; cost: string };
type TableDraft = { id: string | null; name: string; source: string; validFrom: string; isDefault: boolean; rates: RateDraft[] };

const money = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));
const toDraft = (table?: LaborRateTable): TableDraft => table
  ? { id: table.id, name: table.name, source: table.source, validFrom: table.validFrom ?? '', isDefault: table.isDefault, rates: table.rates.map(rate => ({ id: rate.id, kind: rate.kind, code: rate.code ?? '', label: rate.label, unit: rate.unit, rate: money(rate.rateCents), cost: money(rate.costCents) })) }
  : { id: null, name: '', source: '', validFrom: '', isDefault: true, rates: [{ id: null, kind: 'personnel', code: '', label: '', unit: 'h', rate: '', cost: '' }] };

/** Tarifs de régie : importer le fichier de l'association, vérifier, enregistrer. */
export function LaborRatesPanel({ workspace, readOnly, onWorkspace }: { workspace: Workspace; readOnly: boolean; onWorkspace: (next: Workspace) => void }) {
  useAppLanguage();
  const tables = (workspace.laborRateTables ?? []).filter(table => !table.archivedAt);
  const [draft, setDraft] = useState<TableDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const prices = draft?.rates.map(rate => parseRateAmount(rate.rate)) ?? [];
  const costs = draft?.rates.map(rate => (rate.cost.trim() ? parseRateAmount(rate.cost) : null)) ?? [];
  const valid = !!draft && !!draft.name.trim() && draft.rates.length > 0 && draft.rates.every((rate, index) => rate.label.trim() && rate.unit.trim() && prices[index] !== null && (!rate.cost.trim() || costs[index] !== null));
  const setRate = (index: number, patch: Partial<RateDraft>) => setDraft(current => current ? { ...current, rates: current.rates.map((rate, position) => (position === index ? { ...rate, ...patch } : rate)) } : current);

  async function importFile(chosen: File) {
    setMessage('');
    try {
      const parsed = parseRateGrid(await fileTextGrid(chosen));
      if (!parsed.rates.length) { setMessage(t('Aucun tarif lisible dans ce fichier. Il faut au moins une colonne de désignation et une colonne de tarif.')); return; }
      setDraft({ id: null, name: chosen.name.replace(/\.[^.]+$/, '').slice(0, 120), source: '', validFrom: '', isDefault: tables.length === 0,
        rates: parsed.rates.map(rate => ({ id: null, kind: rate.kind, code: rate.code ?? '', label: rate.label, unit: rate.unit, rate: money(rate.rateCents), cost: money(rate.costCents) })) });
      setMessage(parsed.skipped.length ? t('{count} tarifs lus. Lignes ignorées faute de tarif : {rows}.', { count: parsed.rates.length, rows: parsed.skipped.slice(0, 8).join(', ') }) : t('{count} tarifs lus. Vérifiez-les avant d’enregistrer.', { count: parsed.rates.length }));
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le fichier n’a pas pu être lu.')));
    }
  }

  async function save(archived = false) {
    if (!draft || !valid) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await desktopApi.saveLaborRateTable({
        id: draft.id, name: draft.name.trim(), source: draft.source, validFrom: draft.validFrom || null, isDefault: draft.isDefault, archived,
        rates: draft.rates.map((rate, index) => ({ id: rate.id, kind: rate.kind, code: rate.code.trim() || null, label: rate.label.trim(), unit: rate.unit.trim(), rateCents: prices[index] ?? 0, costCents: costs[index] ?? null })),
      });
      onWorkspace(result.workspace);
      setMessage(archived ? t('Table de tarifs archivée.') : t('Tarifs de régie enregistrés.'));
      setDraft(null);
    } catch (reason) {
      setMessage(errorMessage(reason, t('Les tarifs n’ont pas pu être enregistrés.')));
    } finally {
      setBusy(false);
    }
  }

  return <section className="erp-register labor-rates" aria-labelledby="labor-rates-title">
    <h2 id="labor-rates-title">{t('Tarifs de régie')}</h2>
    <p>{t('Importez la liste de prix de régie de votre association : chef d’équipe, ouvrier qualifié, aide, apprenti et machines. Vos rapports de régie se facturent ensuite à ces tarifs.')}</p>
    {message ? <p role="status">{message}</p> : null}
    {draft ? <div className="erp-register__form">
      <Field label={t('Nom de la table')}><input value={draft.name} maxLength={120} placeholder={t('Tarifs de régie 2026')} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label={t('Association ou source')}><input value={draft.source} maxLength={160} disabled={busy} onChange={event => setDraft({ ...draft, source: event.target.value })} /></Field>
      <Field label={t('Valable dès le')}><input type="date" value={draft.validFrom} disabled={busy} onChange={event => setDraft({ ...draft, validFrom: event.target.value })} /></Field>
      <label className="labor-rates__default"><input type="checkbox" checked={draft.isDefault} disabled={busy} onChange={event => setDraft({ ...draft, isDefault: event.target.checked })} />{t('Utiliser par défaut dans les rapports')}</label>
      <div className="erp-register__wide labor-rates__rows">
        <div className="labor-rates__head" aria-hidden="true"><span>{t('Catégorie')}</span><span>{t('Code')}</span><span>{t('Type')}</span><span>{t('Unité')}</span><span>{t('Tarif CHF')}</span><span>{t('Coût CHF')}</span><span /></div>
        {draft.rates.map((rate, index) => <div className="labor-rates__row" key={index}>
          <input aria-label={t('Catégorie')} value={rate.label} maxLength={160} disabled={busy} onChange={event => setRate(index, { label: event.target.value })} />
          <input aria-label={t('Code')} value={rate.code} maxLength={40} disabled={busy} onChange={event => setRate(index, { code: event.target.value })} />
          <select aria-label={t('Type')} value={rate.kind} disabled={busy} onChange={event => setRate(index, { kind: event.target.value === 'machine' ? 'machine' : 'personnel' })}>
            <option value="personnel">{t('Personnel')}</option>
            <option value="machine">{t('Machine')}</option>
          </select>
          <input aria-label={t('Unité')} value={rate.unit} maxLength={32} disabled={busy} onChange={event => setRate(index, { unit: event.target.value })} />
          <input aria-label={t('Tarif CHF')} inputMode="decimal" value={rate.rate} disabled={busy} aria-invalid={prices[index] === null} onChange={event => setRate(index, { rate: event.target.value })} />
          <input aria-label={t('Coût CHF')} inputMode="decimal" value={rate.cost} placeholder={t('facultatif')} disabled={busy} aria-invalid={!!rate.cost.trim() && costs[index] === null} onChange={event => setRate(index, { cost: event.target.value })} />
          <Button type="button" variant="ghost" size="small" disabled={busy || draft.rates.length === 1} onClick={() => setDraft({ ...draft, rates: draft.rates.filter((_, position) => position !== index) })}>{t('Retirer')}</Button>
        </div>)}
        <Button type="button" variant="ghost" size="small" disabled={busy || draft.rates.length >= 500} onClick={() => setDraft({ ...draft, rates: [...draft.rates, { id: null, kind: 'personnel', code: '', label: '', unit: 'h', rate: '', cost: '' }] })}>{t('Ajouter un tarif')}</Button>
        <p className="labor-rates__hint">{t('Le coût (facultatif) sert à calculer la marge du chantier sur les heures de régie.')}</p>
      </div>
      <div className="erp-register__actions">
        <Button type="button" disabled={busy || !valid} onClick={() => void save()}>{busy ? t('Enregistrement…') : t('Enregistrer les tarifs')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
        {draft.id ? <Button type="button" variant="ghost" disabled={busy || !valid} onClick={() => void save(true)}>{t('Archiver')}</Button> : null}
      </div>
    </div> : <div className="erp-register__actions">
      <Button type="button" variant="secondary" disabled={readOnly || busy} onClick={() => file.current?.click()}>{t('Importer un fichier (Excel ou CSV)')}</Button>
      <Button type="button" variant="ghost" disabled={readOnly || busy} onClick={() => { setDraft(toDraft()); setMessage(''); }}>{t('Saisir à la main')}</Button>
      <input ref={file} type="file" accept=".xlsx,.csv,.tsv" hidden onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ''; if (chosen) void importFile(chosen); }} />
    </div>}
    {tables.length ? <ul className="erp-register__list" aria-label={t('Tables de tarifs')}>
      {tables.map(table => <li key={table.id}>
        <span>
          <strong>{table.name}</strong>
          <small>{[table.isDefault ? t('par défaut') : '', table.source, t('{n} tarifs', { n: table.rates.length }),
            table.rates.slice(0, 3).map(rate => `${rate.label} ${formatMoney(rate.rateCents)}`).join(', ')].filter(Boolean).join(' · ')}</small>
        </span>
        <Button type="button" variant="ghost" size="small" disabled={readOnly || busy || !!draft} onClick={() => { setDraft(toDraft(table)); setMessage(''); }}>{t('Modifier')}</Button>
      </li>)}
    </ul> : draft ? null : <p>{t('Aucune table de tarifs. Les heures des rapports gardent le tarif saisi.')}</p>}
  </section>;
}
