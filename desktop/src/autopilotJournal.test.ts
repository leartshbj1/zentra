// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { appendJournal, canUndo, confirmEntries, decideRule, doneAt, doneToday, entriesToConfirm, journalEntries, learnedRules, markUndone, ruleProposals, signatureLabel } from './autopilotJournal';

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

describe('fait aujourd’hui', () => {
  const now = new Date(2026, 9, 20, 15, 0);
  const at = (hours: number, day = 20) => new Date(2026, 9, day, hours, 0);

  it('ne compte que le travail réellement fait aujourd’hui, le plus récent d’abord', () => {
    appendJournal('org', { key: 'quote:1', actionLabel: 'Devis créé', title: 'Dupont', detail: '', ok: true }, at(9));
    appendJournal('org', { key: 'signal:2', actionLabel: 'Enregistrer le paiement', title: '', detail: '', ok: null }, at(10));
    appendJournal('org', { key: 'bank:3', actionLabel: 'Confirmer', title: '', detail: '', ok: false }, at(11));
    appendJournal('org', { key: 'quote:4', actionLabel: 'Devis créé', title: 'Hier', detail: '', ok: true }, at(9, 19));
    const undone = appendJournal('org', { key: 'qr:5', actionLabel: 'Créer', title: '', detail: '', ok: true, undo: { kind: 'supplier-draft', invoiceId: 'i' } }, at(12));
    markUndone('org', undone.id, at(13));
    appendJournal('org', { key: 'reminder:6', actionLabel: 'Reporter', title: '', detail: '', ok: true, undo: { kind: 'follow-up', key: 'reminder:6', previous: null } }, at(13));
    appendJournal('org', { key: 'quote-sent:1', actionLabel: 'Devis envoyé', title: 'Dupont', detail: '', ok: true }, at(14));
    expect(doneToday(journalEntries('org'), now).map((entry) => entry.key)).toEqual(['quote-sent:1', 'quote:1']);
  });

  it('confirme un formulaire ouvert quand son résultat existe, une seule fois', () => {
    const opened = appendJournal('org', { key: 'signal:mail-1', actionLabel: 'Enregistrer le paiement', title: '', detail: '', ok: null }, at(10));
    appendJournal('org', { key: 'signal:mail-2', actionLabel: 'Enregistrer le paiement', title: '', detail: '', ok: null }, at(10));
    const paid = (entry: { key: string }) => entry.key === 'signal:mail-1';
    const ids = entriesToConfirm(journalEntries('org'), paid, now);
    expect(ids).toEqual([opened.id]);
    confirmEntries('org', ids, at(14));
    const confirmed = journalEntries('org').find((entry) => entry.id === opened.id)!;
    expect(confirmed).toMatchObject({ ok: true, confirmedAt: at(14).toISOString() });
    expect(doneAt(confirmed)).toBe(at(14).toISOString());
    expect(entriesToConfirm(journalEntries('org'), paid, now)).toEqual([]);
    expect(doneToday(journalEntries('org'), now).map((entry) => entry.key)).toEqual(['signal:mail-1']);
  });

  it('ne confirme ni un échec, ni une action annulée, ni un formulaire de plus de 7 jours', () => {
    appendJournal('org', { key: 'a', actionLabel: '', title: '', detail: '', ok: false }, at(10));
    appendJournal('org', { key: 'b', actionLabel: '', title: '', detail: '', ok: null }, at(10, 10));
    const undone = appendJournal('org', { key: 'c', actionLabel: '', title: '', detail: '', ok: null }, at(10));
    markUndone('org', undone.id);
    expect(entriesToConfirm(journalEntries('org'), () => true, now)).toEqual([]);
  });
});
