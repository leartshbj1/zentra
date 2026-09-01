import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowUpToLine,
  Box,
  History,
  Package,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { availabilityForCatalogItem } from './orderFlow';
import {
  catalogQuantityFromInput,
  catalogStockData,
  filterCatalogItems,
  formatCatalogQuantity,
  isCatalogItemLowOnStock,
  stockBalanceAfter,
  stockMovementError,
  stockMovementsForItem,
  stockQuantityFromInput,
  type CatalogKindFilter,
  type CatalogVisibilityFilter,
} from './catalog';
import type {
  AppSettings,
  CatalogItem,
  StockMovement,
  StockMovementType,
  StockAvailability,
  StockReservationEvent,
  Workspace,
} from './types';
import {
  centsFromInput,
  formatDate,
  formatMoney,
  todayIso,
} from './utils';
import {
  Button,
  EmptyState,
  ErrorPanel,
  Field,
  FormActions,
  Modal,
  SectionHeading,
  StatusBadge,
  submitForm,
} from './ui';

type ActionRunner = (
  action: () => Promise<Workspace>,
  message: string,
  close?: boolean,
) => Promise<boolean>;

export function CatalogScreen({
  items,
  movements,
  reservationEvents,
  availabilityRows,
  query,
  readOnly,
  onQueryChange,
  onCreate,
  onEdit,
  onStockMovement,
  onArchive,
  onRestore,
}: {
  items: CatalogItem[];
  movements: StockMovement[];
  reservationEvents: StockReservationEvent[];
  availabilityRows: StockAvailability[];
  query: string;
  readOnly: boolean;
  onQueryChange: (query: string) => void;
  onCreate: () => void;
  onEdit: (item: CatalogItem) => void;
  onStockMovement: (item: CatalogItem, movementType: StockMovementType) => void;
  onArchive: (item: CatalogItem) => void;
  onRestore: (item: CatalogItem) => void;
}) {
  const [kind, setKind] = useState<CatalogKindFilter>('all');
  const [visibility, setVisibility] = useState<CatalogVisibilityFilter>('active');
  const [historyItemId, setHistoryItemId] = useState<string | null>(null);
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
          description="Les produits suivis utilisent un registre de mouvements immuable. Les services ne modifient jamais le stock."
          action={
            <Button onClick={onCreate}>
              <Plus size={16} /> Nouvelle référence
            </Button>
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
              placeholder="Nom, SKU, description…"
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
                    <span>Prix de vente</span>
                    <strong>{formatMoney(item.salesPriceCents)}</strong>
                    <small>Coût {formatMoney(item.purchaseCostCents)}</small>
                  </div>
                  <div className="catalog-item__stock">
                    <span>{tracked ? 'Quantités' : 'Suivi de stock'}</span>
                    {tracked ? (
                      <div className="catalog-stock-balances" aria-label={`Stock de ${item.name}`}>
                        <small><span>En main</span><strong>{formatCatalogQuantity(stock.onHandMilli)}</strong></small>
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
                      <small>Jamais mouvementé</small>
                    ) : (
                      <small>Enregistrez la fiche pour l’activer</small>
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
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => onEdit(item)}
                      aria-label={`Modifier ${item.name}`}
                    >
                      <Pencil size={14} /> Modifier
                    </Button>
                    {item.archivedAt ? (
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => onRestore(item)}
                        aria-label={`Réactiver ${item.name}`}
                      >
                        <RotateCcw size={14} /> Réactiver
                      </Button>
                    ) : (
                      <Button
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
                            disabled={readOnly}
                            onClick={() => onStockMovement(item, 'entry')}
                          >
                            <ArrowDownToLine size={14} /> Entrée
                          </Button>
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={readOnly || stock.availableMilli <= 0}
                            onClick={() => onStockMovement(item, 'exit')}
                          >
                            <ArrowUpToLine size={14} /> Sortie
                          </Button>
                          <Button
                            variant="ghost"
                            size="small"
                            disabled={readOnly}
                            onClick={() => onStockMovement(item, 'correction')}
                          >
                            <RotateCcw size={14} /> Correction
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
          <EmptyState
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
          <strong>Historique immuable</strong>
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

export function StockMovementForm({
  item,
  movementType,
  requestId,
  reservedMilli = 0,
  busy,
  close,
  act,
}: {
  item: CatalogItem;
  movementType: StockMovementType;
  requestId: string;
  reservedMilli?: number;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const [quantity, setQuantity] = useState('');
  const [clientError, setClientError] = useState('');
  const enteredQuantityMilli = stockQuantityFromInput(quantity);
  const validationError = quantity
    ? stockMovementError(item, movementType, enteredQuantityMilli, reservedMilli)
    : '';
  const balanceAfter = enteredQuantityMilli === null
    ? item.stockQuantityMilli
    : stockBalanceAfter(item.stockQuantityMilli, movementType, enteredQuantityMilli);
  const config = movementConfig[movementType];
  const MovementIcon = config.icon;

  return (
    <Modal
      title={`${config.title} · ${item.name}`}
      description="Le mouvement sera ajouté au registre local avec un identifiant de requête stable. Le backend revérifie toujours le solde avant validation."
      onClose={close}
      wide
    >
      <form
        className="stock-movement-form"
        onSubmit={submitForm(async (form) => {
          const quantityMilli = stockQuantityFromInput(form.get('quantity'));
          const error = stockMovementError(
            item,
            movementType,
            quantityMilli,
            reservedMilli,
          );
          if (error || quantityMilli === null) {
            setClientError(error || 'La quantité est invalide.');
            return;
          }
          setClientError('');
          const common = {
            requestId,
            catalogItemId: item.id,
            reason: String(form.get('reason')).trim(),
            reference: String(form.get('reference')).trim(),
            date: String(form.get('date')),
          };
          const action = movementType === 'entry'
            ? () => desktopApi.recordStockEntry({ ...common, quantityMilli })
            : movementType === 'exit'
              ? () => desktopApi.recordStockExit({ ...common, quantityMilli })
              : () => desktopApi.recordStockCorrection({
                  ...common,
                  deltaQuantityMilli: quantityMilli,
                });
          await act(action, `${config.success} Nouveau solde : ${formatCatalogQuantity(balanceAfter)} ${item.unit}.`);
        })}
      >
        <div className="stock-movement-steps" aria-label="Étapes du mouvement">
          <span className="is-active">1 · Mouvement</span>
          <span>2 · Justification</span>
          <span>3 · Validation</span>
        </div>
        <section className="stock-movement-section">
          <header>
            <MovementIcon size={19} />
            <div>
              <strong>{config.title}</strong>
              <p>{config.description}</p>
            </div>
          </header>
          <div className="form-grid">
            <Field
              label={movementType === 'correction' ? 'Variation signée' : 'Quantité'}
              hint={movementType === 'correction'
                ? 'Ex. −2,500 pour diminuer ou 3,000 pour augmenter.'
                : 'Au maximum trois décimales.'}
              error={validationError || undefined}
              required
            >
              <input
                name="quantity"
                type="number"
                step="0.001"
                min={movementType === 'correction' ? undefined : '0.001'}
                max={movementType === 'exit' ? Math.max(0, item.stockQuantityMilli - reservedMilli) / 1_000 : undefined}
                value={quantity}
                onChange={(event) => {
                  setQuantity(event.target.value);
                  setClientError('');
                }}
                placeholder={movementType === 'correction' ? '-0.000' : '0.000'}
                autoFocus
                required
              />
            </Field>
            <Field label="Date" required>
              <input name="date" type="date" defaultValue={todayIso()} required />
            </Field>
            <Field label="Référence" hint="Bon de livraison, inventaire, commande…">
              <input name="reference" maxLength={200} />
            </Field>
            <Field label="Motif" wide required hint="Le motif restera visible dans l’historique.">
              <textarea name="reason" rows={3} maxLength={500} required />
            </Field>
          </div>
        </section>
        <div className={`stock-balance-preview ${balanceAfter < reservedMilli ? 'is-invalid' : ''}`}>
          <div>
            <span>En main actuellement</span>
            <strong>{formatCatalogQuantity(item.stockQuantityMilli)} {item.unit}</strong>
          </div>
          <span aria-hidden="true">→</span>
          <div>
            <span>Solde après validation</span>
            <strong>{formatCatalogQuantity(balanceAfter)} {item.unit}</strong>
          </div>
        </div>
        {reservedMilli > 0 ? (
          <p className="stock-request-id">
            {formatCatalogQuantity(reservedMilli)} {item.unit} réservé aux commandes · disponible après mouvement : {formatCatalogQuantity(balanceAfter - reservedMilli)}
          </p>
        ) : null}
        <p className="stock-request-id">Requête idempotente · {requestId}</p>
        {clientError ? <ErrorPanel message={clientError} /> : null}
        <FormActions
          onCancel={close}
          busy={busy}
          disabled={!quantity || Boolean(validationError)}
          submitLabel={config.submitLabel}
        />
      </form>
    </Modal>
  );
}

const movementConfig: Record<
  StockMovementType,
  {
    title: string;
    description: string;
    submitLabel: string;
    success: string;
    icon: typeof ArrowDownToLine;
  }
> = {
  entry: {
    title: 'Entrée de stock',
    description: 'Ajoute une quantité reçue au solde disponible.',
    submitLabel: 'Enregistrer l’entrée',
    success: 'L’entrée de stock a été enregistrée.',
    icon: ArrowDownToLine,
  },
  exit: {
    title: 'Sortie de stock',
    description: 'Retire une quantité du stock sans jamais autoriser un solde négatif.',
    submitLabel: 'Enregistrer la sortie',
    success: 'La sortie de stock a été enregistrée.',
    icon: ArrowUpToLine,
  },
  correction: {
    title: 'Correction de stock',
    description: 'Ajoute une variation signée et conserve le solde précédent dans l’historique.',
    submitLabel: 'Enregistrer la correction',
    success: 'La correction de stock a été enregistrée.',
    icon: RotateCcw,
  },
};

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
  const vatRates = settings.organization.vatRegistered
    ? settings.billing.vatRatesBp
    : [0];
  const defaultVat = item?.vatBp
    ?? (settings.organization.vatRegistered ? settings.billing.vatRatesBp[0] ?? 0 : 0);

  return (
    <Modal
      title={item ? `Modifier ${item.name}` : 'Nouveau produit ou service'}
      description="Les valeurs choisies seront copiées dans chaque nouvelle ligne; les documents existants ne changeront jamais."
      onClose={close}
      wide
    >
      <form
        onSubmit={submitForm(async (form) => {
          const stockData = catalogStockData(
            kind,
            catalogQuantityFromInput(form.get('reorderLevel')),
            Boolean(item),
          );
          const data = {
            kind,
            sku: String(form.get('sku')).trim() || null,
            name: String(form.get('name')).trim(),
            description: String(form.get('description')).trim(),
            unit: String(form.get('unit')).trim(),
            salesPriceCents: centsFromInput(form.get('salesPrice')),
            purchaseCostCents: centsFromInput(form.get('purchaseCost')),
            vatBp: Number(form.get('vatBp')),
            ...stockData,
          };
          await act(
            () => item
              ? desktopApi.updateEntity('catalogItems', item.id, data)
              : desktopApi.createEntity('catalogItems', data),
            item
              ? 'La référence du catalogue a été mise à jour sans modifier son solde.'
              : kind === 'product'
                ? 'Le produit suivi a été créé avec un stock de 0,000. Utilisez ensuite Entrée pour enregistrer le stock d’ouverture.'
                : 'Le service a été ajouté au catalogue sans suivi de stock.',
          );
        })}
      >
        <div className="catalog-kind-picker" role="radiogroup" aria-label="Type de référence">
          <label className={kind === 'product' ? 'is-selected' : ''}>
            <input
              type="radio"
              name="kind"
              value="product"
              checked={kind === 'product'}
              onChange={() => setKind('product')}
            />
            <Box size={19} />
            <span>
              <strong>Produit</strong>
              <small>Bien vendu avec solde et mouvements de stock réels</small>
            </span>
          </label>
          <label className={kind === 'service' ? 'is-selected' : ''}>
            <input
              type="radio"
              name="kind"
              value="service"
              checked={kind === 'service'}
              onChange={() => setKind('service')}
            />
            <Wrench size={19} />
            <span>
              <strong>Service</strong>
              <small>Prestation qui ne suit et ne mouvemente jamais le stock</small>
            </span>
          </label>
        </div>
        <div className="form-grid">
          <Field label="Nom" required wide>
            <input name="name" defaultValue={item?.name} maxLength={200} required autoFocus />
          </Field>
          <Field label="Référence / SKU" hint="Facultative, mais utile pour la recherche.">
            <input name="sku" defaultValue={item?.sku ?? ''} maxLength={80} />
          </Field>
          <Field label="Unité" required hint="Ex. pièce, heure, forfait, m²">
            <input name="unit" defaultValue={item?.unit} maxLength={40} required />
          </Field>
          <Field label="Description" wide>
            <textarea name="description" rows={3} defaultValue={item?.description} maxLength={2_000} />
          </Field>
          <Field label="Prix de vente (CHF)" required>
            <input
              name="salesPrice"
              type="number"
              min="0"
              step="0.01"
              defaultValue={item ? item.salesPriceCents / 100 : ''}
              required
            />
          </Field>
          <Field label="Coût d’achat (CHF)" required hint="Utilisé pour votre référence interne.">
            <input
              name="purchaseCost"
              type="number"
              min="0"
              step="0.01"
              defaultValue={item ? item.purchaseCostCents / 100 : '0'}
              required
            />
          </Field>
          <Field label="TVA" required>
            <select name="vatBp" defaultValue={defaultVat} required>
              {vatRates.map((rate) => (
                <option key={rate} value={rate}>
                  {rate === 0
                    ? '0 % · exonéré / non assujetti'
                    : `${(rate / 100).toLocaleString('fr-CH')} %`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {kind === 'product' ? (
          <section className="catalog-stock-form">
            <div className="catalog-stock-form__notice">
              <Package size={19} />
              <div>
                <strong>Stock suivi par mouvements</strong>
                <p>
                  {item
                    ? `Solde actuel : ${formatCatalogQuantity(item.stockQuantityMilli)} ${item.unit}. Il n’est jamais modifié depuis cette fiche.`
                    : 'Le produit sera créé avec un stock de 0,000. Enregistrez ensuite une Entrée pour son stock d’ouverture.'}
                </p>
              </div>
            </div>
            <div className="form-grid">
              <Field label="Seuil d’alerte" required hint="Alerte lorsque le solde atteint ou passe sous ce seuil.">
                <input
                  name="reorderLevel"
                  type="number"
                  min="0"
                  step="0.001"
                  defaultValue={item ? item.reorderLevelMilli / 1_000 : '0'}
                  required
                />
              </Field>
            </div>
          </section>
        ) : (
          <div className="info-strip catalog-service-stock-note">
            <ShieldCheck size={17} />
            <span>Un service ne suit jamais de quantité et ne peut recevoir aucun mouvement de stock.</span>
          </div>
        )}
        {item?.archivedAt ? (
          <div className="info-strip">
            <Archive size={17} />
            <span>
              Cette référence est archivée. Elle reste modifiable pour l’historique, mais n’est plus proposée dans les nouveaux documents.
            </span>
          </div>
        ) : null}
        <FormActions
          onCancel={close}
          busy={busy}
          submitLabel={item ? 'Enregistrer les modifications' : 'Ajouter au catalogue'}
        />
      </form>
    </Modal>
  );
}
