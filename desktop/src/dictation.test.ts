import { describe, expect, it } from 'vitest';
import { dictationDraft, findDictatedClient, matchCatalog, readHours, readQuantity } from './dictation';
import type { CatalogItem, Client } from './types';

const item = (id: string, name: string, unit: string, price: number): CatalogItem =>
  ({ id, kind: unit === 'h' ? 'service' : 'product', name, unit, salesPriceCents: price, vatBp: 810, archivedAt: null } as unknown as CatalogItem);
const catalogue = [item('mo', 'Main-d’œuvre installateur', 'h', 9_500), item('coude', 'Coude cuivre 22 mm', 'pce', 450), item('vanne', 'Vanne thermostatique', 'pce', 3_800),
  item('tube', 'Tube cuivre 22 mm', 'm', 1_200), item('depl', 'Déplacement', 'forfait', 6_000)];
const clients = [{ id: 'c-keller', name: 'Famille Keller', company: '', archivedAt: null }, { id: 'c-rochat', name: 'Claire Rochat', company: '', archivedAt: null }] as unknown as Client[];
let next = 0;
const newId = () => `l${++next}`;

describe('dictation', () => {
  it('reads hours said in words or digits', () => {
    expect(readHours('deux heures de travail')).toBe(2);
    expect(readHours('une heure et demie')).toBe(1.5);
    expect(readHours('2h30 sur place')).toBe(2.5);
    expect(readHours('1,5 h')).toBe(1.5);
    expect(readHours('une demi-heure de réglage')).toBe(0.5);
    expect(readHours('zwei Stunden Arbeit')).toBe(2);
    expect(readHours('trois coudes')).toBeNull();
  });

  it('reads a leading quantity and matches the catalogue by its words', () => {
    expect(readQuantity('trois coudes de 22')).toEqual({ quantity: 3, words: 'coudes de 22' });
    expect(readQuantity('remplacement de la vanne')).toBeNull();
    expect(matchCatalog('coudes de 22', catalogue)?.id).toBe('coude');
    expect(matchCatalog('vanne thermostatique', catalogue)?.id).toBe('vanne');
    // « cuivre 22 » couvre autant le coude que le tube : pas de devinette.
    expect(matchCatalog('cuivre 22', catalogue)).toBeNull();
  });

  it('finds the client by a name said in the sentence', () => {
    expect(findDictatedClient('Chez Keller, vanne changée', clients).client?.id).toBe('c-keller');
    expect(findDictatedClient('Pour Monsieur Dubois, fuite réparée', clients)).toEqual({ client: null, name: 'Dubois' });
  });

  it('prepares lines with catalogue prices and keeps the rest as the description', () => {
    next = 0;
    const draft = dictationDraft('Chez Keller. Remplacement de la vanne thermostatique de la salle de bain, une heure et demie de travail, une vanne thermostatique et trois coudes de 22. Plus deux bidules.',
      clients, catalogue, true, newId);
    expect(draft.clientId).toBe('c-keller');
    expect(draft.description).toBe('Remplacement de la vanne thermostatique de la salle de bain.');
    expect(draft.lines.map(line => [line.catalogItemId, line.quantity, line.unitPriceCents])).toEqual([['mo', 1.5, 9_500], ['vanne', 1, 3_800], ['coude', 3, 450], [null, 2, 0]]);
    expect(draft.missing).toEqual(['deux bidules']);
    expect(draft.lines[3]).toMatchObject({ description: 'Bidules', vatRateBp: -1 });
  });
});

describe('dictation labels', () => {
  it('keeps the words as said for a line to complete', () => {
    const draft = dictationDraft('Une heure et demie de réglage', [], [], false, () => 'x');
    expect(draft.lines[0]).toMatchObject({ description: 'Une heure et demie de réglage', quantity: 1.5, unitPriceCents: 0 });
    expect(draft.missing).toEqual(['Une heure et demie de réglage']);
  });
});
