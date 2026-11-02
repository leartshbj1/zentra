import { describe, expect, it } from 'vitest';
import { attachmentFromRaw } from './bridge';
import { formatAttachmentSize } from './PurchasesScreen';

describe('justificatifs des factures fournisseurs', () => {
  it('mappe uniquement les métadonnées sûres exposées par le workspace', () => {
    expect(attachmentFromRaw({
      id: 'attachment-1',
      project_id: 'project-1',
      entity_type: 'supplier_invoice',
      entity_id: 'invoice-1',
      original_name: 'facture.pdf',
      stored_name: 'secret-local-name.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1_536,
      sha256: 'abc123',
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    })).toEqual({
      id: 'attachment-1',
      projectId: 'project-1',
      entityType: 'supplier_invoice',
      entityId: 'invoice-1',
      originalName: 'facture.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1_536,
      sha256: 'abc123',
      createdAt: '2026-09-01T10:00:00Z',
      updatedAt: '2026-09-01T10:00:00Z',
    });
  });


  it('présente les tailles sans faire croire à un stockage distant', () => {
    expect(formatAttachmentSize(512)).toBe('512 o');
    expect(formatAttachmentSize(1_536)).toContain('Ko');
    expect(formatAttachmentSize(2 * 1_024 * 1_024)).toContain('Mo');
  });
});
