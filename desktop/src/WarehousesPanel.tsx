import { useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import { warehouseStock, type Warehouse } from './stockLocations';
import type { Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatDate, todayIso } from './utils';
import './erp-registers.css';

const quantity = (milli: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(milli / 1000);
type Draft = { id: string | null; code: string; name: string; isDefault: boolean };
type Transfer = { catalogItemId: string; fromWarehouseId: string; toWarehouseId: string; quantity: string; transferDate: string; note: string };

/** Dépôts : le stock par lieu (atelier, camionnette, chantier) et les transferts entre eux. */
export function WarehousesPanel({ workspace, readOnly, onWorkspace }: { workspace: Workspace; readOnly: boolean; onWorkspace: (workspace: Workspace) => void }) {
  useAppLanguage();
  const locations = workspace.stockLocations ?? { warehouses: [], movementWarehouses: {}, transfers: [], tracking: [], lots: [], lotMovements: [] };
  const active = locations.warehouses.filter(row => !row.archivedAt);
  const fallback = active.find(row => row.isDefault);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const stock = useMemo(() => warehouseStock(locations, workspace.stockMovements), [locations, workspace.stockMovements]);
  const products = workspace.catalogItems.filter(item => !item.archivedAt && item.kind === 'product' && item.trackStock);
  const name = (id: string) => locations.warehouses.find(row => row.id === id)?.name ?? '';
  const transferMilli = transfer ? Math.round(Number(transfer.quantity.replace(',', '.')) * 1000) : 0;
  const transferValid = !!transfer && !!transfer.catalogItemId && !!transfer.fromWarehouseId && !!transfer.toWarehouseId && transfer.fromWarehouseId !== transfer.toWarehouseId && transferMilli > 0;

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
  const save = async (warehouse: Draft, archived = false) => {
    if (await run(() => desktopApi.saveWarehouse({ id: warehouse.id, code: warehouse.code, name: warehouse.name, isDefault: warehouse.isDefault, archived }), archived ? t('Dépôt archivé.') : t('Dépôt enregistré.'))) setDraft(null);
  };
  const edit = (warehouse?: Warehouse) => setDraft(warehouse ? { id: warehouse.id, code: warehouse.code, name: warehouse.name, isDefault: warehouse.isDefault } : { id: null, code: '', name: '', isDefault: !active.length });
  const recent = [...workspace.stockMovements].sort((a, b) => b.sequence - a.sequence).slice(0, 15);

  return <section className="erp-register" aria-labelledby="warehouses-title">
    <h2 id="warehouses-title">{t('Dépôts')}</h2>
    <p>{t('Suivez où se trouve votre stock : atelier, camionnette, chantier. Les entrées et sorties vont au dépôt principal ; un transfert déplace la marchandise d’un dépôt à l’autre.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Créez vos dépôts ; le premier devient le dépôt principal.')}</li>
        <li>{t('Quand vous chargez la camionnette ou livrez un chantier, enregistrez un transfert.')}</li>
        <li>{t('Un mouvement fait ailleurs se place dans le bon dépôt depuis la liste des derniers mouvements.')}</li>
      </ol>
    </details>
    {message ? <p role="status">{message}</p> : null}
    {active.length ? <ul className="erp-register__list" aria-label={t('Dépôts')}>
      {active.map(warehouse => <li key={warehouse.id}>
        <span><strong>{warehouse.code} · {warehouse.name}</strong><small>{warehouse.isDefault ? t('Dépôt principal') : t('Dépôt')}</small></span>
        <Button type="button" variant="ghost" size="small" disabled={readOnly || busy || !!draft} onClick={() => edit(warehouse)}>{t('Modifier')}</Button>
      </li>)}
    </ul> : <p>{t('Aucun dépôt : tout le stock est compté au même endroit.')}</p>}
    {draft ? <div className="erp-register__form">
      <Field label={t('Code')}><input value={draft.code} maxLength={12} placeholder="VAN-1" disabled={busy} onChange={event => setDraft({ ...draft, code: event.target.value })} /></Field>
      <Field label={t('Nom')}><input value={draft.name} maxLength={80} placeholder={t('Camionnette')} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
      <label className="erp-register__wide erp-register__switch"><input type="checkbox" checked={draft.isDefault} disabled={busy || (!!draft.id && !!locations.warehouses.find(row => row.id === draft.id)?.isDefault)} onChange={event => setDraft({ ...draft, isDefault: event.target.checked })} /><span>{t('Dépôt principal (reçoit les entrées et les sorties)')}</span></label>
      <div className="erp-register__actions">
        <Button type="button" disabled={busy || !draft.code.trim() || !draft.name.trim()} onClick={() => void save(draft)}>{t('Enregistrer le dépôt')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
        {draft.id && !draft.isDefault ? <Button type="button" variant="ghost" disabled={busy} onClick={() => void save(draft, true)}>{t('Archiver')}</Button> : null}
      </div>
    </div> : <div className="erp-register__actions">
      <Button type="button" variant="secondary" disabled={readOnly || busy} onClick={() => edit()}>{t('Nouveau dépôt')}</Button>
      {active.length > 1 && products.length ? <Button type="button" variant="secondary" disabled={readOnly || busy} onClick={() => setTransfer({ catalogItemId: products[0].id, fromWarehouseId: fallback?.id ?? active[0].id, toWarehouseId: active.find(row => row.id !== (fallback?.id ?? active[0].id))?.id ?? '', quantity: '', transferDate: todayIso(), note: '' })}>{t('Transférer du stock')}</Button> : null}
    </div>}
    {transfer ? <div className="erp-register__form">
      <div className="erp-register__wide"><Field label={t('Article')}><select value={transfer.catalogItemId} disabled={busy} onChange={event => setTransfer({ ...transfer, catalogItemId: event.target.value })}>{products.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
      <Field label={t('De')}><select value={transfer.fromWarehouseId} disabled={busy} onChange={event => setTransfer({ ...transfer, fromWarehouseId: event.target.value })}>{active.map(row => <option key={row.id} value={row.id}>{row.name} · {quantity(stock.get(transfer.catalogItemId)?.get(row.id) ?? 0)}</option>)}</select></Field>
      <Field label={t('Vers')}><select value={transfer.toWarehouseId} disabled={busy} onChange={event => setTransfer({ ...transfer, toWarehouseId: event.target.value })}>{active.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
      <Field label={t('Quantité')}><input inputMode="decimal" value={transfer.quantity} disabled={busy} aria-invalid={transfer.quantity !== '' && transferMilli <= 0} onChange={event => setTransfer({ ...transfer, quantity: event.target.value })} /></Field>
      <Field label={t('Date')}><input type="date" value={transfer.transferDate} disabled={busy} onChange={event => setTransfer({ ...transfer, transferDate: event.target.value })} /></Field>
      <div className="erp-register__wide"><Field label={t('Note')}><input value={transfer.note} maxLength={500} placeholder={t('Chantier Morel')} disabled={busy} onChange={event => setTransfer({ ...transfer, note: event.target.value })} /></Field></div>
      <div className="erp-register__actions">
        <Button type="button" disabled={busy || !transferValid} onClick={() => void run(() => desktopApi.transferStock({ catalogItemId: transfer.catalogItemId, fromWarehouseId: transfer.fromWarehouseId, toWarehouseId: transfer.toWarehouseId, quantityMilli: transferMilli, transferDate: transfer.transferDate, note: transfer.note }), t('Transfert enregistré.')).then(ok => { if (ok) setTransfer(null); })}>{t('Transférer')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setTransfer(null)}>{t('Annuler')}</Button>
      </div>
    </div> : null}
    {active.length && products.length ? <>
      <h3>{t('Stock par dépôt')}</h3>
      <ul className="erp-register__list" aria-label={t('Stock par dépôt')}>
        {products.map(item => {
          const row = stock.get(item.id);
          const parts = active.map(warehouse => ({ warehouse, milli: row?.get(warehouse.id) ?? 0 })).filter(part => part.milli !== 0);
          return <li key={item.id}>
            <span><strong>{item.name}</strong><small>{parts.length ? parts.map(part => `${part.warehouse.name} ${quantity(part.milli)} ${item.unit}`).join(' · ') : t('Aucun stock')}</small>
              {parts.some(part => part.milli < 0) ? <small>{t('Quantité négative dans un dépôt : enregistrez le transfert manquant.')}</small> : null}</span>
            <span className="erp-register__amount">{quantity(parts.reduce((sum, part) => sum + part.milli, 0))} {item.unit}</span>
          </li>;
        })}
      </ul>
      <details>
        <summary>{t('Placer les derniers mouvements')}</summary>
        <ul className="erp-register__list">
          {recent.map(movement => {
            const item = workspace.catalogItems.find(row => row.id === movement.catalogItemId);
            return <li key={movement.id}>
              <span><strong>{item?.name ?? ''} · {movement.quantityDeltaMilli > 0 ? '+' : ''}{quantity(movement.quantityDeltaMilli)}</strong><small>{formatDate(movement.movementDate)} · {movement.reason}</small></span>
              <select aria-label={t('Dépôt du mouvement')} value={locations.movementWarehouses[movement.id] ?? fallback?.id ?? ''} disabled={readOnly || busy}
                onChange={event => void run(() => desktopApi.assignMovementWarehouse(movement.id, event.target.value), t('Mouvement placé au dépôt {name}.', { name: name(event.target.value) }))}>
                {active.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </li>;
          })}
        </ul>
      </details>
    </> : null}
  </section>;
}
