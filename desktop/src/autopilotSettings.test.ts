// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BEHAVIOUR, readBehaviour, saveBehaviour, visibleCards } from './autopilotSettings';

beforeEach(() => localStorage.clear());

describe('Autopilote behaviour', () => {
  it('is off by default and kept per company', () => {
    expect(readBehaviour('org-a')).toEqual(DEFAULT_BEHAVIOUR);
    saveBehaviour('org-a', { paused: true, autoValidate: ['qrmail'] });
    expect(readBehaviour('org-a')).toMatchObject({ paused: true, autoValidate: ['qrmail'], onlySure: [] });
    expect(readBehaviour('org-b')).toEqual(DEFAULT_BEHAVIOUR);
  });

  it('never accepts an automatic case outside the exact, undoable list', () => {
    saveBehaviour('org', { autoValidate: ['qrmail', 'bank' as never, 'contact-complete'] });
    expect(readBehaviour('org').autoValidate).toEqual(['qrmail', 'contact-complete']);
  });

  it('hides every card while paused, and cards to check in "only sure" domains', () => {
    const cards = [{ key: 'bank:1', c: 'check' }, { key: 'bank:2', c: 'high' }, { key: 'reminder:3', c: 'check' }, { key: 'x:4', c: 'check' }] as const;
    const kind = (key: string) => key.startsWith('bank') ? 'Banque' : key.startsWith('reminder') ? 'Ventes' : null;
    const confidence = (card: (typeof cards)[number]) => card.c;
    expect(visibleCards(cards, { ...DEFAULT_BEHAVIOUR, paused: true }, kind, confidence)).toEqual([]);
    expect(visibleCards(cards, { ...DEFAULT_BEHAVIOUR, onlySure: ['Banque'] }, kind, confidence).map(card => card.key)).toEqual(['bank:2', 'reminder:3', 'x:4']);
    expect(visibleCards(cards, DEFAULT_BEHAVIOUR, kind, confidence)).toHaveLength(4);
  });
});
