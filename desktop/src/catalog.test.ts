import { describe, expect, it } from 'vitest';
import {
  activeCatalogItems,
  catalogItemToDocumentLine,
  catalogQuantityFromInput,
  filterCatalogItems,
  isCatalogItemLowOnStock,
} from './catalog';
import type { CatalogItem, DocumentLine } from './types';
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

  it('convertit les quantités en milli-unités et signale seulement le stock indicatif sous le seuil', () => {
    expect(catalogQuantityFromInput('12,345')).toBe(12_345);
    expect(catalogQuantityFromInput('')).toBe(0);
    expect(catalogQuantityFromInput('-2')).toBe(0);
    expect(isCatalogItemLowOnStock(product)).toBe(true);
    expect(isCatalogItemLowOnStock({ ...product, stockQuantityMilli: 10_001 })).toBe(false);
    expect(isCatalogItemLowOnStock({ ...product, kind: 'service' })).toBe(false);
  });
});

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
