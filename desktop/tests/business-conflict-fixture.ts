import { desktopApi } from '../src/bridge';
import type { BusinessConflictChange, BusinessConflictReview, BusinessResolutionPreview, BusinessResolutionRequest, BusinessResolutionSaved } from '../src/businessConflictReview';

// UI-only fixture: native guards, receipt and disk integrity have separate Rust tests.
export function installBusinessConflictFixture() {
  const ready = desktopApi.getBusinessCycleState;
  const reviewId = 'a'.repeat(64), receipt = 'b'.repeat(64), incoming = 'received-conflict';
  const transactions = Array.from({ length: 6 }, (_, index) => `local-operation-${index}`);
  const calls: Array<{ action: string; id?: string; cursor?: string }> = [];
  const proposals = new Map<string, BusinessResolutionSaved>();
  let stale = false, loseSaveResponse = true;
  const canChoose = !new URLSearchParams(location.search).has('conflictReadOnly');
  const longText = `Conditions\n${'é🧾'.repeat(5_001)}\nFin des conditions`;
  const start = 9_007_199_254_740_993n;
  const seq = (index: number) => (start + BigInt(index)).toString();
  const fields = (values: Record<string, string | number | null>) => ({ fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    value: typeof value === 'string' && key === 'description' ? Array.from(value).slice(0, 2_000).join('') : value,
    truncated: typeof value === 'string' && key === 'description' && Array.from(value).length > 2_000,
    exact_integer: key === 'external_number',
  }])), truncated: Object.values(values).some(value => typeof value === 'string' && Array.from(value).length > 2_000) });
  const changes: BusinessConflictChange[] = Array.from({ length: 8 }, (_, index) => ({ sequence: seq(index), table: index === 7 ? 'audit_log' : index === 0 ? 'quotes' : 'quote_items', key_json: JSON.stringify([`row-${index}`]),
    operation: 'delete', first_conflict: index === 0, base: fields(index === 0 ? { title: 'Devis pour la cuisine', external_number: seq(0) } : { description: index === 1 ? longText : `Prestation ${index}`, unit_price_cents: 5000 }),
    local: null, shared: fields(index === 0 ? { title: 'Devis validé par l’équipe', external_number: seq(0) } : { description: index === 1 ? longText : `Prestation ${index}`, unit_price_cents: 6000 }),
  }));
  function current(expected?: string) { if (stale || expected && expected !== reviewId) throw new Error('La comparaison a changé. Actualisez-la avant de continuer.'); }
  function review(after?: string, decisions: BusinessResolutionRequest['decisions'] = []): BusinessConflictReview {
    current();
    if (after && !transactions.some((_, i) => seq(i * 10) === after)) throw new Error('Invalid operation cursor');
    const first = after ? Number((BigInt(after) - start) / 10n) + 1 : 0;
    const chosen = new Map(decisions.map(d => [d.transaction_id, d.choice]));
    return { state: 'conflict_review', review_id: reviewId, transaction_id: incoming, organization_id: 'org-cycle-ui', revision: 2,
      receipt_sha256: receipt, confirmed_transaction_id: null, decision_scope: 'whole_transaction', conflict_count: transactions.length - chosen.size,
      pending_changes: 48, can_choose: canChoose, transactions: transactions.slice(first, first + 4).map((transaction_id, i) => ({ transaction_id, first_sequence: seq((first + i) * 10), last_sequence: seq((first + i) * 10 + 8),
        change_count: 8, tables: [{ table: 'quotes', change_count: 1 }, { table: 'quote_items', change_count: 6 }, { table: 'audit_log', change_count: 1 }],
        conflict: chosen.has(transaction_id) ? null : { ...changes[0] },
      })), next_after_sequence: first + 4 < transactions.length ? seq((first + 3) * 10) : null, installed: false, acknowledged: false, replication_active: false };
  }
  function preview(request: BusinessResolutionRequest): BusinessResolutionPreview {
    current(request.review_id); if (!canChoose) throw new Error('Lecture seule');
    const base = review(request.after_sequence, request.decisions);
    return { ...base, state: base.conflict_count ? 'resolution_needs_review' : 'resolution_preview', native_guards_validated: base.conflict_count === 0,
      proposed_state_sha256: base.conflict_count ? null : 'c'.repeat(64), decision_sha256: 'e'.repeat(64), decisions: Object.fromEntries(request.decisions.map(d => [d.transaction_id, d.choice])), can_install: false,
      documents_verified: base.conflict_count === 0, documents: base.conflict_count ? null : { final_count: 3, files_to_replace: 1, total_size_bytes: 1024, plan_sha256: 'f'.repeat(64) } };
  }
  desktopApi.syncBusinessCycle = async () => {
    const result = await ready(); if (result.state !== 'ready') throw new Error('Fixture history missing');
    return { state: 'conflict', selection: result.selection, workspace_changed: false, detail: { state: 'reconciliation_conflict', transaction_id: incoming }, replication_active: false };
  };
  desktopApi.inspectBusinessConflicts = async (_, page) => { calls.push({ action: 'inspect', cursor: page?.afterSequence }); current(page?.reviewId); return review(page?.afterSequence); };
  desktopApi.inspectBusinessConflictChanges = async (_, request) => {
    current(request.review_id); const from = request.after_sequence ? changes.findIndex(row => row.sequence === request.after_sequence) + 1 : 0;
    calls.push({ action: 'rows', cursor: request.after_sequence });
    return { state: 'conflict_changes', review_id: reviewId, local_transaction_id: request.local_transaction_id, changes: changes.slice(from, from + 3), change_count: 8, next_after_sequence: from + 3 < 8 ? changes[from + 2].sequence : null, shared_image_scope: 'received_revision' };
  };
  desktopApi.readBusinessConflictText = async (_, request) => {
    current(request.review_id); const chars = Array.from(longText), end = Math.min(chars.length, request.offset + 8000);
    return { state: 'conflict_text', review_id: reviewId, local_transaction_id: request.local_transaction_id, sequence: request.sequence, text: chars.slice(request.offset, end).join(''), offset: request.offset, total_characters: chars.length, next_offset: end < chars.length ? end : null };
  };
  desktopApi.previewBusinessResolution = async (_, request) => { calls.push({ action: 'preview', cursor: request.after_sequence }); return preview(request); };
  desktopApi.listSavedBusinessResolutions = async (_, id) => { current(id); return { state: 'saved_resolutions', review_id: reviewId, proposals: [...proposals.values()].map(p => p.saved) }; };
  desktopApi.saveBusinessResolution = async (_, id, request) => {
    calls.push({ action: 'save', id }); const next = preview(request);
    if (next.state !== 'resolution_preview') return next;
    const saved: BusinessResolutionSaved = { ...next, state: 'resolution_saved', saved: { resolution_id: id, created_at: '2026-09-09T10:00:00Z', candidate_and_documents_preserved: true, server_retirement_requested: false } };
    proposals.set(id, saved);
    if (loseSaveResponse) { loseSaveResponse = false; throw new Error('Réponse interrompue après enregistrement. Vérifiez puis réessayez.'); }
    return saved;
  };
  desktopApi.readSavedBusinessResolution = async (_, id) => { current(); const saved = proposals.get(id); if (!saved) throw new Error('Proposition absente'); return saved; };
  Object.assign(window, { __businessConflictQa: { calls, longText, expire: () => { stale = true; }, recover: () => { stale = false; } } });
}
