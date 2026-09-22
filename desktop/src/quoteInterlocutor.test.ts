import { expect, it } from 'vitest';
import { quoteInterlocutor } from './quoteInterlocutor';
import type { Quote } from './types';
it('uses the author, not the owner or the person who opens the document', () => {
  expect(quoteInterlocutor({ creator: { id:'alice', name:'Alice Martin' } } as Quote,'Bob Dupont')).toBe('Alice Martin');
  expect(quoteInterlocutor({ creator: { id:'alice', name:'alice@example.test' } } as Quote,'Bob Dupont')).toBe('');
});
it('keeps the frozen interlocutor, including the absence of one on an older issued quote', () => {
  const quote = { creator:{id:'bob',name:'Bob Dupont'}, snapshot:{ document:{contactName:'Alice Martin'} } } as Quote;
  expect(quoteInterlocutor(quote,'Charles Dubois')).toBe('Alice Martin');
  expect(quoteInterlocutor({...quote, snapshot:{document:{}}} as Quote,'Charles Dubois')).toBe('');
});
it('uses the declared company contact only for standalone drafts', () => {
  expect(quoteInterlocutor({} as Quote,'Camille Martin')).toBe('Camille Martin');
});
