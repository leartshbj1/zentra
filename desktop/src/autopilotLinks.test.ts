// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { autopilotLineLinks, phraseQuantity, saveAutopilotLineLink } from './autopilotLinks';

describe('Autopilote line links kept on this device', () => {
  beforeEach(() => window.localStorage.clear());
  it('remembers a linked line per company and request, and forgets it on change', () => {
    const link = { articleId: 'article-pro', name: 'Zentra Gestion Pro', term: 'gestion pro zentra' };
    saveAutopilotLineLink('company-a', 'proposal-a', '2 licences Zentra Gestion Pro', link);
    expect(autopilotLineLinks('company-a', 'proposal-a')).toEqual({ '2 licences Zentra Gestion Pro': link });
    expect(autopilotLineLinks('company-b', 'proposal-a')).toEqual({});
    saveAutopilotLineLink('company-a', 'proposal-a', '2 licences Zentra Gestion Pro', null);
    expect(autopilotLineLinks('company-a', 'proposal-a')).toEqual({});
  });
  it('reads the quantity written in the line, else one', () => {
    expect(phraseQuantity('2 licences Zentra Gestion Pro')).toBe(2);
    expect(phraseQuantity('Zentra Support x3')).toBe(3);
    expect(phraseQuantity('1,5 jour de formation')).toBe(1.5);
    expect(phraseQuantity('Bonjour puis-je avoir un devis pour Zentra Pro')).toBe(1);
  });
});
