import { describe, expect, it } from 'vitest';
import {
  activeCatalogItems,
  catalogItemToDocumentLine,
  catalogQuantityFromInput,
  catalogStockData,
  filterCatalogItems,
  isCatalogItemLowOnStock,
  stockBalanceAfter,
  stockMovementError,
  stockMovementsForItem,
  stockQuantityFromInput,
} from './catalog';
import type { CatalogItem, DocumentLine, StockMovement } from './types';
import { documentLineTotals, documentTotals, roundBasisPoints } from './utils';

const service: CatalogItem = {
  id: 'service-audit',
  kind: 'service',
  sku: 'SRV-001',
  name: 'Audit électrique',
  description: 'Contrôle initial et rapport',
  unit: 'heure',
  salesPriceCents: 15_000,
  purchaseCostCents: 7_000,
  vatBp: 810,
  trackStock: false,
  stockQuantityMilli: 0,
  reorderLevelMilli: 0,
  archivedAt: null,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
};

const product: CatalogItem = {
  ...service,
  id: 'product-cable',
  kind: 'product',
  sku: 'MAT-CABLE',
  name: 'Câble cuivre',
  description: 'Section 2,5 mm²',
  unit: 'mètre',
  salesPriceCents: 450,
  purchaseCostCents: 210,
  trackStock: true,
  stockQuantityMilli: 8_000,
  reorderLevelMilli: 10_000,
};

const archived: CatalogItem = {
  ...service,
  id: 'service-old',
  sku: null,
  name: 'Ancienne intervention',
  archivedAt: '2026-09-01T09:00:00Z',
};

describe('catalogue produits et services', () => {
  it('exclut les références archivées des sélecteurs et trie les références actives', () => {
    expect(activeCatalogItems([product, archived, service]).map((item) => item.id))
      .toEqual(['service-audit', 'product-cable']);
  });

  it('combine recherche, type et visibilité sans rendre les archives actives', () => {
    const items = [service, product, archived];
    expect(filterCatalogItems(items, 'mat-cable', 'product', 'active').map((item) => item.id))
      .toEqual(['product-cable']);
    expect(filterCatalogItems(items, 'ancienne', 'service', 'active')).toEqual([]);
    expect(filterCatalogItems(items, 'ancienne', 'service', 'archived').map((item) => item.id))
      .toEqual(['service-old']);
  });

  it('copie une référence en snapshot de ligne indépendant', () => {
    const mutable = { ...service };
    const line = catalogItemToDocumentLine(mutable, 'line-1');
    mutable.name = 'Nom modifié après copie';
    mutable.salesPriceCents = 99_999;

    expect(line).toEqual({
      id: 'line-1',
      catalogItemId: 'service-audit',
      description: 'Audit électrique — Contrôle initial et rapport',
      quantity: 1,
      unit: 'heure',
      unitPriceCents: 15_000,
      discountBp: 0,
      vatRateBp: 810,
    });
  });

  it('convertit les quantités en milli-unités et signale le stock réel sous le seuil', () => {
    expect(catalogQuantityFromInput('12,345')).toBe(12_345);
    expect(catalogQuantityFromInput('')).toBe(0);
    expect(catalogQuantityFromInput('-2')).toBe(0);
    expect(isCatalogItemLowOnStock(product)).toBe(true);
    expect(isCatalogItemLowOnStock({ ...product, stockQuantityMilli: 10_001 })).toBe(false);
    expect(isCatalogItemLowOnStock({ ...product, stockQuantityMilli: 0, reorderLevelMilli: 0 })).toBe(true);
    expect(isCatalogItemLowOnStock({ ...product, kind: 'service' })).toBe(false);
  });

  it('crée un produit suivi à zéro et ne renvoie jamais le solde pendant une édition', () => {
    expect(catalogStockData('product', 2_500, false)).toEqual({
      trackStock: true,
      reorderLevelMilli: 2_500,
      stockQuantityMilli: 0,
    });
    const edited = catalogStockData('product', 3_000, true);
    expect(edited).toEqual({ trackStock: true, reorderLevelMilli: 3_000 });
    expect(Object.hasOwn(edited, 'stockQuantityMilli')).toBe(false);
    expect(catalogStockData('service', 9_000, false)).toEqual({
      trackStock: false,
      reorderLevelMilli: 0,
      stockQuantityMilli: 0,
    });
  });

  it('valide les mouvements signés à trois décimales avant de laisser le backend trancher', () => {
    expect(stockQuantityFromInput('1.234')).toBe(1_234);
    expect(stockQuantityFromInput('-2,125')).toBe(-2_125);
    expect(stockQuantityFromInput('1.2345')).toBeNull();
    expect(stockBalanceAfter(product.stockQuantityMilli, 'entry', 1_500)).toBe(9_500);
    expect(stockBalanceAfter(product.stockQuantityMilli, 'exit', 1_500)).toBe(6_500);
    expect(stockBalanceAfter(product.stockQuantityMilli, 'correction', -8_000)).toBe(0);
    expect(stockMovementError(product, 'exit', 8_001)).toContain('Stock insuffisant');
    expect(stockMovementError(product, 'correction', 0)).toContain('ne peut pas être égale à zéro');
    expect(stockMovementError(product, 'correction', -8_000)).toBe('');
    expect(stockMovementError(service, 'entry', 1_000)).toContain('Seuls les produits');
  });

  it('isole et trie l’historique immuable de chaque article sans muter le workspace', () => {
    const movements: StockMovement[] = [
      stockMovement('movement-1', 'product-cable', 1, 5_000, 5_000),
      stockMovement('movement-other', 'other-product', 3, 1_000, 1_000),
      stockMovement('movement-2', 'product-cable', 2, -1_000, 4_000),
    ];
    expect(stockMovementsForItem(movements, 'product-cable').map((item) => item.id))
      .toEqual(['movement-2', 'movement-1']);
    expect(movements.map((item) => item.id))
      .toEqual(['movement-1', 'movement-other', 'movement-2']);
  });
});

function stockMovement(
  id: string,
  catalogItemId: string,
  sequence: number,
  quantityDeltaMilli: number,
  balanceAfterMilli: number,
): StockMovement {
  return {
    sequence,
    id,
    sourceKey: `manual:${id}`,
    requestId: `request-${id}`,
    catalogItemId,
    movementType: quantityDeltaMilli < 0 ? 'exit' : 'entry',
    quantityDeltaMilli,
    balanceAfterMilli,
    reason: 'Test',
    reference: null,
    movementDate: '2026-09-01',
    sourceType: 'manual',
    invoiceId: null,
    invoiceItemId: null,
    createdAt: '2026-09-01T08:00:00Z',
  };
}

describe('remises et arrondis des documents', () => {
  const discountedLine: DocumentLine = {
    id: 'line-discounted',
    description: 'Trois unités',
    quantity: 3,
    unit: 'pièce',
    unitPriceCents: 1_999,
    discountBp: 1_250,
    vatRateBp: 810,
  };

  it('arrondit les points de base à l’unité monétaire comme le backend', () => {
    expect(roundBasisPoints(5_997, 1_250)).toBe(750);
    expect(roundBasisPoints(5_247, 810)).toBe(425);
    expect(roundBasisPoints(-100, 50)).toBe(-1);
  });

  it('calcule la TVA après remise, ligne par ligne', () => {
    expect(documentLineTotals(discountedLine)).toEqual({
      subtotalCents: 5_997,
      discountCents: 750,
      netCents: 5_247,
      vatCents: 425,
      totalCents: 5_672,
    });
  });

  it('arrondit aussi les lignes négatives des avoirs comme Rust', () => {
    expect(documentLineTotals({
      id: 'credit-line',
      description: 'Correction',
      quantity: 0.5,
      unit: 'forfait',
      unitPriceCents: -999,
      discountBp: 333,
      vatRateBp: 260,
    })).toEqual({
      subtotalCents: -500,
      discountCents: -17,
      netCents: -483,
      vatCents: -13,
      totalCents: -496,
    });
  });

  it('additionne les arrondis de chaque ligne sans les recalculer globalement', () => {
    const fractionalLine: DocumentLine = {
      id: 'line-fractional',
      description: 'Demi-unité',
      quantity: 0.5,
      unit: 'forfait',
      unitPriceCents: 999,
      discountBp: 333,
      vatRateBp: 260,
    };
    expect(documentTotals([discountedLine, fractionalLine])).toEqual({
      subtotalCents: 6_497,
      discountCents: 767,
      netCents: 5_730,
      vatCents: 438,
      totalCents: 6_168,
    });
  });
});
