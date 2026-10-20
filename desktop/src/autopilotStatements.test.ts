import { describe, expect, it } from 'vitest';
import { folderLabel, newStatementFiles, statementFileFromRaw } from './autopilotStatements';

const raw = (name: string, sha: string, imported: boolean, modified: string, type = 'camt.053') =>
  ({ path: `C:/Users/a/Downloads/${name}`, name, size: 2048, modified_at: modified, sha256: sha.repeat(64).slice(0, 64), message_type: type, imported });

describe('relevés déposés dans le dossier', () => {
  it('ne garde que des relevés CAMT bien formés', () => {
    expect(statementFileFromRaw(raw('a.xml', 'a', false, '2026-10-20T08:00:00Z'))?.messageType).toBe('camt.053');
    expect(statementFileFromRaw(raw('b.xml', 'b', false, '', 'camt.052'))).toBeNull();
    expect(statementFileFromRaw({ path: 'x', sha256: 'court' })).toBeNull();
  });

  it('propose les relevés jamais importés ni écartés, le plus récent d’abord', () => {
    const files = [
      raw('ancien.xml', 'a', false, '2026-10-01T08:00:00Z'),
      raw('importe.xml', 'b', true, '2026-10-19T08:00:00Z'),
      raw('recent.xml', 'c', false, '2026-10-20T08:00:00Z'),
      raw('ecarte.xml', 'd', false, '2026-10-18T08:00:00Z'),
    ].map((row) => statementFileFromRaw(row)!);
    const ignored = new Set(['d'.repeat(64)]);
    expect(newStatementFiles(files, ignored).map((file) => file.name)).toEqual(['recent.xml', 'ancien.xml']);
  });

  it('affiche le nom court du dossier', () => {
    expect(folderLabel('C:\\Users\\Leart\\Downloads\\')).toBe('Downloads');
    expect(folderLabel('/Users/leart/Téléchargements')).toBe('Téléchargements');
  });
});
