import { describe, expect, it } from 'vitest';
import { defaultRateTable, laborRatesFromRaw, matchingRate, parseRateAmount, parseRateGrid, reportAtRates, type LaborRateTable } from './laborRates';
import type { WorkReportLine } from './types';

describe('tarifs de régie', () => {
  it('lit les montants suisses', () => {
    expect(parseRateAmount('98.50')).toBe(9_850);
    expect(parseRateAmount('98,5')).toBe(9_850);
    expect(parseRateAmount("CHF 1'250.–")).toBe(125_000);
    expect(parseRateAmount('Fr. 82.-')).toBe(8_200);
    expect(parseRateAmount('beaucoup')).toBeNull();
  });

  it('importe un fichier d’association avec en-tête, codes, coûts et machines', () => {
    const grid = [
      ['Tarifs de régie 2026 — fichier fictif de test', '', '', '', ''],
      ['', '', '', '', ''],
      ['Code', 'Catégorie', 'Unité', 'Tarif horaire', 'Prix de revient'],
      ['CE', 'Chef d’équipe', 'h', '98.50', '72.00'],
      ['OQ', 'Ouvrier qualifié', 'h', '89,00', '65.00'],
      ['AP', 'Apprenti 3e année', 'h', '42.–', ''],
      ['N1', 'Nacelle ciseaux 8 m', 'jour', '240.00', ''],
      ['', 'Ligne sans tarif', 'h', '', ''],
    ];
    const parsed = parseRateGrid(grid);
    expect(parsed.headerRow).toBe(2);
    expect(parsed.rates).toHaveLength(4);
    expect(parsed.rates[0]).toEqual({ kind: 'personnel', code: 'CE', label: 'Chef d’équipe', unit: 'h', rateCents: 9_850, costCents: 7_200 });
    expect(parsed.rates[2]).toMatchObject({ label: 'Apprenti 3e année', rateCents: 4_200, costCents: null });
    expect(parsed.rates[3]).toMatchObject({ kind: 'machine', unit: 'jour', rateCents: 24_000 });
    expect(parsed.skipped).toEqual([8]);
  });

  it('se débrouille sans en-tête et lit la colonne Type en allemand', () => {
    expect(parseRateGrid([['Vorarbeiter', '96.00'], ['Hilfsarbeiter', '68.00']]).rates.map(rate => [rate.label, rate.rateCents])).toEqual([['Vorarbeiter', 9_600], ['Hilfsarbeiter', 6_800]]);
    const typed = parseRateGrid([['Bezeichnung', 'Art', 'Ansatz'], ['Kompressor', 'Gerät', '35.00'], ['Monteur', 'Personal', '92.00']]);
    expect(typed.rates.map(rate => rate.kind)).toEqual(['machine', 'personnel']);
  });

  it('reprend le tarif choisi, son code dans une nouvelle table, ou le libellé', () => {
    const tables = laborRatesFromRaw(
      [{ id: 't25', name: '2025', is_default: 0, valid_from: '2025-01-01' }, { id: 't26', name: '2026', is_default: 1, valid_from: '2026-01-01' }],
      [
        { id: 'r1', table_id: 't25', position: 0, kind: 'personnel', code: 'CE', label: 'Chef d’équipe', unit: 'h', rate_cents: 9_200 },
        { id: 'r2', table_id: 't26', position: 0, kind: 'personnel', code: 'CE', label: 'Chef d’équipe', unit: 'h', rate_cents: 9_800 },
        { id: 'r3', table_id: 't26', position: 1, kind: 'personnel', code: 'AP', label: 'Apprenti', unit: 'h', rate_cents: 3_500 },
      ],
    );
    const current = defaultRateTable(tables) as LaborRateTable;
    expect(current.name).toBe('2026');
    expect(matchingRate(current, { description: 'Chef d’équipe (Marc)', laborRateId: 'r1' }, tables)?.rateCents).toBe(9_800);
    expect(matchingRate(current, { description: ' apprenti ' }, tables)?.rateCents).toBe(3_500);
    expect(matchingRate(current, { description: 'Manœuvre' }, tables)).toBeNull();
    const line = (description: string, price: number, laborRateId: string | null = null): WorkReportLine & { laborRateId: string | null } => ({ id: description, kind: 'labor', catalogItemId: null, description, quantity: 2, unit: 'h', unitPriceCents: price, vatBp: 810, laborRateId });
    expect(reportAtRates([line('Chef d’équipe', 9_200, 'r1'), line('Manœuvre', 5_000), { ...line('Vis', 40), kind: 'material' }], current, tables)).toEqual({ netCents: 19_600 + 10_000 + 80, repriced: 1 });
  });
});
