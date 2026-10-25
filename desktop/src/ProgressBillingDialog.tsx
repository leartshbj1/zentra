import { useMemo, useRef, useState } from 'react';
import { getAppLocale, t, useAppLanguage } from './language';
import { chapterGroups } from './measurement';
import { documentLineTotals, errorMessage, formatMoney, todayIso } from './utils';
import { lineCumulative, nextProgressStep, previewProgress, previousProgress, type ProgressBillRequest, type ProgressEntry, type ProgressKind } from './progressBilling';
import type { Quote, Workspace } from './types';
import { Button, ErrorPanel, Field, FormActions, Modal, submitForm } from './ui';

/** Nombre saisi à la suisse (« 37,5 », « 1'250 »), ou null. */
export function parseDecimalInput(value: string): number | null {
  const cleaned = value.replace(/['\s]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

type Draft = { mode: 'percent' | 'quantity'; value: string };

/**
 * Situation SIA 118 d'un devis accepté : avancement cumulé par position,
 * retenue de garantie, décompte final ou libération de la retenue. L'aperçu
 * reprend le calcul natif ; la facture est préparée en brouillon.
 */
export function ProgressBillingDialog({ quote, workspace, busy, close, onCreate }: {
  quote: Quote;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  onCreate: (input: ProgressBillRequest, onError: (reason: unknown) => void) => Promise<boolean>;
}) {
  useAppLanguage();
  const bills = workspace.progressBills ?? [];
  const plan = workspace.progressPlans?.find(candidate => candidate.quoteId === quote.id);
  const previous = useMemo(() => previousProgress(quote.id, bills, workspace.invoices), [quote.id, bills, workspace.invoices]);
  const step = nextProgressStep(previous);
  const [kind, setKind] = useState<ProgressKind>(step === 'retention_release' ? 'retention_release' : 'situation');
  const [progressDate, setProgressDate] = useState(todayIso());
  const [retention, setRetention] = useState(String((plan?.retentionBp ?? 1_000) / 100).replace('.', ','));
  const [roundToFive, setRoundToFive] = useState(plan?.roundToFive ?? true);
  const [releaseRetention, setReleaseRetention] = useState(false);
  const lastLines = useMemo(() => {
    const last = bills.filter(bill => bill.quoteId === quote.id && bill.kind !== 'retention_release' && workspace.invoices.some(invoice => invoice.id === bill.invoiceId && invoice.status !== 'cancelled' && invoice.status !== 'draft')).sort((a, b) => b.sequence - a.sequence)[0];
    return new Map((last?.lines ?? []).map(line => [line.quoteItemId, line]));
  }, [bills, quote.id, workspace.invoices]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(quote.lines.map(line => {
    const before = lastLines.get(line.id);
    if (before?.mode === 'quantity') return [line.id, { mode: 'quantity', value: String(before.cumulativeQuantity).replace('.', ',') }];
    return [line.id, { mode: 'percent', value: before?.cumulativePercentBp != null ? String(before.cumulativePercentBp / 100).replace('.', ',') : '' }];
  })));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const locked = busy || saving;
  const retentionValue = parseDecimalInput(retention);
  const retentionBp = retentionValue === null ? NaN : Math.round(retentionValue * 100);

  const entries = useMemo(() => {
    const result: Record<string, ProgressEntry> = {};
    for (const line of quote.lines) {
      const draft = drafts[line.id];
      if (!draft || !draft.value.trim()) continue;
      const number = parseDecimalInput(draft.value);
      if (number === null) { result[line.id] = { mode: draft.mode, percentBp: NaN, quantity: NaN }; continue; }
      result[line.id] = draft.mode === 'percent' ? { mode: 'percent', percentBp: Math.round(number * 100) } : { mode: 'quantity', quantity: number };
    }
    return result;
  }, [drafts, quote.lines]);
  const preview = previewProgress(kind, quote, entries, retentionBp, releaseRetention, roundToFive, previous);
  const money = (cents: number) => formatMoney(cents, quote.currency);
  const sequence = previous.sequence + 1;
  const title = kind === 'final' ? t('Décompte final') : kind === 'retention_release' ? t('Libérer la retenue de garantie') : t('Situation n° {number}', { number: sequence });

  if (step === 'done' || step === 'draft') {
    return (
      <Modal title={t('Facturation par situations')} description={quote.number || quote.title} onClose={close}>
        <p className="progress-dialog__state" role="status">
          {step === 'draft'
            ? t('La situation n° {number} est encore un brouillon. Émettez-la ou supprimez-la avant de préparer la suivante.', { number: previous.draftSequence ?? sequence })
            : t('Ce devis est entièrement facturé : décompte final établi et retenue libérée.')}
        </p>
        <div className="form-actions"><Button type="button" variant="secondary" onClick={close}>{t('Fermer')}</Button></div>
      </Modal>
    );
  }

  return (
    <Modal title={title} description={t('Devis {number} · {title}', { number: quote.number || '—', title: quote.title })} onClose={close} dismissible={!locked} wide className="progress-dialog">
      <form onSubmit={submitForm(async () => {
        if (locked || inFlight.current || 'error' in preview) return;
        inFlight.current = true; setSaving(true); setError('');
        const lines = kind === 'retention_release' ? [] : quote.lines.flatMap(line => {
          const entry = entries[line.id];
          if (!entry) return [];
          return [entry.mode === 'percent' ? { quoteItemId: line.id, mode: 'percent' as const, cumulativePercentBp: entry.percentBp } : { quoteItemId: line.id, mode: 'quantity' as const, cumulativeQuantity: entry.quantity }];
        });
        let reported = false;
        try {
          const created = await onCreate({ quoteId: quote.id, kind, progressDate, retentionBp, roundToFive, releaseRetention: kind === 'final' && releaseRetention, lines }, reason => { reported = true; setError(errorMessage(reason, t('La situation n’a pas pu être préparée. Vos saisies sont conservées.'))); });
          if (!created && !reported) setError(t('La situation n’a pas pu être préparée. Vos saisies sont conservées.'));
        } catch (reason) {
          setError(errorMessage(reason, t('La situation n’a pas pu être préparée. Vos saisies sont conservées.')));
        } finally { inFlight.current = false; setSaving(false); }
      })}>
        {error ? <ErrorPanel title={t('La situation demande une vérification')} message={error} reveal /> : null}
        {step !== 'retention_release' ? (
          <div className="progress-dialog__kind" role="radiogroup" aria-label={t('Type de facture')}>
            <label><input type="radio" name="progress-kind" checked={kind === 'situation'} disabled={locked} onChange={() => setKind('situation')} />{t('Situation n° {number}', { number: sequence })}</label>
            <label><input type="radio" name="progress-kind" checked={kind === 'final'} disabled={locked} onChange={() => setKind('final')} />{t('Décompte final')}</label>
          </div>
        ) : null}
        <div className="form-grid progress-dialog__settings">
          <Field label={t('Avancement au')}>
            <input type="date" value={progressDate} disabled={locked} onChange={event => setProgressDate(event.target.value)} required />
          </Field>
          {kind !== 'retention_release' ? (
            <Field label={t('Retenue de garantie (%)')} hint={t('Souvent 5 à 10 % selon le contrat (SIA 118).')}>
              <input inputMode="decimal" value={retention} disabled={locked} onChange={event => setRetention(event.target.value)} />
            </Field>
          ) : null}
        </div>
        <label className="progress-dialog__check"><input type="checkbox" checked={roundToFive} disabled={locked} onChange={event => setRoundToFive(event.target.checked)} />{t('Arrondir le total au 5 centimes')}</label>
        {kind === 'final' ? (
          <label className="progress-dialog__check"><input type="checkbox" checked={releaseRetention} disabled={locked} onChange={event => setReleaseRetention(event.target.checked)} />{t('Libérer la retenue maintenant (une garantie bancaire la remplace)')}</label>
        ) : null}

        {kind !== 'retention_release' ? (
          <div className="progress-dialog__positions">
            <div className="progress-dialog__head" aria-hidden="true">
              <span>{t('Position')}</span><span>{t('Devis')}</span><span>{t('Déjà facturé')}</span><span>{t('Avancement cumulé')}</span><span>{t('Exécuté')}</span>
            </div>
            {chapterGroups(quote.lines, line => documentLineTotals(line).netCents).map((group, groupIndex) => (
              <section key={groupIndex} className="progress-dialog__chapter" aria-label={group.title ?? undefined}>
                {group.title ? <h3>{group.title}</h3> : null}
                {group.lines.map(line => {
                  const draft = drafts[line.id] ?? { mode: 'percent', value: '' };
                  const entry = entries[line.id] ?? (kind === 'final' ? { mode: 'quantity' as const, quantity: line.quantity } : undefined);
                  const computed = entry ? lineCumulative(line, entry) : null;
                  const before = previous.lineNet[line.id] ?? 0;
                  const contract = documentLineTotals(line).netCents;
                  return (
                    <div className="progress-dialog__row" key={line.id}>
                      <span className="progress-dialog__description">{line.description}</span>
                      <span>{line.quantity.toLocaleString(getAppLocale(), { maximumFractionDigits: 3 })} {line.unit}<small>{money(contract)}</small></span>
                      <span>{before ? money(before) : '—'}{before && contract ? <small>{Math.round((before / contract) * 1_000) / 10} %</small> : null}</span>
                      <span className="progress-dialog__input">
                        <input
                          inputMode="decimal"
                          aria-label={t('Avancement cumulé de {position}', { position: line.description })}
                          placeholder={kind === 'final' ? (draft.mode === 'percent' ? '100' : String(line.quantity).replace('.', ',')) : draft.mode === 'percent' ? '0' : '0'}
                          value={draft.value}
                          disabled={locked}
                          onChange={event => setDrafts(current => ({ ...current, [line.id]: { ...draft, value: event.target.value } }))}
                        />
                        <select aria-label={t('Unité de l’avancement')} value={draft.mode} disabled={locked} onChange={event => setDrafts(current => ({ ...current, [line.id]: { mode: event.target.value === 'quantity' ? 'quantity' : 'percent', value: '' } }))}>
                          <option value="percent">%</option>
                          <option value="quantity">{line.unit}</option>
                        </select>
                      </span>
                      <span className="progress-dialog__amount">{computed && !('error' in computed) ? money(computed.netCents) : computed ? t('À corriger') : before ? money(before) : '—'}</span>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        ) : null}

        <dl className="progress-dialog__summary" aria-live="polite">
          {'error' in preview ? (
            <div className="progress-dialog__hint"><dt className="sr-only">{t('Aperçu')}</dt><dd>{t(preview.error)}</dd></div>
          ) : (
            <>
              <div><dt>{t('Travaux exécutés à ce jour (HT)')}</dt><dd>{money(preview.cumulativeNetCents)}</dd></div>
              {preview.cumulativeRetentionCents ? <div><dt>{t('Retenue de garantie')}</dt><dd>−{money(preview.cumulativeRetentionCents)}</dd></div> : null}
              {preview.previousNetCents ? <div><dt>{t('Déjà facturé (HT)')}</dt><dd>−{money(preview.previousNetCents)}</dd></div> : null}
              <div><dt>{t('Cette facture (HT)')}</dt><dd>{money(preview.netCents + preview.roundingCents)}</dd></div>
              <div><dt>{t('TVA')}</dt><dd>{money(preview.vatCents)}</dd></div>
              <div className="progress-dialog__total"><dt>{t('Total à payer')}</dt><dd>{money(preview.totalCents)}</dd></div>
            </>
          )}
        </dl>
        <p className="progress-dialog__note">{t('La facture est préparée en brouillon. Vous la vérifiez puis l’émettez comme les autres.')}</p>
        <FormActions onCancel={close} busy={locked} disabled={'error' in preview} submitLabel={t('Préparer la facture')} />
      </form>
    </Modal>
  );
}
