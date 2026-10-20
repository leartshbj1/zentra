import { useState } from 'react';
import { desktopApi } from './bridge';
import { parseBudgetAmount } from './budget';
import { t, useAppLanguage } from './language';
import { parseDiscountPercent, type PriceList } from './priceLists';
import type { Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatMoney } from './utils';
import './erp-registers.css';

type Draft = { id: string | null; name: string; discount: string; items: { catalogItemId: string; price: string }[]; clientIds: string[] };

/** Listes de prix : un rabais sur tout le catalogue et des prix fixes par article, pour certains clients. */
export function PriceListsPanel({ workspace, readOnly, onWorkspace }: { workspace: Workspace; readOnly: boolean; onWorkspace: (workspace: Workspace) => void }) {
  useAppLanguage();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const lists = workspace.priceLists ?? [];
  const items = workspace.catalogItems.filter(item => !item.archivedAt);
  const clients = workspace.clients.filter(client => !client.archivedAt);
  const clientName = (id: string) => { const client = workspace.clients.find(row => row.id === id); return client?.company || client?.name || ''; };
  const edit = (list?: PriceList) => setDraft(list
    ? { id: list.id, name: list.name, discount: String(list.discountBp / 100), items: list.items.map(item => ({ catalogItemId: item.catalogItemId, price: (item.unitPriceCents / 100).toFixed(2) })), clientIds: [...list.clientIds] }
    : { id: null, name: '', discount: '0', items: [], clientIds: [] });
  const discountBp = draft ? parseDiscountPercent(draft.discount) : null;
  const prices = draft?.items.map(item => parseBudgetAmount(item.price)) ?? [];
  const valid = !!draft && !!draft.name.trim() && discountBp !== null && prices.every(price => price !== null) && draft.items.every(item => item.catalogItemId)
    && new Set(draft.items.map(item => item.catalogItemId)).size === draft.items.length;
  async function save(archived = false) {
    if (!draft || !valid || discountBp === null) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await desktopApi.savePriceList({ id: draft.id, name: draft.name, discountBp, archived,
        items: draft.items.map((item, index) => ({ catalogItemId: item.catalogItemId, unitPriceCents: prices[index] ?? 0 })), clientIds: draft.clientIds });
      onWorkspace(result.workspace);
      setMessage(archived ? t('Liste de prix archivée.') : t('Liste de prix enregistrée.'));
      setDraft(null);
    } catch (reason) {
      setMessage(errorMessage(reason, t('La liste de prix n’a pas pu être enregistrée.')));
    } finally {
      setBusy(false);
    }
  }
  const otherList = (clientId: string) => lists.find(list => !list.archivedAt && list.id !== draft?.id && list.clientIds.includes(clientId));
  return <section className="erp-register" aria-labelledby="price-lists-title">
    <h2 id="price-lists-title">{t('Listes de prix')}</h2>
    <p>{t('Donnez à certains clients un rabais sur tout le catalogue ou un prix fixe pour des articles. Zentra l’applique quand vous ajoutez un article à leurs devis, factures et rapports.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Créez une liste (par exemple Revendeurs) avec un rabais en pour cent.')}</li>
        <li>{t('Ajoutez au besoin un prix fixe pour certains articles : il remplace le rabais pour cet article.')}</li>
        <li>{t('Cochez les clients concernés. Le rabais reste visible sur la ligne du document ; vous pouvez toujours la modifier.')}</li>
      </ol>
    </details>
    {message ? <p role="status">{message}</p> : null}
    {draft ? <div className="erp-register__form">
      <Field label={t('Nom de la liste')}><input value={draft.name} maxLength={80} placeholder={t('Revendeurs')} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label={t('Rabais sur le catalogue, en %')}><input inputMode="decimal" value={draft.discount} disabled={busy} aria-invalid={discountBp === null} onChange={event => setDraft({ ...draft, discount: event.target.value })} /></Field>
      <div className="erp-register__wide">
        <h3>{t('Prix fixes')}</h3>
        {draft.items.length ? null : <p>{t('Aucun prix fixe : le rabais vaut pour tous les articles.')}</p>}
      </div>
      {draft.items.map((item, index) => <div key={index} className="erp-register__wide erp-register__actions erp-register__actions--fields">
        <Field label={t('Article')}><select value={item.catalogItemId} disabled={busy} onChange={event => { const next = [...draft.items]; const chosen = items.find(row => row.id === event.target.value); next[index] = { catalogItemId: event.target.value, price: item.price || (chosen ? (chosen.salesPriceCents / 100).toFixed(2) : '') }; setDraft({ ...draft, items: next }); }}>
          <option value="">{t('Choisir un article')}</option>
          {items.map(row => <option key={row.id} value={row.id}>{row.name} · {formatMoney(row.salesPriceCents)}</option>)}
        </select></Field>
        <Field label={t('Prix pour ces clients, CHF')}><input inputMode="decimal" value={item.price} disabled={busy} aria-invalid={prices[index] === null} onChange={event => { const next = [...draft.items]; next[index] = { ...item, price: event.target.value }; setDraft({ ...draft, items: next }); }} /></Field>
        <Button type="button" variant="ghost" size="small" disabled={busy} onClick={() => setDraft({ ...draft, items: draft.items.filter((_, other) => other !== index) })}>{t('Retirer')}</Button>
      </div>)}
      <div className="erp-register__wide"><Button type="button" variant="secondary" size="small" disabled={busy || !items.length} onClick={() => setDraft({ ...draft, items: [...draft.items, { catalogItemId: '', price: '' }] })}>{t('Ajouter un prix fixe')}</Button></div>
      <fieldset className="erp-register__wide erp-register__choices">
        <legend>{t('Clients')}</legend>
        {clients.length ? clients.map(client => {
          const other = otherList(client.id);
          return <label key={client.id}><input type="checkbox" checked={draft.clientIds.includes(client.id)} disabled={busy}
            onChange={event => setDraft({ ...draft, clientIds: event.target.checked ? [...draft.clientIds, client.id] : draft.clientIds.filter(id => id !== client.id) })} />
            <span>{client.company || client.name}{other ? <small>{t('aujourd’hui : {name}', { name: other.name })}</small> : null}</span></label>;
        }) : <p>{t('Aucun client pour le moment.')}</p>}
      </fieldset>
      <div className="erp-register__actions">
        <Button type="button" disabled={busy || !valid} onClick={() => void save()}>{busy ? t('Enregistrement…') : t('Enregistrer la liste')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
        {draft.id ? <Button type="button" variant="ghost" disabled={busy || !valid} onClick={() => void save(true)}>{t('Archiver')}</Button> : null}
      </div>
    </div> : <div className="erp-register__actions"><Button type="button" variant="secondary" disabled={readOnly || busy} onClick={() => edit()}>{t('Nouvelle liste de prix')}</Button></div>}
    {lists.filter(list => !list.archivedAt).length ? <ul className="erp-register__list" aria-label={t('Listes de prix')}>
      {lists.filter(list => !list.archivedAt).map(list => <li key={list.id}>
        <span><strong>{list.name}</strong><small>{[list.discountBp ? t('Rabais {percent} %', { percent: list.discountBp / 100 }) : t('Sans rabais'), t('{n} prix fixe(s)', { n: list.items.length }),
          list.clientIds.length ? list.clientIds.slice(0, 3).map(clientName).join(', ') + (list.clientIds.length > 3 ? ` +${list.clientIds.length - 3}` : '') : t('aucun client')].join(' · ')}</small></span>
        <Button type="button" variant="ghost" size="small" disabled={readOnly || busy || !!draft} onClick={() => edit(list)}>{t('Modifier')}</Button>
      </li>)}
    </ul> : draft ? null : <p>{t('Aucune liste de prix : tous les clients ont les prix du catalogue.')}</p>}
  </section>;
}
