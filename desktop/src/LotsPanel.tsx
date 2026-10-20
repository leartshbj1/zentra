import { useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import { lotBalances, splitSerials } from './stockLocations';
import type { Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatDate, todayIso } from './utils';
import './erp-registers.css';

const quantity = (milli: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(milli / 1000);
type Draft = { direction: 'in' | 'out'; codes: string; quantity: string; movementDate: string; expiryDate: string; warehouseId: string; reference: string; deliveryNoteId: string };

/** Lots et numéros de série : d'où vient chaque pièce et à qui elle a été livrée. */
export function LotsPanel({ workspace, readOnly, onWorkspace, deliveryNoteId }: { workspace: Workspace; readOnly: boolean; onWorkspace: (workspace: Workspace) => void; deliveryNoteId?: string | null }) {
  useAppLanguage();
  const locations = workspace.stockLocations ?? { warehouses: [], movementWarehouses: {}, transfers: [], tracking: [], lots: [], lotMovements: [] };
  const products = workspace.catalogItems.filter(item => !item.archivedAt && item.kind === 'product');
  const tracked = products.filter(item => locations.tracking.some(row => row.catalogItemId === item.id));
  const delivery = deliveryNoteId ? workspace.deliveryNotes.find(note => note.id === deliveryNoteId) : undefined;
  const [itemId, setItemId] = useState(tracked[0]?.id ?? '');
  const [draft, setDraft] = useState<Draft | null>(delivery ? { direction: 'out', codes: '', quantity: '1', movementDate: delivery.deliveryDate, expiryDate: '', warehouseId: '', reference: delivery.number, deliveryNoteId: delivery.id } : null);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const mode = locations.tracking.find(row => row.catalogItemId === itemId)?.mode ?? null;
  const balances = useMemo(() => lotBalances(locations, itemId || undefined), [locations, itemId]);
  const item = workspace.catalogItems.find(row => row.id === itemId);
  const codes = draft ? (mode === 'serial' ? splitSerials(draft.codes) : [draft.codes.trim()].filter(Boolean)) : [];
  const milli = mode === 'serial' ? 1_000 : Math.round(Number((draft?.quantity ?? '').replace(',', '.')) * 1000);
  const issuedDeliveries = workspace.deliveryNotes.filter(note => note.status === 'issued').sort((a, b) => b.deliveryDate.localeCompare(a.deliveryDate)).slice(0, 30);
  const found = search.trim() ? locations.lots.filter(lot => lot.code.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 10) : [];

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
  async function submit() {
    if (!draft || !codes.length || !(milli > 0)) return;
    const out = draft.direction === 'out';
    const ok = await run(() => desktopApi.recordLotMovement({ catalogItemId: itemId, codes, quantityMilli: out ? -milli : milli, movementDate: draft.movementDate,
      expiryDate: !out && draft.expiryDate ? draft.expiryDate : null, warehouseId: !out && draft.warehouseId ? draft.warehouseId : null,
      sourceType: out ? (draft.deliveryNoteId ? 'delivery' : 'exit') : 'entry', sourceId: out && draft.deliveryNoteId ? draft.deliveryNoteId : null, reference: draft.reference }),
    out ? t('{n} sortie(s) enregistrée(s).', { n: codes.length }) : t('{n} entrée(s) enregistrée(s).', { n: codes.length }));
    if (ok) setDraft(null);
  }
  const history = (lotId: string) => locations.lotMovements.filter(row => row.lotId === lotId).sort((a, b) => a.movementDate.localeCompare(b.movementDate));

  return <section className="erp-register" aria-labelledby="lots-title">
    <h2 id="lots-title">{t('Lots et numéros de série')}</h2>
    <p>{t('Pour les articles suivis, notez le lot ou le numéro de série à l’entrée et à la livraison : vous retrouvez ensuite d’où vient chaque pièce et à qui elle a été livrée.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Choisissez le suivi de l’article : par lot (avec date d’expiration) ou par numéro de série (une pièce par numéro).')}</li>
        <li>{t('À la réception, notez les lots ou collez la liste des numéros de série.')}</li>
        <li>{t('Après une livraison, Autopilote vous rappelle de noter les numéros livrés avec le bon de livraison.')}</li>
      </ol>
    </details>
    {message ? <p role="status">{message}</p> : null}
    {delivery ? <p role="status">{t('Bon de livraison {number} : notez les lots ou numéros livrés.', { number: delivery.number })}</p> : null}
    <div className="erp-register__form">
      <Field label={t('Article')}><select value={itemId} disabled={busy} onChange={event => { setItemId(event.target.value); setDraft(current => current && { ...current, codes: '' }); }}>
        <option value="">{t('Choisir un produit')}</option>
        {products.map(row => <option key={row.id} value={row.id}>{row.name}{locations.tracking.some(track => track.catalogItemId === row.id) ? '' : ` · ${t('non suivi')}`}</option>)}
      </select></Field>
      <Field label={t('Suivi')}><select value={mode ?? ''} disabled={readOnly || busy || !itemId || balances.length > 0} onChange={event => void run(() => desktopApi.setItemTracking(itemId, (event.target.value || null) as 'lot' | 'serial' | null), t('Suivi enregistré.'))}>
        <option value="">{t('Pas de suivi')}</option>
        <option value="lot">{t('Par lot')}</option>
        <option value="serial">{t('Par numéro de série')}</option>
      </select></Field>
    </div>
    {mode && !draft ? <div className="erp-register__actions">
      <Button type="button" variant="secondary" disabled={readOnly || busy} onClick={() => setDraft({ direction: 'in', codes: '', quantity: '1', movementDate: todayIso(), expiryDate: '', warehouseId: '', reference: '', deliveryNoteId: '' })}>{t('Noter une entrée')}</Button>
      <Button type="button" variant="secondary" disabled={readOnly || busy || !balances.some(row => row.balanceMilli > 0)} onClick={() => setDraft({ direction: 'out', codes: '', quantity: '1', movementDate: todayIso(), expiryDate: '', warehouseId: '', reference: '', deliveryNoteId: '' })}>{t('Noter une sortie')}</Button>
    </div> : null}
    {mode && draft ? <div className="erp-register__form">
      <p className="erp-register__wide">{draft.direction === 'in' ? t('Entrée de {item}', { item: item?.name ?? '' }) : t('Sortie de {item}', { item: item?.name ?? '' })}</p>
      {mode === 'serial'
        ? <div className="erp-register__wide"><Field label={t('Numéros de série (un par ligne)')}><textarea rows={3} value={draft.codes} disabled={busy} onChange={event => setDraft({ ...draft, codes: event.target.value })} /></Field></div>
        : <>
          <Field label={t('Numéro de lot')}>{draft.direction === 'out'
            ? <select value={draft.codes} disabled={busy} onChange={event => setDraft({ ...draft, codes: event.target.value })}><option value="">{t('Choisir un lot')}</option>{balances.filter(row => row.balanceMilli > 0).map(row => <option key={row.lot.id} value={row.lot.code}>{row.lot.code} · {quantity(row.balanceMilli)}</option>)}</select>
            : <input value={draft.codes} maxLength={80} disabled={busy} onChange={event => setDraft({ ...draft, codes: event.target.value })} />}</Field>
          <Field label={t('Quantité')}><input inputMode="decimal" value={draft.quantity} disabled={busy} onChange={event => setDraft({ ...draft, quantity: event.target.value })} /></Field>
          {draft.direction === 'in' ? <Field label={t('Expire le')}><input type="date" value={draft.expiryDate} disabled={busy} onChange={event => setDraft({ ...draft, expiryDate: event.target.value })} /></Field> : null}
        </>}
      {draft.direction === 'in' && locations.warehouses.some(row => !row.archivedAt) ? <Field label={t('Dépôt')}><select value={draft.warehouseId} disabled={busy} onChange={event => setDraft({ ...draft, warehouseId: event.target.value })}><option value="">{t('Dépôt principal')}</option>{locations.warehouses.filter(row => !row.archivedAt).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field> : null}
      {draft.direction === 'out' ? <Field label={t('Bon de livraison')}><select value={draft.deliveryNoteId} disabled={busy} onChange={event => { const note = issuedDeliveries.find(row => row.id === event.target.value); setDraft({ ...draft, deliveryNoteId: event.target.value, reference: note?.number ?? draft.reference, movementDate: note?.deliveryDate ?? draft.movementDate }); }}>
        <option value="">{t('Sans bon de livraison')}</option>
        {issuedDeliveries.map(note => <option key={note.id} value={note.id}>{note.number} · {formatDate(note.deliveryDate)}</option>)}
      </select></Field> : null}
      <Field label={t('Date')}><input type="date" value={draft.movementDate} disabled={busy} onChange={event => setDraft({ ...draft, movementDate: event.target.value })} /></Field>
      <Field label={t('Pièce ou référence')}><input value={draft.reference} maxLength={200} placeholder={draft.direction === 'in' ? t('Bon de réception') : t('Bon de livraison')} disabled={busy} onChange={event => setDraft({ ...draft, reference: event.target.value })} /></Field>
      <div className="erp-register__actions">
        <Button type="button" disabled={busy || !codes.length || !(milli > 0)} onClick={() => void submit()}>{busy ? t('Enregistrement…') : mode === 'serial' ? t('Enregistrer {n} numéro(s)', { n: codes.length }) : t('Enregistrer')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
      </div>
    </div> : null}
    {mode ? balances.length ? <ul className="erp-register__list" aria-label={t('Lots et numéros en stock')}>
      {balances.map(row => <li key={row.lot.id}>
        <span><strong>{row.lot.code}</strong><small>{[row.lot.expiryDate ? t('expire le {date}', { date: formatDate(row.lot.expiryDate) }) : '', row.lastReference].filter(Boolean).join(' · ') || t('Aucune pièce notée')}</small></span>
        <span className="erp-register__amount">{row.balanceMilli > 0 ? `${quantity(row.balanceMilli)} ${item?.unit ?? ''}` : t('Sorti')}</span>
      </li>)}
    </ul> : <p>{t('Aucun lot ni numéro noté pour cet article.')}</p> : tracked.length ? null : <p>{t('Aucun article suivi pour le moment.')}</p>}
    <h3>{t('Retrouver un numéro')}</h3>
    <Field label={t('Lot ou numéro de série')}><input value={search} maxLength={80} onChange={event => setSearch(event.target.value)} /></Field>
    {found.length ? <ul className="erp-register__list">{found.map(lot => <li key={lot.id}>
      <span><strong>{lot.code} · {workspace.catalogItems.find(row => row.id === lot.catalogItemId)?.name ?? ''}</strong>
        <small>{history(lot.id).map(row => `${formatDate(row.movementDate)} ${row.quantityMilli > 0 ? '+' : ''}${quantity(row.quantityMilli)}${row.reference ? ` (${row.reference})` : ''}`).join(' · ')}</small></span>
      <span />
    </li>)}</ul> : search.trim() ? <p>{t('Aucun lot ni numéro trouvé.')}</p> : null}
  </section>;
}
