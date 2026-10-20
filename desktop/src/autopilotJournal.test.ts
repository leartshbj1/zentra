// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { appendJournal, canUndo, decideRule, journalEntries, learnedRules, markUndone, ruleProposals, signatureLabel } from './autopilotJournal';

beforeEach(() => localStorage.clear());

describe('journal Autopilote', () => {
  it('garde chaque clic, le plus récent d’abord, par entreprise', () => {
    appendJournal('org-a', { key: 'pay-order:1', actionLabel: 'Générer', title: '3 factures', detail: '', ok: true }, new Date('2026-10-20T08:00:00Z'));
    appendJournal('org-a', { key: 'bank:2', actionLabel: 'Confirmer', title: 'CHF 89.90', detail: '', ok: false }, new Date('2026-10-20T09:00:00Z'));
    appendJournal('org-b', { key: 'x', actionLabel: 'Ouvrir', title: 'Autre', detail: '', ok: null });
    expect(journalEntries('org-a').map((entry) => entry.key)).toEqual(['bank:2', 'pay-order:1']);
    expect(journalEntries('org-b')).toHaveLength(1);
  });

  it('propose l’annulation une seule fois, et seulement si l’inverse existe', () => {
    const undoable = appendJournal('org', { key: 'qrmail:1', actionLabel: 'Créer', title: 'Facture QR', detail: '', ok: true, undo: { kind: 'supplier-draft', invoiceId: 'i1' } });
    const plain = appendJournal('org', { key: 'bank:1', actionLabel: 'Confirmer', title: 'CHF 1', detail: '', ok: true });
    expect(canUndo(undoable)).toBe(true);
    expect(canUndo(plain)).toBe(false);
    markUndone('org', undoable.id);
    expect(canUndo(journalEntries('org').find((entry) => entry.id === undoable.id)!)).toBe(false);
  });

  it('propose une règle après trois validations identiques réussies', () => {
    const add = (signature: string, ok: boolean | null = true) => appendJournal('org', { key: 'k', actionLabel: '', title: '', detail: '', ok, signature });
    add('supplier:Swisscom'); add('supplier:Swisscom'); add('supplier:Swisscom', false);
    expect(ruleProposals(journalEntries('org'), new Set())).toEqual([]);
    add('supplier:Swisscom');
    expect(ruleProposals(journalEntries('org'), new Set())).toEqual(['supplier:Swisscom']);
    decideRule('org', 'supplier:Swisscom', 'always');
    expect(learnedRules('org')).toEqual({ 'supplier:Swisscom': 'always' });
    expect(ruleProposals(journalEntries('org'), new Set(Object.keys(learnedRules('org'))))).toEqual([]);
    expect(signatureLabel('supplier:Swisscom (Schweiz) AG')).toBe('Swisscom (Schweiz) AG');
  });
});
