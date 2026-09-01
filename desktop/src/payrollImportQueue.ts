import type { PayrollDocumentImport } from './types';

export function hasCompletedLocalPayrollAiAnalysis(item: PayrollDocumentImport) {
  const manifest = item.analysisManifest;
  const expectedPageCount = item.mediaKind === 'image' ? 1 : item.pageCount;
  const hasCompletePageCoverage = expectedPageCount >= 1
    && manifest?.analyzedPages.length === expectedPageCount
    && manifest.analyzedPages.every((page, index) => page === index + 1);
  return item.extractionEngine.startsWith('smolvlm-500m-')
    && manifest?.schemaVersion === 1
    && manifest.passes >= 1
    && hasCompletePageCoverage
    && manifest.inputSha256.toLowerCase() === item.fileSha256.toLowerCase();
}

/**
 * A queued analysis is deliberately sequential in the UI. SmolVLM keeps a
 * sizeable model and page tensors in memory, so starting one worker per file
 * would make the workflow less reliable on ordinary customer PCs.
 */
export function pendingLocalPayrollAiImports(imports: PayrollDocumentImport[]) {
  return imports.filter((item) => (
    item.status === 'needs_review'
    && !hasCompletedLocalPayrollAiAnalysis(item)
  ));
}
