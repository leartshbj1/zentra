import { useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { maxProducible, requirements } from './bom';
import { t, useAppLanguage } from './language';
import { availabilityForCatalogItem } from './orderFlow';
import type { CatalogItem, Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatDate, formatMoney, todayIso } from './utils';
import './erp-registers.css';

const quantity = (milli: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(milli / 1000);
const parseQuantity = (value: string) => { const milli = Math.round(Number(value.replace(',', '.')) * 1000); return Number.isFinite(milli) && milli > 0 ? milli : null; };
type Draft = { output: string; notes: string; lines: { componentItemId: string; quantity: string }[] };

/** Nomenclatures et production : les composants d'un produit fini, puis la fabrication en un clic. */
export function BomPanel({ workspace, readOnly, onWorkspace, productId, suggestedMilli }: { workspace: Workspace; readOnly: boolean; onWorkspace: (workspace: Workspace) => void; productId?: string | null; suggestedMilli?: number | null }) {
  useAppLanguage();
  const products = workspace.catalogItems.filter(item => !item.archivedAt && item.kind === 'product');
  const components = workspace.catalogItems.filter(item => !item.archivedAt);
  const boms = workspace.billsOfMaterials ?? [];
  const [itemId, setItemId] = useState(productId ?? boms[0]?.catalogItemId ?? products[0]?.id ?? '');
  const bom = boms.find(row => row.catalogItemId === itemId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toMake, setToMake] = useState(suggestedMilli ? String(suggestedMilli / 1000) : '1');
  const [date, setDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const available = (item: CatalogItem) => availabilityForCatalogItem(item, workspace.stockReservationEvents, workspace.stockAvailability).availableMilli;
  const makeMilli = parseQuantity(toMake);
  const needs = useMemo(() => bom && makeMilli ? requirements(bom, makeMilli, workspace.catalogItems, available) : [], [bom, makeMilli, workspace.catalogItems, workspace.stockReservationEvents, workspace.stockAvailability]);
  const short = needs.filter(row => row.availableMilli !== null && row.needMilli > row.availableMilli);
  const product = workspace.catalogItems.find(row => row.id === itemId);
  const history = (workspace.productionOrders ?? []).filter(order => order.catalogItemId === itemId).slice(0, 10);
  const draftValid = !!draft && parseQuantity(draft.output) !== null && draft.lines.length > 0 && draft.lines.every(line => line.componentItemId && line.componentItemId !== itemId && parseQuantity(line.quantity) !== null);

  async function run(action: () => Promise<Workspace>, done: string) {
    setBusy(true);
    setMessage('');
    try {
      onWorkspace(await action());
      setMessage(done);
      return true;
    } catch (reason) {
      setMessage(errorMessage(reason, t('L’opération n’a pas pu être enregistrée.')));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const startEditing = () => setDraft(bom
    ? { output: String(bom.outputQuantityMilli / 1000), notes: bom.notes, lines: bom.lines.map(line => ({ componentItemId: line.componentItemId, quantity: String(line.quantityMilli / 1000) })) }
    : { output: '1', notes: '', lines: [{ componentItemId: '', quantity: '1' }] });

  return <section className="erp-register" aria-labelledby="bom-title">
    <h2 id="bom-title">{t('Nomenclatures et production')}</h2>
    <p>{t('Décrivez de quoi est fait un produit fini. Une production sort les composants du stock et y entre le produit fini, en une seule fois.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Choisissez le produit fini et listez ses composants avec la quantité pour un lot (par exemple 1 table : 1 plateau, 4 pieds, 16 vis).')}</li>
        <li>{t('Indiquez combien vous en fabriquez : Zentra calcule les besoins, vérifie le stock et le coût des composants.')}</li>
        <li>{t('Les composants non suivis en stock (vis, main-d’œuvre) comptent dans le coût, sans mouvement de stock.')}</li>
      </ol>
    </details>
    {message ? <p role="status">{message}</p> : null}
    <div className="erp-register__form">
      <Field label={t('Produit fini')}><select value={itemId} disabled={busy} onChange={event => { setItemId(event.target.value); setDraft(null); }}>
        {products.map(item => <option key={item.id} value={item.id}>{item.name}{boms.some(row => row.catalogItemId === item.id) ? '' : ` · ${t('sans nomenclature')}`}</option>)}
      </select></Field>
    </div>
    {draft ? <div className="erp-register__form">
      <Field label={t('Quantité produite par ce lot')}><input inputMode="decimal" value={draft.output} disabled={busy} onChange={event => setDraft({ ...draft, output: event.target.value })} /></Field>
      <div className="erp-register__wide"><h3>{t('Composants')}</h3></div>
      {draft.lines.map((line, index) => <div key={index} className="erp-register__wide erp-register__actions erp-register__actions--fields">
        <Field label={t('Composant')}><select value={line.componentItemId} disabled={busy} onChange={event => { const lines = [...draft.lines]; lines[index] = { ...line, componentItemId: event.target.value }; setDraft({ ...draft, lines }); }}>
          <option value="">{t('Choisir un article')}</option>
          {components.filter(item => item.id !== itemId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></Field>
        <Field label={t('Quantité')}><input inputMode="decimal" value={line.quantity} disabled={busy} onChange={event => { const lines = [...draft.lines]; lines[index] = { ...line, quantity: event.target.value }; setDraft({ ...draft, lines }); }} /></Field>
        <Button type="button" variant="ghost" size="small" disabled={busy || draft.lines.length === 1} onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, other) => other !== index) })}>{t('Retirer')}</Button>
      </div>)}
      <div className="erp-register__wide"><Button type="button" variant="secondary" size="small" disabled={busy} onClick={() => setDraft({ ...draft, lines: [...draft.lines, { componentItemId: '', quantity: '1' }] })}>{t('Ajouter un composant')}</Button></div>
      <div className="erp-register__wide"><Field label={t('Notes de fabrication')}><textarea rows={2} maxLength={2000} value={draft.notes} disabled={busy} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></Field></div>
      <div className="erp-register__actions">
        <Button type="button" disabled={busy || !draftValid} onClick={() => void run(() => desktopApi.saveBom({ catalogItemId: itemId, outputQuantityMilli: parseQuantity(draft.output) ?? 1000, notes: draft.notes,
          lines: draft.lines.map(line => ({ componentItemId: line.componentItemId, quantityMilli: parseQuantity(line.quantity) ?? 0 })) }), t('Nomenclature enregistrée.')).then(ok => { if (ok) setDraft(null); })}>{t('Enregistrer la nomenclature')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
      </div>
    </div> : bom ? <>
      <p>{t('Pour {quantity} {unit} : {list}', { quantity: quantity(bom.outputQuantityMilli), unit: product?.unit ?? '', list: bom.lines.map(line => `${quantity(line.quantityMilli)} ${workspace.catalogItems.find(item => item.id === line.componentItemId)?.name ?? ''}`).join(', ') })}</p>
      {bom.notes ? <p>{bom.notes}</p> : null}
      <div className="erp-register__actions"><Button type="button" variant="ghost" disabled={readOnly || busy} onClick={startEditing}>{t('Modifier la nomenclature')}</Button></div>
      <h3>{t('Produire')}</h3>
      <p>{t('Avec le stock actuel : {n} {unit} au plus.', { n: maxProducible(bom, workspace.catalogItems, available), unit: product?.unit ?? '' })}</p>
      <div className="erp-register__form">
        <Field label={t('Quantité à produire')}><input inputMode="decimal" value={toMake} disabled={busy} aria-invalid={!makeMilli} onChange={event => setToMake(event.target.value)} /></Field>
        <Field label={t('Date')}><input type="date" value={date} disabled={busy} onChange={event => setDate(event.target.value)} /></Field>
        <Field label={t('Référence')}><input value={reference} maxLength={200} placeholder={t('Ordre de fabrication')} disabled={busy} onChange={event => setReference(event.target.value)} /></Field>
        {needs.length ? <ul className="erp-register__wide erp-register__list" aria-label={t('Besoins en composants')}>
          {needs.map(row => <li key={row.componentItemId}>
            <span><strong>{row.item?.name ?? ''}</strong><small>{row.availableMilli === null ? t('{need} {unit} · non suivi en stock', { need: quantity(row.needMilli), unit: row.item?.unit ?? '' })
              : t('{need} {unit} sur {available} disponibles', { need: quantity(row.needMilli), unit: row.item?.unit ?? '', available: quantity(row.availableMilli) })}</small></span>
            <span className="erp-register__amount">{formatMoney(row.costCents)}</span>
          </li>)}
        </ul> : null}
        {needs.length ? <p className="erp-register__wide">{t('Coût des composants : {amount}', { amount: formatMoney(needs.reduce((sum, row) => sum + row.costCents, 0)) })}{short.length ? ` · ${t('Stock insuffisant : {items}.', { items: short.map(row => row.item?.name ?? '').join(', ') })}` : ''}</p> : null}
        <div className="erp-register__actions">
          <Button type="button" disabled={readOnly || busy || !makeMilli || short.length > 0} onClick={() => void run(() => desktopApi.recordProduction({ catalogItemId: itemId, quantityMilli: makeMilli ?? 0, productionDate: date, reference }),
            t('Production enregistrée : {quantity} {unit} de {item}.', { quantity: quantity(makeMilli ?? 0), unit: product?.unit ?? '', item: product?.name ?? '' }))}>{t('Enregistrer la production')}</Button>
        </div>
      </div>
      {history.length ? <details>
        <summary>{t('Productions ({n})', { n: history.length })}</summary>
        <ul className="erp-register__list">{history.map(order => <li key={order.id}>
          <span><strong>{formatDate(order.productionDate)} · {quantity(order.quantityMilli)} {product?.unit ?? ''}</strong><small>{[order.reference, order.components.map(row => `${quantity(row.quantityMilli)} ${row.name}`).join(', ')].filter(Boolean).join(' · ')}</small></span>
          <span />
        </li>)}</ul>
      </details> : null}
    </> : itemId ? <div className="erp-register__actions"><Button type="button" variant="secondary" disabled={readOnly || busy} onClick={startEditing}>{t('Créer la nomenclature')}</Button></div> : <p>{t('Ajoutez d’abord un produit au catalogue.')}</p>}
  </section>;
}
