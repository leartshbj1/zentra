import { describe, expect, it } from 'vitest';
import { archiveEntityMutation } from './bridge';

describe('archivage des référentiels locaux', () => {
  it('archive les produits et fournisseurs sans les supprimer', () => {
    const archivedAt = '2026-09-01T10:15:30.000Z';
    expect(archiveEntityMutation('catalogItems', 'catalog-1', archivedAt)).toEqual({
      command: 'update_record',
      args: { entity: 'catalog_items', id: 'catalog-1', data: { archived_at: archivedAt } },
    });
    expect(archiveEntityMutation('suppliers', 'supplier-1', archivedAt)).toEqual({
      command: 'update_record',
      args: { entity: 'suppliers', id: 'supplier-1', data: { archived_at: archivedAt } },
    });
  });

  it('conserve la suppression historique pour les autres entités', () => {
    expect(archiveEntityMutation('expenses', 'expense-1', 'ignored')).toEqual({
      command: 'delete_record',
      args: { entity: 'expenses', id: 'expense-1' },
    });
  });
});
