import { useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import { defaultRateTable, parseRateAmount } from './laborRates';
import { kitTotals, type ServiceKitLine } from './serviceKits';
import type { Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatMoney } from './utils';
import './erp-registers.css';

type LineDraft = { kind: ServiceKitLine['kind']; componentItemId: string; description: string; quantity: string; price: string; cost: string };
type KitDraft = { catalogItemId: string; existing: boolean; lines: LineDraft[] };

const money = (cents: number) => (cents / 100).toFixed(2);
const quantityMilli = (value: string) => {
  const number = Number(value.replace(',', '.'));
  return Number.isFinite(number) && number > 0 && number <= 1_000_000 ? Math.round(number * 1_000) : null;
};

/** Kits de prestations : un article = matériel + main-d'œuvre, prix calculé. */
export function ServiceKitsPanel({ workspace, readOnly, onWorkspace }: { workspace: Workspace; readOnly: boolean; onWorkspace: (next: Workspace) => void }) {
  useAppLanguage();
  const kits = workspace.serviceKits ?? [];
  const items = workspace.catalogItems.filter(item => !item.archivedAt);
  const services = items.filter(item => item.kind === 'service');
  const components = items.filter(item => !kits.some(kit => kit.catalogItemId === item.id));
  const rates = defaultRateTable(workspace.laborRateTables)?.rates.filter(rate => rate.kind === 'personnel') ?? [];
  const [draft, setDraft] = useState<KitDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const locked = readOnly || busy;
  const lines: ServiceKitLine[] | null = draft ? draft.lines.map(line => {
    const quantity = quantityMilli(line.quantity), price = parseRateAmount(line.price || '0'), cost = parseRateAmount(line.cost || '0');
    return quantity === null || price === null || cost === null || !line.description.trim() ? null : { kind: line.kind, componentItemId: line.componentItemId || null, description: line.description.trim(), quantityMilli: quantity, unitPriceCents: price, unitCostCents: cost };
  }).filter((line): line is ServiceKitLine => line !== null) : null;
  const valid = !!draft && !!draft.catalogItemId && !!lines && lines.length === draft.lines.length && lines.length > 0;
  const totals = lines ? kitTotals(lines) : null;
  const setLine = (index: number, patch: Partial<LineDraft>) => setDraft(current => current ? { ...current, lines: current.lines.map((line, position) => (position === index ? { ...line, ...patch } : line)) } : current);
  const name = (id: string) => items.find(item => item.id === id)?.name ?? '';

  async function run(action: () => Promise<Workspace>, done: string) {
    setBusy(true);
    setMessage('');
    try {
      onWorkspace(await action());
      setMessage(done);
      setDraft(null);
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le kit n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }

  return <section className="erp-register service-kits" aria-labelledby="service-kits-title">
    <h2 id="service-kits-title">{t('Kits de prestations')}</h2>
    <p>{t('Un kit réunit le matériel et la main-d’œuvre d’une prestation (par exemple la pose d’une prise). Son prix se calcule tout seul et le devis le reprend comme un article.')}</p>
    {message ? <p role="status">{message}</p> : null}
    {draft ? <div className="erp-register__form">
      <Field label={t('Prestation du catalogue')}>
        <select value={draft.catalogItemId} disabled={locked || draft.existing} onChange={event => setDraft({ ...draft, catalogItemId: event.target.value })}>
          <option value="">{t('Choisir une prestation')}</option>
          {services.filter(item => draft.existing || !kits.some(kit => kit.catalogItemId === item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </Field>
      <div className="erp-register__wide service-kits__rows">
        {draft.lines.map((line, index) => <div className="service-kits__row" key={index}>
          {line.kind === 'material' ? <select aria-label={t('Article')} value={line.componentItemId} disabled={locked} onChange={event => {
            const item = components.find(candidate => candidate.id === event.target.value);
            setLine(index, item ? { componentItemId: item.id, description: item.name, price: money(item.salesPriceCents), cost: money(item.purchaseCostCents) } : { componentItemId: '' });
          }}>
            <option value="">{t('Matériel libre')}</option>
            {components.filter(item => item.id !== draft.catalogItemId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select> : <select aria-label={t('Tarif horaire')} value="" disabled={locked || !rates.length} onChange={event => {
            const rate = rates.find(candidate => candidate.id === event.target.value);
            if (rate) setLine(index, { description: rate.label, price: money(rate.rateCents), cost: rate.costCents === null ? line.cost : money(rate.costCents) });
          }}>
            <option value="">{rates.length ? t('Choisir un tarif') : t('Main-d’œuvre')}</option>
            {rates.map(rate => <option key={rate.id} value={rate.id}>{rate.label} · {formatMoney(rate.rateCents)} / h</option>)}
          </select>}
          <input aria-label={t('Désignation')} value={line.description} maxLength={200} disabled={locked} onChange={event => setLine(index, { description: event.target.value })} />
          <input aria-label={line.kind === 'labor' ? t('Heures') : t('Quantité')} inputMode="decimal" placeholder={line.kind === 'labor' ? t('heures') : t('quantité')} value={line.quantity} disabled={locked} onChange={event => setLine(index, { quantity: event.target.value })} />
          <input aria-label={t('Prix CHF')} inputMode="decimal" placeholder={t('prix')} value={line.price} disabled={locked} onChange={event => setLine(index, { price: event.target.value })} />
          <input aria-label={t('Coût CHF')} inputMode="decimal" placeholder={t('coût')} value={line.cost} disabled={locked} onChange={event => setLine(index, { cost: event.target.value })} />
          <Button type="button" variant="ghost" size="small" disabled={locked || draft.lines.length === 1} onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, position) => position !== index) })}>{t('Retirer')}</Button>
        </div>)}
        <div className="erp-register__actions">
          <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => setDraft({ ...draft, lines: [...draft.lines, { kind: 'material', componentItemId: '', description: '', quantity: '1', price: '', cost: '' }] })}>{t('Ajouter du matériel')}</Button>
          <Button type="button" variant="ghost" size="small" disabled={locked} onClick={() => setDraft({ ...draft, lines: [...draft.lines, { kind: 'labor', componentItemId: '', description: t('Main-d’œuvre'), quantity: '', price: '', cost: '' }] })}>{t('Ajouter de la main-d’œuvre')}</Button>
        </div>
        {totals ? <p className="service-kits__total">{t('Prix du kit {price} · coût {cost} · {hours} h de main-d’œuvre', { price: formatMoney(totals.priceCents), cost: formatMoney(totals.costCents), hours: String(Math.round((totals.laborMinutes / 60) * 100) / 100).replace('.', ',') })}</p> : null}
      </div>
      <div className="erp-register__actions">
        <Button type="button" disabled={locked || !valid} onClick={() => lines && void run(() => desktopApi.saveServiceKit(draft.catalogItemId, lines), t('Kit enregistré. Le prix de la prestation est mis à jour.'))}>{busy ? t('Enregistrement…') : t('Enregistrer le kit')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
        {draft.existing ? <Button type="button" variant="ghost" disabled={locked} onClick={() => void run(() => desktopApi.deleteServiceKit(draft.catalogItemId), t('Kit retiré. La prestation garde son dernier prix.'))}>{t('Retirer le kit')}</Button> : null}
      </div>
    </div> : <div className="erp-register__actions">
      <Button type="button" variant="secondary" disabled={locked || !services.length} onClick={() => { setDraft({ catalogItemId: '', existing: false, lines: [{ kind: 'material', componentItemId: '', description: '', quantity: '1', price: '', cost: '' }, { kind: 'labor', componentItemId: '', description: t('Main-d’œuvre'), quantity: '', price: '', cost: '' }] }); setMessage(''); }}>{t('Nouveau kit')}</Button>
      {!services.length ? <p>{t('Créez d’abord la prestation dans le catalogue (type Service).')}</p> : null}
    </div>}
    {kits.length ? <ul className="erp-register__list" aria-label={t('Kits de prestations')}>
      {kits.map(kit => {
        const kitTotal = kitTotals(kit.lines);
        return <li key={kit.catalogItemId}>
          <span><strong>{name(kit.catalogItemId)}</strong><small>{kit.lines.map(line => line.description).slice(0, 4).join(' · ')}</small></span>
          <span className="erp-register__amount">{formatMoney(kitTotal.priceCents)}</span>
          <Button type="button" variant="ghost" size="small" disabled={locked || !!draft} onClick={() => setDraft({ catalogItemId: kit.catalogItemId, existing: true, lines: kit.lines.map(line => ({ kind: line.kind, componentItemId: line.componentItemId ?? '', description: line.description, quantity: String(line.quantityMilli / 1_000).replace('.', ','), price: money(line.unitPriceCents), cost: money(line.unitCostCents) })) })}>{t('Modifier')}</Button>
        </li>;
      })}
    </ul> : draft ? null : <p>{t('Aucun kit pour l’instant.')}</p>}
  </section>;
}
