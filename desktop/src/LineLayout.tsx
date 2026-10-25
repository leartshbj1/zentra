import { Plus, X } from 'lucide-react';
import { getAppLocale, t, useAppLanguage } from './language';
import { measurementQuantity, measurementRowMilli, type MeasurementRow } from './measurement';
import type { DocumentLine } from './types';
import { Button } from './ui';

/** Ligne avec son métré : la quantité suit le métré tant qu'il est lisible. */
export function withMeasurements(line: DocumentLine, rows: MeasurementRow[]): DocumentLine {
  if (!rows.length) {
    const { measurements: _removed, ...rest } = line;
    return rest;
  }
  const result = measurementQuantity(rows.filter(row => row.formula.trim()));
  return { ...line, measurements: rows, ...('quantity' in result ? { quantity: result.quantity } : {}) };
}

const quantityText = (milli: number) => (milli / 1_000).toLocaleString(getAppLocale(), { maximumFractionDigits: 3 });

/** Titre d'un chapitre au-dessus de ses lignes, avec son sous-total. */
export function ChapterHeading({ title, subtotal, onRename, onRemove, disabled }: {
  title: string;
  subtotal: string;
  onRename: (title: string) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  useAppLanguage();
  return (
    <div className="line-chapter" role="group" aria-label={t('Chapitre {title}', { title })}>
      <label className="line-chapter__title">
        <span className="sr-only">{t('Titre du chapitre')}</span>
        <input value={title} maxLength={120} disabled={disabled} onChange={event => onRename(event.target.value)} placeholder={t('Titre du chapitre')} />
      </label>
      <span className="line-chapter__total">{t('Sous-total')} <strong>{subtotal}</strong></span>
      <Button type="button" variant="ghost" size="small" disabled={disabled} onClick={onRemove}>{t('Retirer le chapitre')}</Button>
    </div>
  );
}

/** Métré d'une position : une ligne par mesure, les ouvertures à déduire. */
export function MeasurementPanel({ line, onChange, disabled }: {
  line: DocumentLine;
  onChange: (rows: MeasurementRow[]) => void;
  disabled?: boolean;
}) {
  useAppLanguage();
  const rows = line.measurements ?? [];
  const filled = rows.filter(row => row.formula.trim());
  const result = filled.length ? measurementQuantity(filled) : null;
  const update = (index: number, patch: Partial<MeasurementRow>) => onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  return (
    <div className="measure-panel" role="group" aria-label={t('Métré de la ligne')}>
      {rows.map((row, index) => {
        const value = row.formula.trim() ? measurementRowMilli(row) : null;
        return (
          <div className="measure-panel__row" key={index}>
            <input aria-label={t('Désignation de la mesure')} placeholder={t('Mur nord')} value={row.label} maxLength={120} disabled={disabled} onChange={event => update(index, { label: event.target.value })} />
            <input aria-label={t('Formule')} placeholder="4,20 × 2,60" value={row.formula} maxLength={200} inputMode="decimal" disabled={disabled} onChange={event => update(index, { formula: event.target.value })} />
            <label className="measure-panel__deduct">
              <input type="checkbox" checked={Boolean(row.deduct)} disabled={disabled} onChange={event => update(index, { deduct: event.target.checked })} />
              {t('À déduire')}
            </label>
            <output aria-live="polite">{value === null ? (row.formula.trim() ? t('Formule à corriger') : '') : `${row.deduct ? '− ' : ''}${quantityText(value)} ${line.unit}`}</output>
            <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={t('Supprimer la mesure')} onClick={() => onChange(rows.filter((_, position) => position !== index))}><X size={14} /></Button>
          </div>
        );
      })}
      <div className="measure-panel__footer">
        <Button type="button" variant="ghost" size="small" disabled={disabled || rows.length >= 60} onClick={() => onChange([...rows, { label: '', formula: '' }])}><Plus size={14} />{t('Ajouter une mesure')}</Button>
        {result && 'quantity' in result ? <span>{t('Quantité calculée')} <strong>{result.quantity.toLocaleString(getAppLocale(), { maximumFractionDigits: 3 })} {line.unit}</strong></span> : null}
        {result && 'error' in result ? <span className="measure-panel__error" role="alert">{t('Une formule est à corriger.')}</span> : null}
      </div>
    </div>
  );
}
