import { describe, expect, it } from 'vitest';
import { mailtoLink, missingInfoDraft, requestsMissingInfo } from './autopilotMissingInfo';
import type { AutopilotReviewItem } from './autopilotReview';

const sender = { email: 'marie@atelier-dupont.ch', name: 'Marie Dupont', company: 'Atelier Dupont Sàrl', phone: null, street: null, postcode: null, city: null, source: 'signature' } as const;
const item = (reasons: AutopilotReviewItem['reasons'], unmatched: string[] = [], withSender = true) => ({ proposalId: 'p1', sourceId: 's1', createdAt: 1, disposition: 'needs_review', reasons,
  requiresHumanValidation: true, suggestion: { customer: null, currency: 'CHF', netCents: 0, lines: [], unmatched, ...(withSender ? { sender } : {}) } }) as unknown as AutopilotReviewItem;

describe('reply asking for the missing information', () => {
  it('keeps only requests missing information, with an address to answer to', () => {
    const rows = [item(['missing_quantity'], ['parquet chêne']), item(['low_confidence']), item(['missing_article'], [], false)];
    expect(requestsMissingInfo(rows).map(row => row.reasons)).toEqual([['missing_quantity']]);
  });

  it('asks only for what is missing, in the app language', () => {
    const fr = missingInfoDraft(item(['missing_quantity'], ['parquet chêne', 'plinthes']), 'fr', 'Menuiserie Favre');
    expect(fr.to).toBe('marie@atelier-dupont.ch');
    expect(fr.body).toBe(['Bonjour Marie Dupont,', '', 'Merci pour votre demande. Pour vous envoyer un devis exact, pourriez-vous nous préciser :',
      '- la quantité souhaitée pour : parquet chêne', '- la quantité souhaitée pour : plinthes', '- l’adresse du chantier ou de livraison', '- le délai souhaité', '',
      'Avec nos meilleures salutations', 'Menuiserie Favre'].join('\n'));
    const de = missingInfoDraft(item(['missing_article']), 'de', '');
    expect(de.subject).toBe('Ihre Offertanfrage');
    expect(de.body).toContain('- die gewünschten Mengen und Artikel');
  });

  it('builds a mailto link with the subject and body encoded', () => {
    expect(mailtoLink({ to: 'a@b.ch', subject: 'Votre demande', body: 'Ligne 1\nLigne 2' })).toBe('mailto:a@b.ch?subject=Votre%20demande&body=Ligne%201%0ALigne%202');
  });
});
