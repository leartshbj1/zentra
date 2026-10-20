import { describe, expect, it } from 'vitest';
import { digestDue, digestInput, digestSignature } from './morningDigest';

describe('résumé du matin', () => {
  it('sends the count and at most eight clean titles', () => {
    const cards = Array.from({ length: 11 }, (_, index) => ({ title: `Relance n°${index + 1}\u0007 prête`, detail: '  Résidence   Bellevue ' }));
    const input = digestInput(cards, 'fr-CH', 'Europe/Zurich');
    expect(input.count).toBe(11);
    expect(input.items).toHaveLength(8);
    expect(input.items[0]).toEqual({ title: 'Relance n°1 prête', detail: 'Résidence Bellevue' });
    expect(input.locale).toBe('fr');
    expect(digestInput(cards, 'de-CH', 'Mars/Olympus Mons!').timeZone).toBe('Europe/Zurich');
    expect(digestInput(cards, 'de-CH', 'Europe/Zurich').locale).toBe('de');
  });

  it('sends nothing but the switch when turned off', () => {
    expect(digestInput([{ title: 'Carte' }], 'it', 'Europe/Zurich', false)).toEqual({ enabled: false, locale: 'it', timeZone: 'Europe/Zurich', count: 0, items: [] });
  });

  it('resends only when the cards change, or after six hours', () => {
    const signature = digestSignature(digestInput([{ title: 'Carte' }], 'fr', 'Europe/Zurich'));
    expect(digestDue({ enabled: false }, signature, 0)).toBe(false);
    expect(digestDue({ enabled: true }, signature, 0)).toBe(true);
    expect(digestDue({ enabled: true, signature, sentAt: 1_000 }, signature, 1_000 + 3_600_000)).toBe(false);
    expect(digestDue({ enabled: true, signature, sentAt: 1_000 }, signature, 1_000 + 6 * 3_600_000)).toBe(true);
    expect(digestDue({ enabled: true, signature: 'other', sentAt: 1_000 }, signature, 2_000)).toBe(true);
  });
});
