import { useMemo, useState } from 'react';
import { t, getAppLocale, useAppLanguage } from './language';
import { CollectionPagination, useCollectionPage } from './CollectionPagination';
import './catalog-screen.css';
import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowUpToLine,
  Box,
  FileSpreadsheet,
  History,
  Package,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';
import {
  CatalogImportWizard,
  type CatalogImportConflictPolicy,
} from './CatalogImportWizard';
import type { CatalogImportRow } from './catalogImport';
import { availabilityForCatalogItem } from './orderFlow';
import {
  filterCatalogItems,
  formatCatalogQuantity,
  isCatalogItemLowOnStock,
  stockMovementsForItem,
  type CatalogKindFilter,
  type CatalogVisibilityFilter,
} from './catalog';
import type {
  CatalogItem,
  StockMovement,
  StockMovementType,
  StockAvailability,
  StockReservationEvent,
} from './types';
import {
  formatDate,
  formatMoney,
} from './utils';
import {
  Button,
  EmptyState,
  StatusBadge,
} from './ui';

export function CatalogScreen({
  items,
  vatRatesBp,
  movements,
  reservationEvents,
  availabilityRows,
  query,
  busy,
  readOnly,
  onQueryChange,
  onCreate,
  onEdit,
  onStockMovement,
  onArchive,
  onRestore,
  onImport,
  workspaceScope,
}: {
  items: CatalogItem[];
  vatRatesBp: number[];
  movements: StockMovement[];
  reservationEvents: StockReservationEvent[];
  availabilityRows: StockAvailability[];
  query: string;
  busy: boolean;
  readOnly: boolean;
  workspaceScope?: string;
  onQueryChange: (query: string) => void;
  onCreate: () => void;
  onEdit: (item: CatalogItem) => void;
  onStockMovement: (item: CatalogItem, movementType: StockMovementType) => void;
  onArchive: (item: CatalogItem) => void;
  onRestore: (item: CatalogItem) => void;
  onImport: (
    rows: CatalogImportRow[],
    conflictPolicy: CatalogImportConflictPolicy,
    onError?: (reason: unknown) => void,
    expectedWorkspaceScope?: string,
  ) => Promise<boolean>;
}) {
  useAppLanguage();
  const [kind, setKind] = useState<CatalogKindFilter>('all');
  const [visibility, setVisibility] = useState<CatalogVisibilityFilter>('active');
  const [historyItemId, setHistoryItemId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtered = useMemo(
    () => filterCatalogItems(items, query, kind, visibility),
    [items, query, kind, visibility],
  );
  const availabilityById = useMemo(() => {
    const events = new Map<string, StockReservationEvent[]>();
    for (const event of reservationEvents) {
      const group = events.get(event.catalogItemId) ?? [];
      group.push(event); events.set(event.catalogItemId, group);
    }
    const rows = new Map<string, StockAvailability>();
    for (const row of availabilityRows) if (!rows.has(row.catalogItemId)) rows.set(row.catalogItemId, row);
    return new Map(items.map(item => [item.id, availabilityForCatalogItem(item, events.get(item.id) ?? [], rows.has(item.id) ? [rows.get(item.id)!] : [])]));
  }, [items, reservationEvents, availabilityRows]);
  const availability = (item: CatalogItem) => availabilityById.get(item.id)!;
  const { active, trackedProducts, lowStock } = useMemo(() => {
    const active = items.filter(item => !item.archivedAt);
    return { active, trackedProducts: active.filter(item => item.kind === 'product' && item.trackStock),
      lowStock: active.filter(item => isCatalogItemLowOnStock(item, availabilityById.get(item.id)!.availableMilli)) };
  }, [items, availabilityById]);
  const pagination = useCollectionPage(filtered, JSON.stringify([query, kind, visibility]), 20);
  const filterCount = Number(Boolean(query.trim())) + Number(kind !== 'all') + Number(visibility !== 'active');
  const resultLabel = query.trim()
    ? t(filtered.length === 1 ? '{count} résultat pour « {query} »' : '{count} résultats pour « {query} »', { count: filtered.length, query: query.trim() })
    : t(filtered.length === 1 ? '{count} référence affichée' : '{count} références affichées', { count: filtered.length });
  const headingActions = <div className="catalog-heading-actions">
    <Button disabled={readOnly || busy} onClick={onCreate}>
      <Plus size={16} /> {t('Nouvelle référence')}
    </Button>
    <Button variant="secondary" disabled={readOnly || busy} onClick={() => setImportOpen(true)}>
      <FileSpreadsheet size={16} /> {t('Importer Excel')}
    </Button>
  </div>;

  return (
    <>
    <div className="stack-layout catalog-screen">
      <section className="panel catalog-panel">
        {headingActions}
      {items.length > 0 && <details className="catalog-overview">
        <summary>{t('Résumé du catalogue')} · {active.length}</summary>
        <div className="summary-strip catalog-summary">
        <div>
          <span>{t('Références actives')}</span>
          <strong>{active.length}</strong>
        </div>
        <div>
          <span>{t('Produits suivis')}</span>
          <strong>{trackedProducts.length}</strong>
        </div>
        <div>
          <span>{t('Alertes de stock')}</span>
          <strong className={lowStock.length ? 'is-negative' : ''}>{lowStock.length}</strong>
        </div>
      </div></details>}
        {lowStock.length ? (
          <div className="stock-alert" role="status">
            <AlertTriangle size={19} />
            <div>
              <strong>
                {t(lowStock.length === 1 ? '{count} produit au seuil ou en rupture' : '{count} produits au seuil ou en rupture', { count: lowStock.length })}
              </strong>
              <p>
                {lowStock
                  .slice(0, 4)
                  .map((item) => `${item.name} (${t('Disponible : {quantity} {unit}', { quantity: formatQuantity(availability(item).availableMilli), unit: item.unit })})`)
                  .join(' · ')}
                {lowStock.length > 4 ? ` · +${lowStock.length - 4}` : ''}
              </p>
            </div>
          </div>
        ) : null}
        {items.length > 0 && <>
        <div className="catalog-list-toolbar" ref={pagination.startRef} tabIndex={-1}>
          <p role="status" aria-atomic="true">{resultLabel}</p>
          <Button variant="secondary" aria-expanded={filtersOpen} aria-controls="catalog-filters" onClick={() => setFiltersOpen(!filtersOpen)}>
            <SlidersHorizontal size={16} aria-hidden="true" /> {t('Rechercher et filtrer')}{filterCount > 0 ? ` (${filterCount})` : ''}
          </Button>
        </div>
        <div id="catalog-filters" className="catalog-filters" role="group" aria-label={t('Filtres du catalogue')} hidden={!filtersOpen}>
          <label className="catalog-filter-search">
            <span>{t('Recherche')}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t('Nom, référence, description…')}
            />
          </label>
          <label>
            <span>{t('Type')}</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as CatalogKindFilter)}
            >
              <option value="all">{t('Tous les types')}</option>
              <option value="product">{t('Produits')}</option>
              <option value="service">{t('Services')}</option>
            </select>
          </label>
          <label>
            <span>{t('État')}</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as CatalogVisibilityFilter)}
            >
              <option value="active">{t('Actifs')}</option>
              <option value="archived">{t('Archivés')}</option>
              <option value="all">{t('Tous')}</option>
            </select>
          </label>
          {filterCount > 0 && <Button variant="ghost" onClick={() => { onQueryChange(''); setKind('all'); setVisibility('active'); }}>{t('Réinitialiser les filtres')}</Button>}
        </div>
        <CollectionPagination pagination={pagination} label={t('Pages du catalogue')} />
        </>}

        {filtered.length ? (
          <div className="catalog-list" role="list">
            {pagination.items.map((item) => {
              const tracked = item.kind === 'product' && item.trackStock;
              const stock = availability(item);
              const low = isCatalogItemLowOnStock(item, stock.availableMilli);
              const itemMovements = stockMovementsForItem(movements, item.id);
              const historyOpen = historyItemId === item.id;
              const ItemIcon = item.kind === 'product' ? Box : Wrench;
              return (
                <article
                  key={item.id}
                  className={`catalog-item ${item.archivedAt ? 'is-archived' : ''}`}
                  role="listitem"
                >
                  <div className="catalog-item__icon">
                    <ItemIcon size={19} />
                  </div>
                  <div className="catalog-item__identity">
                    <div>
                      <strong>{item.name}</strong>
                      {item.sku ? <code>{item.sku}</code> : null}
                    </div>
                    <p>
                      {item.description
                        || (item.kind === 'product'
                          ? t('Produit sans description')
                          : t('Service sans description'))}
                    </p>
                    <small>
                      {item.unit} · {t('TVA')} {(item.vatBp / 100).toLocaleString(getAppLocale())} %
                    </small>
                  </div>
                  <div className="catalog-item__price">
                    <span>{t('Prix de vente hors TVA')}</span>
                    <strong>{formatMoney(item.salesPriceCents)}</strong>
                    <small>{t('Coût {amount}', { amount: formatMoney(item.purchaseCostCents) })}</small>
                  </div>
                  <div className="catalog-item__stock">
                    <span>{t(tracked ? 'Quantités' : 'Suivi de stock')}</span>
                    {tracked ? (
                      <div className="catalog-stock-balances" aria-label={t('Stock de {name}', { name: item.name })}>
                        <small><span>{t('Présent')}</span><strong>{formatQuantity(stock.onHandMilli)}</strong></small>
                        <small><span>{t('Réservé')}</span><strong>{formatQuantity(stock.reservedMilli)}</strong></small>
                        <small><span>{t('Disponible')}</span><strong>{formatQuantity(stock.availableMilli)}</strong></small>
                      </div>
                    ) : <strong>{t('Non suivi')}</strong>}
                    {low ? (
                      <small className="is-warning">
                        <AlertTriangle size={12} />
                        {stock.availableMilli <= 0
                          ? t('Rupture de stock')
                          : t('Seuil {quantity}', { quantity: formatQuantity(item.reorderLevelMilli) })}
                      </small>
                    ) : tracked ? (
                      <small>{t('Seuil {quantity}', { quantity: formatQuantity(item.reorderLevelMilli) })}</small>
                    ) : item.kind === 'service' ? (
                      <small>{t('Prestation sans stock')}</small>
                    ) : (
                      <small>{t('Suivi désactivé dans la fiche')}</small>
                    )}
                  </div>
                  <div className="catalog-item__state">
                    <StatusBadge
                      status={item.archivedAt ? 'incomplete' : 'validated'}
                      label={t(
                        item.archivedAt
                          ? 'Archivé'
                          : item.kind === 'product'
                            ? 'Produit'
                            : 'Service'
                      )}
                    />
                    {item.archivedAt ? (
                      <small>{t('depuis le {date}', { date: formatDate(item.archivedAt) })}</small>
                    ) : null}
                  </div>
                  <div className="catalog-item__actions">
                    <Button disabled={readOnly || busy}
                      variant="ghost"
                      size="small"
                      onClick={() => onEdit(item)}
                      aria-label={t('Modifier {name}', { name: item.name })}
                    >
                      <Pencil size={14} /> {t('Modifier')}
                    </Button>
                    {item.archivedAt ? (
                      <Button disabled={readOnly || busy}
                        variant="secondary"
                        size="small"
                        onClick={() => onRestore(item)}
                        aria-label={t('Réactiver {name}', { name: item.name })}
                      >
                        <RotateCcw size={14} /> {t('Réactiver')}
                      </Button>
                    ) : (
                      <Button disabled={readOnly || busy}
                        variant="ghost"
                        size="small"
                        onClick={() => onArchive(item)}
                        aria-label={t('Archiver {name}', { name: item.name })}
                      >
                        <Archive size={14} /> {t('Archiver')}
                      </Button>
                    )}
                  </div>
                  {tracked ? (
                    <div className="catalog-item__movement-actions">
                      <span>{t('Mouvements')}</span>
                      {!item.archivedAt ? (
                        <>
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={readOnly || busy}
                            onClick={() => onStockMovement(item, 'entry')}
                          >
                            <ArrowDownToLine size={14} /> {t('Entrée')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={readOnly || busy || stock.availableMilli <= 0}
                            onClick={() => onStockMovement(item, 'exit')}
                          >
                            <ArrowUpToLine size={14} /> {t('Sortie')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="small"
                            disabled={readOnly || busy}
                            onClick={() => onStockMovement(item, 'correction')}
                          >
                            <RotateCcw size={14} /> {t('Inventaire')}
                          </Button>
                        </>
                      ) : null}
                      <Button
                        className="catalog-history-button"
                        variant="ghost"
                        size="small"
                        aria-expanded={historyOpen}
                        onClick={() => setHistoryItemId(historyOpen ? null : item.id)}
                      >
                        <History size={14} /> {t('Historique ({count})', { count: itemMovements.length })}
                      </Button>
                    </div>
                  ) : null}
                  {tracked && historyOpen ? (
                    <StockHistory item={item} movements={itemMovements} />
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={<Package size={26} />}
            title={t(!items.length ? 'Vos produits et prestations' : visibility === 'archived' ? 'Aucune référence archivée' : 'Aucun résultat')}
            text={
              t(items.length
                ? 'Aucune référence ne correspond à la recherche et aux filtres.'
                : 'Ajoutez une référence ou importez votre catalogue Excel pour réutiliser vos prix dans les devis et factures.')
            }
            actionLabel={items.length && (query.trim() || kind !== 'all' || visibility !== 'active') ? t('Réinitialiser les filtres') : undefined}
            onAction={() => { onQueryChange(''); setKind('all'); setVisibility('active'); }}
            actionVariant="secondary"
          />
        )}
        <CollectionPagination pagination={pagination} label={t('Pages du catalogue')} announce={false} />
      </section>
    </div>
    {importOpen ? (
      <CatalogImportWizard
        workspaceScope={workspaceScope}
        existingItems={items}
        vatRatesBp={vatRatesBp}
        busy={busy}
        readOnly={readOnly}
        close={() => setImportOpen(false)}
        onImport={onImport}
      />
    ) : null}
    </>
  );
}

function StockHistory({
  item,
  movements,
}: {
  item: CatalogItem;
  movements: StockMovement[];
}) {
  return (
    <section className="stock-history" aria-label={t('Historique de stock de {name}', { name: item.name })}>
      <header>
        <span><ShieldCheck size={17} /></span>
        <div>
          <strong>{t('Historique du stock')}</strong>
          <p>{t('Une ligne enregistrée ne se modifie pas. Toute rectification crée une correction distincte.')}</p>
        </div>
      </header>
      {movements.length ? (
        <div className="stock-history__list">
          {movements.map((movement) => (
            <article key={movement.id}>
              <div className={`stock-history__delta ${movement.quantityDeltaMilli < 0 ? 'is-negative' : 'is-positive'}`}>
                <strong>{formatSignedQuantity(movement.quantityDeltaMilli)}</strong>
                <small>{item.unit}</small>
              </div>
              <div className="stock-history__description">
                <strong>{t(stockMovementLabel(movement))}</strong>
                <p>{movement.reason}</p>
                <small>
                  {formatDate(movement.movementDate)}
                  {movement.reference ? ` · ${t('Réf. {reference}', { reference: movement.reference })}` : ''}
                </small>
              </div>
              <div className="stock-history__balance">
                <span>{t('Solde après')}</span>
                <strong>{formatQuantity(movement.balanceAfterMilli)} {item.unit}</strong>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="stock-history__empty">
          <History size={18} />
          <span>{t('Aucun mouvement enregistré.')}</span>
        </div>
      )}
    </section>
  );
}

function stockMovementLabel(movement: StockMovement): string {
  if (movement.sourceType === 'opening') return 'Solde d’ouverture';
  if (movement.sourceType === 'invoice') return 'Sortie automatique · facture émise';
  if (movement.sourceType === 'delivery') return 'Sortie automatique · bon de livraison';
  if (movement.sourceType === 'delivery_reversal') return 'Retour · bon de livraison extourné';
  if (movement.sourceType === 'receipt') return 'Entrée · réception fournisseur';
  if (movement.sourceType === 'receipt_reversal') return 'Extourne · réception fournisseur';
  if (movement.movementType === 'entry') return 'Entrée manuelle';
  if (movement.movementType === 'exit') return 'Sortie manuelle';
  return 'Correction manuelle';
}

function formatSignedQuantity(quantityMilli: number): string {
  return `${quantityMilli > 0 ? '+' : ''}${formatQuantity(quantityMilli)}`;
}

function formatQuantity(milli: number): string { return formatCatalogQuantity(milli, getAppLocale()); }

export { StockMovementForm } from './StockMovementForm';

export { CatalogItemForm } from './CatalogItemForm';
