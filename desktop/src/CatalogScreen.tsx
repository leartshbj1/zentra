import { useMemo, useState } from 'react';
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
  SectionHeading,
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
}: {
  items: CatalogItem[];
  vatRatesBp: number[];
  movements: StockMovement[];
  reservationEvents: StockReservationEvent[];
  availabilityRows: StockAvailability[];
  query: string;
  busy: boolean;
  readOnly: boolean;
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
  ) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<CatalogKindFilter>('all');
  const [visibility, setVisibility] = useState<CatalogVisibilityFilter>('active');
  const [historyItemId, setHistoryItemId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const filtered = useMemo(
    () => filterCatalogItems(items, query, kind, visibility),
    [items, query, kind, visibility],
  );
  const active = items.filter((item) => !item.archivedAt);
  const trackedProducts = active.filter(
    (item) => item.kind === 'product' && item.trackStock,
  );
  const availability = (item: CatalogItem) =>
    availabilityForCatalogItem(item, reservationEvents, availabilityRows);
  const lowStock = active.filter((item) =>
    isCatalogItemLowOnStock(item, availability(item).availableMilli),
  );

  return (
    <>
    <div className="stack-layout catalog-screen">
      <div className="summary-strip catalog-summary" aria-label="Résumé du catalogue">
        <div>
          <span>Références actives</span>
          <strong>{active.length}</strong>
        </div>
        <div>
          <span>Produits suivis</span>
          <strong>{trackedProducts.length}</strong>
        </div>
        <div>
          <span>Alertes de stock</span>
          <strong className={lowStock.length ? 'is-negative' : ''}>{lowStock.length}</strong>
        </div>
      </div>

      <section className="panel catalog-panel">
        <SectionHeading
          eyebrow="Catalogue et stock réel"
          title="Produits & services"
          description="Retrouvez vos produits et prestations, leurs prix et les quantités disponibles. Chaque entrée, sortie ou inventaire reste consultable dans l’historique."
          action={
            <div className="catalog-heading-actions">
              <Button
                variant="secondary"
                disabled={readOnly || busy}
                onClick={() => setImportOpen(true)}
              >
                <FileSpreadsheet size={16} /> Importer Excel
              </Button>
              <Button disabled={readOnly || busy} onClick={onCreate}>
                <Plus size={16} /> Nouvelle référence
              </Button>
            </div>
          }
        />
        {lowStock.length ? (
          <div className="stock-alert" role="status">
            <AlertTriangle size={19} />
            <div>
              <strong>
                {lowStock.length} produit{lowStock.length > 1 ? 's sont' : ' est'} au seuil ou en rupture
              </strong>
              <p>
                {lowStock
                  .slice(0, 4)
                  .map((item) => `${item.name} (${formatCatalogQuantity(availability(item).availableMilli)} ${item.unit} disponible)`)
                  .join(' · ')}
                {lowStock.length > 4 ? ` · +${lowStock.length - 4}` : ''}
              </p>
            </div>
          </div>
        ) : null}
        <div className="catalog-filters" role="group" aria-label="Filtres du catalogue">
          <label className="catalog-filter-search">
            <span>Recherche</span>
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Nom, référence, description…"
            />
          </label>
          <label>
            <span>Type</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as CatalogKindFilter)}
            >
              <option value="all">Tous les types</option>
              <option value="product">Produits</option>
              <option value="service">Services</option>
            </select>
          </label>
          <label>
            <span>État</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as CatalogVisibilityFilter)}
            >
              <option value="active">Actifs</option>
              <option value="archived">Archivés</option>
              <option value="all">Tous</option>
            </select>
          </label>
          <p>
            {query.trim()
              ? `${filtered.length} résultat${filtered.length > 1 ? 's' : ''} pour « ${query.trim()} »`
              : `${filtered.length} référence${filtered.length > 1 ? 's' : ''} affichée${filtered.length > 1 ? 's' : ''}`}
          </p>
        </div>

        {filtered.length ? (
          <div className="catalog-list" role="list">
            {filtered.map((item) => {
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
                          ? 'Produit sans description'
                          : 'Service sans description')}
                    </p>
                    <small>
                      {item.unit} · TVA {(item.vatBp / 100).toLocaleString('fr-CH')} %
                    </small>
                  </div>
                  <div className="catalog-item__price">
                    <span>Prix de vente hors TVA</span>
                    <strong>{formatMoney(item.salesPriceCents)}</strong>
                    <small>Coût {formatMoney(item.purchaseCostCents)}</small>
                  </div>
                  <div className="catalog-item__stock">
                    <span>{tracked ? 'Quantités' : 'Suivi de stock'}</span>
                    {tracked ? (
                      <div className="catalog-stock-balances" aria-label={`Stock de ${item.name}`}>
                        <small><span>Présent</span><strong>{formatCatalogQuantity(stock.onHandMilli)}</strong></small>
                        <small><span>Réservé</span><strong>{formatCatalogQuantity(stock.reservedMilli)}</strong></small>
                        <small><span>Disponible</span><strong>{formatCatalogQuantity(stock.availableMilli)}</strong></small>
                      </div>
                    ) : <strong>Non suivi</strong>}
                    {low ? (
                      <small className="is-warning">
                        <AlertTriangle size={12} />
                        {stock.availableMilli <= 0
                          ? 'Rupture de stock'
                          : `Seuil ${formatCatalogQuantity(item.reorderLevelMilli)}`}
                      </small>
                    ) : tracked ? (
                      <small>Seuil {formatCatalogQuantity(item.reorderLevelMilli)}</small>
                    ) : item.kind === 'service' ? (
                      <small>Prestation sans stock</small>
                    ) : (
                      <small>Suivi désactivé dans la fiche</small>
                    )}
                  </div>
                  <div className="catalog-item__state">
                    <StatusBadge
                      status={item.archivedAt ? 'incomplete' : 'validated'}
                      label={
                        item.archivedAt
                          ? 'Archivé'
                          : item.kind === 'product'
                            ? 'Produit'
                            : 'Service'
                      }
                    />
                    {item.archivedAt ? (
                      <small>depuis le {formatDate(item.archivedAt)}</small>
                    ) : null}
                  </div>
                  <div className="catalog-item__actions">
                    <Button disabled={readOnly || busy}
                      variant="ghost"
                      size="small"
                      onClick={() => onEdit(item)}
                      aria-label={`Modifier ${item.name}`}
                    >
                      <Pencil size={14} /> Modifier
                    </Button>
                    {item.archivedAt ? (
                      <Button disabled={readOnly || busy}
                        variant="secondary"
                        size="small"
                        onClick={() => onRestore(item)}
                        aria-label={`Réactiver ${item.name}`}
                      >
                        <RotateCcw size={14} /> Réactiver
                      </Button>
                    ) : (
                      <Button disabled={readOnly || busy}
                        variant="ghost"
                        size="small"
                        onClick={() => onArchive(item)}
                        aria-label={`Archiver ${item.name}`}
                      >
                        <Archive size={14} /> Archiver
                      </Button>
                    )}
                  </div>
                  {tracked ? (
                    <div className="catalog-item__movement-actions">
                      <span>Mouvements</span>
                      {!item.archivedAt ? (
                        <>
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={readOnly || busy}
                            onClick={() => onStockMovement(item, 'entry')}
                          >
                            <ArrowDownToLine size={14} /> Entrée
                          </Button>
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={readOnly || busy || stock.availableMilli <= 0}
                            onClick={() => onStockMovement(item, 'exit')}
                          >
                            <ArrowUpToLine size={14} /> Sortie
                          </Button>
                          <Button
                            variant="ghost"
                            size="small"
                            disabled={readOnly || busy}
                            onClick={() => onStockMovement(item, 'correction')}
                          >
                            <RotateCcw size={14} /> Inventaire
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
                        <History size={14} /> Historique ({itemMovements.length})
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
          <EmptyState disabled={readOnly || busy}
            icon={<Package size={26} />}
            title={visibility === 'archived' ? 'Aucune référence archivée' : 'Catalogue vide'}
            text={
              query.trim()
                ? 'Aucune référence ne correspond à la recherche et aux filtres.'
                : 'Ajoutez vos produits et prestations une seule fois, puis réutilisez-les dans les documents.'
            }
            actionLabel="Créer une référence"
            onAction={onCreate}
          />
        )}
      </section>
    </div>
    {importOpen ? (
      <CatalogImportWizard
        existingItems={items}
        vatRatesBp={vatRatesBp}
        busy={busy || readOnly}
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
    <section className="stock-history" aria-label={`Historique de stock de ${item.name}`}>
      <header>
        <span><ShieldCheck size={17} /></span>
        <div>
          <strong>Historique du stock</strong>
          <p>Une ligne enregistrée ne se modifie pas. Toute rectification crée une correction distincte.</p>
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
                <strong>{stockMovementLabel(movement)}</strong>
                <p>{movement.reason}</p>
                <small>
                  {formatDate(movement.movementDate)}
                  {movement.reference ? ` · Réf. ${movement.reference}` : ''}
                </small>
              </div>
              <div className="stock-history__balance">
                <span>Solde après</span>
                <strong>{formatCatalogQuantity(movement.balanceAfterMilli)} {item.unit}</strong>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="stock-history__empty">
          <History size={18} />
          <span>Aucun mouvement enregistré. Le produit a été créé avec un stock de 0,000 {item.unit}.</span>
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
  return `${quantityMilli > 0 ? '+' : ''}${formatCatalogQuantity(quantityMilli)}`;
}

export { StockMovementForm } from './StockMovementForm';

export { CatalogItemForm } from './CatalogItemForm';
