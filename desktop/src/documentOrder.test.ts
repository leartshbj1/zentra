import { expect, it } from 'vitest';
import { newestDocumentsFirst } from './documentOrder';

it('classe les documents récents en premier, départage le même jour et conserve la source', () => {
  const documents = [
    { id: 'old', issueDate: '2026-08-01', createdAt: '2026-09-05T12:00:00Z', number: 'F-20' },
    { id: 'morning', issueDate: '2026-09-05', createdAt: '2026-09-05T08:00:00Z', number: 'F-9' },
    { id: 'new', issueDate: '2026-09-05', createdAt: '2026-09-05T09:00:00Z', number: 'F-10' },
  ];
  expect(newestDocumentsFirst(documents).map(row => row.id)).toEqual(['new', 'morning', 'old']);
  expect(documents[0].id).toBe('old');
});
