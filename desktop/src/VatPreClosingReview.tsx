import { useState } from 'react';
import type { VatReturnPreview, VatSourceTreatment, VatSourceType } from './types';
import { Button } from './ui';
import { formatDate, formatMoney, searchText } from './utils';
import { treatmentsForVatSource, vatSourceTypeLabels, vatTreatmentLabels } from './vatCenterLogic';

export function VatPreClosingReview({ sources, busy, onClassify }: {
  sources: NonNullable<VatReturnPreview['preClosingSources']>;
  busy: boolean;
  onClassify: (id: string, type: VatSourceType, treatment: VatSourceTreatment) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  if (!sources.length) return null;
  const filtered = sources.filter((source) => searchText([source.description, source.occurrenceDate], query));
  return <details className="vat-purchase-review vat-pre-closing-review">
    <summary>À classer avant la clôture <span>{sources.length}</span></summary>
    <p>Ces documents, notamment les factures encore impayées, ne participent pas au calcul de cette période. Classez-les avant de clôturer leurs écritures : leur traitement sera repris lors du règlement.</p>
    <label className="field"><span>Rechercher un document à classer</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(25); }} /></label>
    <div className="vat-unclassified">{filtered.slice(0, limit).map((source) => <article key={`${source.sourceType}:${source.sourceId}`}>
      <div><strong>{source.description}</strong><span>{formatDate(source.occurrenceDate)} · {formatMoney(source.amountCents, source.currency)} HT</span><small>TVA : {formatMoney(source.vatCents, source.currency)} · {vatSourceTypeLabels[source.sourceType]}</small></div>
      <select defaultValue="" disabled={busy} aria-label={`Traitement avant clôture de ${source.description}`} onChange={(event) => { const treatment = event.currentTarget.value as VatSourceTreatment; event.currentTarget.value = ''; if (treatment) void onClassify(source.sourceId, source.sourceType, treatment); }}>
        <option value="">Choisir le traitement</option>{treatmentsForVatSource(source.sourceType).map((treatment) => <option key={treatment} value={treatment}>{vatTreatmentLabels[treatment]}</option>)}
      </select>
    </article>)}</div>
    {!filtered.length ? <p>Aucun document ne correspond à cette recherche.</p> : null}
    {filtered.length > limit ? <Button variant="ghost" onClick={() => setLimit(limit + 25)}>Afficher les documents suivants</Button> : null}
  </details>;
}
