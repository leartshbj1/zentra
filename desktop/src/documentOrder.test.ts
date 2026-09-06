import { afterEach, describe, expect, it, vi } from 'vitest';
import { newestDocumentsFirst, readDocumentOrder, saveDocumentOrder, sortDocuments, type DocumentOrder } from './documentOrder';

const documents = [
  { id: 'backdated', issueDate: '2026-01-01', createdAt: '2026-09-06T12:00:00Z', number: 'F-20' },
  { id: 'future', issueDate: '2026-12-01', createdAt: '2026-09-04T08:00:00Z', number: 'F-9' },
  { id: 'today', issueDate: '2026-09-06', createdAt: '2026-09-05T09:00:00Z', number: 'F-10' },
];

describe('classement des devis et factures', () => {
  it('affiche par défaut la dernière création même si sa date de document est antérieure', () => {
    const original = structuredClone(documents);
    expect(newestDocumentsFirst(documents).map(row => row.id)).toEqual(['backdated', 'today', 'future']);
    expect(documents).toEqual(original);
  });
  it.each<[DocumentOrder, string[]]>([
    ['created-asc', ['future', 'today', 'backdated']],
    ['date-desc', ['future', 'today', 'backdated']],
    ['date-asc', ['backdated', 'today', 'future']],
  ])('respecte le choix %s', (order, expected) => {
    expect(sortDocuments(documents, order).map(row => row.id)).toEqual(expected);
  });
  it('compare les instants réels avec fuseaux horaires et les anciennes dates SQLite UTC', () => {
    const rows = [
      { ...documents[0], id: 'offset', createdAt: '2026-09-06T13:00:00+02:00' },
      { ...documents[0], id: 'sqlite', createdAt: '2026-09-06 11:30:00' },
      { ...documents[0], id: 'utc', createdAt: '2026-09-06T12:00:00Z' },
    ];
    expect(newestDocumentsFirst(rows).map(row => row.id)).toEqual(['utc', 'sqlite', 'offset']);
  });
  it('départage une même date par la création, puis le numéro naturel et un identifiant stable', () => {
    const rows = [
      { ...documents[0], id: 'b', number: 'F-9' },
      { ...documents[0], id: 'c', number: 'F-10' },
      { ...documents[0], id: 'a', number: 'F-9' },
      { ...documents[0], id: 'new', number: 'F-1', createdAt: '2026-09-07T00:00:00Z' },
    ];
    expect(sortDocuments(rows, 'date-desc').map(row => row.id)).toEqual(['new', 'c', 'a', 'b']);
    expect(sortDocuments([...rows].reverse(), 'date-desc').map(row => row.id)).toEqual(['new', 'c', 'a', 'b']);
  });
  it('utilise la date disponible pour les anciens documents et garde les documents sans date à la fin', () => {
    const rows = [
      { ...documents[0], id: 'missing', createdAt: '', issueDate: 'invalide' },
      { ...documents[0], id: 'issued', createdAt: '', issueDate: '2026-09-01' },
      { ...documents[0], id: 'created', createdAt: '2026-09-02T00:00:00Z', issueDate: '' },
    ];
    expect(sortDocuments(rows).map(row => row.id)).toEqual(['created', 'issued', 'missing']);
    expect(sortDocuments(rows, 'date-asc').map(row => row.id)).toEqual(['issued', 'created', 'missing']);
  });
});

describe('préférences de classement', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('mémorise un choix indépendant pour chaque liste', () => {
    const storage = new Map();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
    saveDocumentOrder('quotes', 'date-asc');
    expect(readDocumentOrder('quotes')).toBe('date-asc');
    expect(readDocumentOrder('invoices')).toBe('created-desc');
    storage.set('zentra.documents.order.quotes', 'invalid');
    expect(readDocumentOrder('quotes')).toBe('created-desc');
  });
  it('reste utilisable si le stockage est indisponible', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readDocumentOrder('quotes')).toBe('created-desc');
    expect(() => saveDocumentOrder('invoices', 'date-desc')).not.toThrow();
  });
});
