import { useMemo, useState } from 'react';
import { AlertTriangle, Archive, Box, Package, Pencil, Plus, RotateCcw, Wrench } from 'lucide-react';
import { desktopApi } from './bridge';
import {
  catalogQuantityFromInput,
  filterCatalogItems,
  formatCatalogQuantity,
  isCatalogItemLowOnStock,
  type CatalogKindFilter,
  type CatalogVisibilityFilter,
} from './catalog';
import type { AppSettings, CatalogItem, Workspace } from './types';
import { centsFromInput, formatDate, formatMoney } from './utils';
import { Button, EmptyState, Field, FormActions, Modal, SectionHeading, StatusBadge, submitForm } from './ui';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>;

export function CatalogScreen({
  items,
  query,
  onQueryChange,
  onCreate,
  onEdit,
  onArchive,
  onRestore,
}: {
  items: CatalogItem[];
  query: string;
  onQueryChange: (query: string) => void;
  onCreate: () => void;
  onEdit: (item: CatalogItem) => void;
  onArchive: (item: CatalogItem) => void;
  onRestore: (item: CatalogItem) => void;
}) {
  const [kind, setKind] = useState<CatalogKindFilter>('all');
  const [visibility, setVisibility] = useState<CatalogVisibilityFilter>('active');
  const filtered = useMemo(() => filterCatalogItems(items, query, kind, visibility), [items, query, kind, visibility]);
  const active = items.filter((item) => !item.archivedAt);
  const lowStock = active.filter(isCatalogItemLowOnStock);

  return <div className="stack-layout catalog-screen">
    <div className="summary-strip catalog-summary" aria-label="Résumé du catalogue">
      <div><span>Références actives</span><strong>{active.length}</strong></div>
      <div><span>Produits · services</span><strong>{active.filter((item) => item.kind === 'product').length} · {active.filter((item) => item.kind === 'service').length}</strong></div>
      <div><span>Alertes de stock indicatives</span><strong className={lowStock.length ? 'is-negative' : ''}>{lowStock.length}</strong></div>
    </div>

    <section className="panel catalog-panel">
      <SectionHeading
        eyebrow="Saisie rapide"
        title="Produits & services"
        description="Une référence remplit une ligne de devis ou de facture, puis cette ligne reste indépendante et figée avec le document."
        action={<Button onClick={onCreate}><Plus size={16} /> Nouvelle référence</Button>}
      />
      <div className="catalog-filters" role="group" aria-label="Filtres du catalogue">
        <label className="catalog-filter-search"><span>Recherche</span><input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Nom, SKU, description…" /></label>
        <label><span>Type</span><select value={kind} onChange={(event) => setKind(event.target.value as CatalogKindFilter)}><option value="all">Tous les types</option><option value="product">Produits</option><option value="service">Services</option></select></label>
        <label><span>État</span><select value={visibility} onChange={(event) => setVisibility(event.target.value as CatalogVisibilityFilter)}><option value="active">Actifs</option><option value="archived">Archivés</option><option value="all">Tous</option></select></label>
        <p>{query.trim() ? `${filtered.length} résultat${filtered.length > 1 ? 's' : ''} pour « ${query.trim()} »` : `${filtered.length} référence${filtered.length > 1 ? 's' : ''} affichée${filtered.length > 1 ? 's' : ''}`}</p>
      </div>

      {filtered.length ? <div className="catalog-list" role="list">
        {filtered.map((item) => {
          const low = isCatalogItemLowOnStock(item);
          const ItemIcon = item.kind === 'product' ? Box : Wrench;
          return <article key={item.id} className={`catalog-item ${item.archivedAt ? 'is-archived' : ''}`} role="listitem">
            <div className="catalog-item__icon"><ItemIcon size={19} /></div>
            <div className="catalog-item__identity"><div><strong>{item.name}</strong>{item.sku ? <code>{item.sku}</code> : null}</div><p>{item.description || (item.kind === 'product' ? 'Produit sans description' : 'Service sans description')}</p><small>{item.unit} · TVA {(item.vatBp / 100).toLocaleString('fr-CH')} %</small></div>
            <div className="catalog-item__price"><span>Prix de vente</span><strong>{formatMoney(item.salesPriceCents)}</strong><small>Coût {formatMoney(item.purchaseCostCents)}</small></div>
            <div className="catalog-item__stock"><span>{item.trackStock ? 'Stock indicatif' : 'Suivi de stock'}</span><strong>{item.trackStock ? `${formatCatalogQuantity(item.stockQuantityMilli)} ${item.unit}` : 'Non suivi'}</strong>{low ? <small className="is-warning"><AlertTriangle size={12} /> Seuil {formatCatalogQuantity(item.reorderLevelMilli)}</small> : null}</div>
            <div className="catalog-item__state"><StatusBadge status={item.archivedAt ? 'incomplete' : 'validated'} label={item.archivedAt ? 'Archivé' : item.kind === 'product' ? 'Produit' : 'Service'} />{item.archivedAt ? <small>depuis le {formatDate(item.archivedAt)}</small> : null}</div>
            <div className="catalog-item__actions"><Button variant="ghost" size="small" onClick={() => onEdit(item)} aria-label={`Modifier ${item.name}`}><Pencil size={14} /> Modifier</Button>{item.archivedAt ? <Button variant="secondary" size="small" onClick={() => onRestore(item)} aria-label={`Réactiver ${item.name}`}><RotateCcw size={14} /> Réactiver</Button> : <Button variant="ghost" size="small" onClick={() => onArchive(item)} aria-label={`Archiver ${item.name}`}><Archive size={14} /> Archiver</Button>}</div>
          </article>;
        })}
      </div> : <EmptyState icon={<Package size={26} />} title={visibility === 'archived' ? 'Aucune référence archivée' : 'Catalogue vide'} text={query.trim() ? 'Aucune référence ne correspond à la recherche et aux filtres.' : 'Ajoutez vos produits et prestations une seule fois, puis réutilisez-les dans les documents.'} actionLabel="Créer une référence" onAction={onCreate} />}
    </section>
  </div>;
}

export function CatalogItemForm({
  item,
  settings,
  busy,
  close,
  act,
}: {
  item?: CatalogItem;
  settings: AppSettings;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const [kind, setKind] = useState<CatalogItem['kind']>(item?.kind ?? 'service');
  const [trackStock, setTrackStock] = useState(Boolean(item?.trackStock));
  const vatRates = settings.organization.vatRegistered ? settings.billing.vatRatesBp : [0];
  const defaultVat = item?.vatBp ?? (settings.organization.vatRegistered ? settings.billing.vatRatesBp[0] ?? 0 : 0);

  return <Modal title={item ? `Modifier ${item.name}` : 'Nouveau produit ou service'} description="Les valeurs choisies seront copiées dans chaque nouvelle ligne; les documents existants ne changeront jamais." onClose={close} wide>
    <form onSubmit={submitForm(async (form) => {
      const stockEnabled = kind === 'product' && form.get('trackStock') === 'on';
      const data = {
        kind,
        sku: String(form.get('sku')).trim() || null,
        name: String(form.get('name')).trim(),
        description: String(form.get('description')).trim(),
        unit: String(form.get('unit')).trim(),
        salesPriceCents: centsFromInput(form.get('salesPrice')),
        purchaseCostCents: centsFromInput(form.get('purchaseCost')),
        vatBp: Number(form.get('vatBp')),
        trackStock: stockEnabled,
        stockQuantityMilli: stockEnabled ? catalogQuantityFromInput(form.get('stockQuantity')) : 0,
        reorderLevelMilli: stockEnabled ? catalogQuantityFromInput(form.get('reorderLevel')) : 0,
      };
      await act(
        () => item ? desktopApi.updateEntity('catalogItems', item.id, data) : desktopApi.createEntity('catalogItems', data),
        item ? 'La référence du catalogue a été mise à jour.' : 'La référence a été ajoutée au catalogue.',
      );
    })}>
      <div className="catalog-kind-picker" role="radiogroup" aria-label="Type de référence">
        <label className={kind === 'product' ? 'is-selected' : ''}><input type="radio" name="kind" value="product" checked={kind === 'product'} onChange={() => setKind('product')} /><Box size={19} /><span><strong>Produit</strong><small>Bien vendu, avec stock indicatif facultatif</small></span></label>
        <label className={kind === 'service' ? 'is-selected' : ''}><input type="radio" name="kind" value="service" checked={kind === 'service'} onChange={() => { setKind('service'); setTrackStock(false); }} /><Wrench size={19} /><span><strong>Service</strong><small>Prestation, heure, forfait ou intervention</small></span></label>
      </div>
      <div className="form-grid">
        <Field label="Nom" required wide><input name="name" defaultValue={item?.name} maxLength={200} required autoFocus /></Field>
        <Field label="Référence / SKU" hint="Facultative, mais utile pour la recherche."><input name="sku" defaultValue={item?.sku ?? ''} maxLength={80} /></Field>
        <Field label="Unité" required hint="Ex. pièce, heure, forfait, m²"><input name="unit" defaultValue={item?.unit} maxLength={40} required /></Field>
        <Field label="Description" wide><textarea name="description" rows={3} defaultValue={item?.description} maxLength={2_000} /></Field>
        <Field label="Prix de vente (CHF)" required><input name="salesPrice" type="number" min="0" step="0.01" defaultValue={item ? item.salesPriceCents / 100 : ''} required /></Field>
        <Field label="Coût d’achat (CHF)" required hint="Utilisé pour votre référence interne."><input name="purchaseCost" type="number" min="0" step="0.01" defaultValue={item ? item.purchaseCostCents / 100 : '0'} required /></Field>
        <Field label="TVA" required><select name="vatBp" defaultValue={defaultVat} required>{vatRates.map((rate) => <option key={rate} value={rate}>{rate === 0 ? '0 % · exonéré / non assujetti' : `${(rate / 100).toLocaleString('fr-CH')} %`}</option>)}</select></Field>
      </div>
      {kind === 'product' ? <section className="catalog-stock-form">
        <label className="module-toggle module-toggle--compact"><input name="trackStock" type="checkbox" checked={trackStock} onChange={(event) => setTrackStock(event.target.checked)} /><span><Package size={19} /><strong>Suivre un stock indicatif</strong><small>Quantité et seuil saisis manuellement; aucun mouvement automatique</small></span></label>
        {trackStock ? <div className="form-grid"><Field label="Quantité disponible" required><input name="stockQuantity" type="number" min="0" step="0.001" defaultValue={item ? item.stockQuantityMilli / 1_000 : '0'} required /></Field><Field label="Seuil d’alerte" required><input name="reorderLevel" type="number" min="0" step="0.001" defaultValue={item ? item.reorderLevelMilli / 1_000 : '0'} required /></Field></div> : null}
      </section> : null}
      {item?.archivedAt ? <div className="info-strip"><Archive size={17} /><span>Cette référence est archivée. Elle reste modifiable pour l’historique, mais n’est plus proposée dans les nouveaux documents.</span></div> : null}
      <FormActions onCancel={close} busy={busy} submitLabel={item ? 'Enregistrer les modifications' : 'Ajouter au catalogue'} />
    </form>
  </Modal>;
}
