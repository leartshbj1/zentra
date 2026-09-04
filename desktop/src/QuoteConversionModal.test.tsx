import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Quote } from './types';
import { QuoteConversionModal } from './QuoteConversionModal';

const quote: Quote = {
  id: 'quote-accepted',
  number: 'D-2026-0042',
  clientId: 'client-1',
  projectId: null,
  title: 'Mandat accepté',
  issueDate: '2026-09-01',
  validUntil: '2026-10-01',
  currency: 'CHF',
  status: 'accepted',
  lines: [
    {
      id: 'line-1',
      catalogItemId: null,
      description: 'Prestation',
      quantity: 1,
      unit: 'forfait',
      unitPriceCents: 10_000,
      discountBp: 0,
      vatRateBp: 810,
    },
  ],
  notes: '',
  terms: '',
  createdAt: '2026-09-01T10:00:00Z',
};

describe('fenêtre de conversion devis vers facture', () => {
  it('propose une facture complète par défaut et une option d’acompte explicite', () => {
    const html = renderToStaticMarkup(
      <QuoteConversionModal
        quote={quote}
        busy={false}
        close={() => undefined}
        onConvert={async () => true}
      />,
    );

    expect(html).toContain('Créer une facture d’acompte');
    expect(html).toContain('Facture complète');
    expect(html).toContain('Créer la facture complète');
    expect(html).toContain('108.10 CHF');
    expect(html).not.toContain('aria-label="Pourcentage de l’acompte"');
  });
});
