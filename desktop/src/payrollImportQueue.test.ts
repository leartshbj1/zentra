import { describe, expect, it } from 'vitest';
import { hasCompletedLocalPayrollAiAnalysis, pendingLocalPayrollAiImports } from './payrollImportQueue';
import type { PayrollDocumentImport } from './types';

function importItem(id: string, extractionEngine: string, status: PayrollDocumentImport['status'] = 'needs_review'): PayrollDocumentImport {
  return {
    id,
    status,
    extractionEngine,
    fileSha256: 'a'.repeat(64),
    mediaKind: 'image',
    pageCount: 1,
    analysisManifest: extractionEngine.startsWith('smolvlm-500m-') ? {
      schemaVersion: 1,
      modelId: 'local-model',
      modelRevision: 'revision',
      inputSha256: 'a'.repeat(64),
      analyzedPages: [1],
      passes: 2,
      fieldProvenance: [],
      lineProvenance: [],
      conflicts: [],
      analyzedAt: '2026-09-01T10:00:00Z',
    } : null,
  } as PayrollDocumentImport;
}

describe('file locale d’analyse des fiches de salaire', () => {
  it('reconnaît les analyses SmolVLM déjà persistées, quel que soit le mode local', () => {
    expect(hasCompletedLocalPayrollAiAnalysis(importItem('gpu', 'smolvlm-500m-webgpu-multipage-double-read-2'))).toBe(true);
    expect(hasCompletedLocalPayrollAiAnalysis(importItem('cpu', 'smolvlm-500m-wasm-multipage-double-read-2'))).toBe(true);
    expect(hasCompletedLocalPayrollAiAnalysis(importItem('text', 'pdf_text'))).toBe(false);
    const corrected = importItem('corrected', 'smolvlm-500m-webgpu-multipage-double-read-2');
    corrected.analysisManifest = null;
    expect(hasCompletedLocalPayrollAiAnalysis(corrected)).toBe(false);
    const wrongDocument = importItem('wrong-hash', 'smolvlm-500m-webgpu-multipage-double-read-2');
    wrongDocument.analysisManifest!.inputSha256 = 'b'.repeat(64);
    expect(hasCompletedLocalPayrollAiAnalysis(wrongDocument)).toBe(false);
    const incomplete = importItem('partial', 'smolvlm-500m-webgpu-multipage-double-read-2');
    incomplete.mediaKind = 'pdf';
    incomplete.pageCount = 2;
    expect(hasCompletedLocalPayrollAiAnalysis(incomplete)).toBe(false);
  });

  it('ne remet pas en file une fiche déjà analysée ou déjà traitée', () => {
    const pending = pendingLocalPayrollAiImports([
      importItem('first', 'pdf_text'),
      importItem('done-ai', 'smolvlm-500m-webgpu-multipage-double-read-2'),
      importItem('second', 'manual_review'),
      importItem('confirmed', 'pdf_text', 'confirmed'),
    ]);

    expect(pending.map((item) => item.id)).toEqual(['first', 'second']);
  });
});
