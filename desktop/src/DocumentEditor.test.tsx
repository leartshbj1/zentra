import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocumentEditor } from './DocumentEditor';
import { initialOnboardingSettings } from './onboardingDraft';
import type { Invoice, Quote, Workspace } from './types';

const client = {
  id: 'client-1',
  name: 'Aline Exemple',
  company: 'Atelier Exemple SA',
  email: 'aline@example.ch',
  phone: '',
  address: 'Rue du Lac 2\n1000 Lausanne',
  uidNumber: '',
  notes: '',
};

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    settings: {
      ...initialOnboardingSettings,
      billing: {
        ...initialOnboardingSettings.billing,
        footerTemplates: [
          { id: 'footer-1', name: 'Conditions standard', text: 'Paiement à 30 jours.' },
        ],
      },
    },
    clients: [client],
    catalogItems: [],
    projects: [],
    quotes: [],
    invoices: [],
    payments: [],
    ...overrides,
  } as Workspace;
}

const quote: Quote = {
  id: 'quote-1',
  number: '',
  clientId: client.id,
  projectId: null,
  title: 'Offre plomberie',
  issueDate: '2026-09-03',
  validUntil: '2026-10-03',
  currency: 'CHF',
  status: 'draft',
  lines: [
    {
      id: 'quote-line-1',
      catalogItemId: null,
      description: 'Intervention',
      quantity: 1,
      unit: 'forfait',
      unitPriceCents: 10_000,
      discountBp: 0,
      vatRateBp: 0,
    },
  ],
  notes: '',
  terms: 'Merci pour votre confiance.',
  createdAt: '2026-09-03T10:00:00Z',
};

describe('éditeur devis et factures', () => {
  it('réouvre le texte personnalisé et propose ses modèles et le contact rapide', () => {
    const html = renderToStaticMarkup(
      <DocumentEditor
        entity="quotes"
        item={quote}
        workspace={workspace({ quotes: [quote] })}
        busy={false}
        close={() => undefined}
        act={async () => true}
      />,
    );

    expect(html).toContain('Merci pour votre confiance.');
    expect(html).toContain('Conditions standard');
    expect(html).toContain('Nouveau contact');
    expect(html).toContain('Enregistrer le modèle');
    expect(html).toContain('min="2026-09-03" required="" value="2026-10-03"');
  });

  it('permet de créer le premier client depuis un nouveau document', () => {
    const html = renderToStaticMarkup(
      <DocumentEditor
        entity="quotes"
        workspace={workspace({ clients: [] })}
        busy={false}
        close={() => undefined}
        act={async () => true}
      />,
    );

    expect(html).toContain('Choisir un client');
    expect(html).toContain('Nouveau contact');
  });

  it('propose une recherche catalogue sans présélectionner une référence', () => {
    const html = renderToStaticMarkup(
      <DocumentEditor
        entity="quotes"
        workspace={workspace({
          catalogItems: [
            {
              id: 'catalog-1',
              sku: 'FOUR-17',
              name: 'Robinet chromé',
              description: 'Modèle mural',
              kind: 'product',
              unit: 'pièce',
              purchaseCostCents: 8_240,
              salesPriceCents: 12_990,
              vatBp: 0,
              trackStock: true,
              stockQuantityMilli: 0,
              reorderLevelMilli: 0,
              archivedAt: null,
              createdAt: '',
              updatedAt: '',
            },
          ],
        })}
        busy={false}
        close={() => undefined}
        act={async () => true}
      />,
    );

    expect(html).toContain('aria-label="Rechercher une référence du catalogue"');
    expect(html).toContain('FOUR-17 · Robinet chromé');
    const selector = html.slice(
      html.indexOf('aria-label="Référence du catalogue à ajouter"'),
      html.indexOf('aria-label="Référence du catalogue à ajouter"') + 220,
    );
    expect(selector).toContain('<option value="" selected="">Choisir une référence</option>');
  });

  it('conserve un taux 0 % explicitement sélectionné pour une entreprise assujettie', () => {
    const zeroVatQuote: Quote = {
      ...quote,
      lines: [{ ...quote.lines[0], vatRateBp: 0 }],
    };
    const registeredWorkspace = workspace({
      settings: {
        ...initialOnboardingSettings,
        organization: {
          ...initialOnboardingSettings.organization,
          vatRegistered: true,
        },
        billing: {
          ...initialOnboardingSettings.billing,
          vatRatesBp: [810],
          footerTemplates: [],
        },
      },
      quotes: [zeroVatQuote],
    });
    const html = renderToStaticMarkup(
      <DocumentEditor
        entity="quotes"
        item={zeroVatQuote}
        workspace={registeredWorkspace}
        busy={false}
        close={() => undefined}
        act={async () => true}
      />,
    );

    const selector = html.slice(
      html.indexOf('aria-label="Taux TVA"') - 120,
      html.indexOf('aria-label="Taux TVA"') + 300,
    );
    expect(selector).toContain('<option value="0" selected="">0 % · Hors TVA / taux 0</option>');
    expect(selector).toContain('<option value="810">8,1 %</option>');

    const newDocumentHtml = renderToStaticMarkup(
      <DocumentEditor
        entity="quotes"
        workspace={registeredWorkspace}
        busy={false}
        close={() => undefined}
        act={async () => true}
      />,
    );
    const newDocumentSelector = newDocumentHtml.slice(
      newDocumentHtml.indexOf('aria-label="Taux TVA"') - 120,
      newDocumentHtml.indexOf('aria-label="Taux TVA"') + 300,
    );
    expect(newDocumentSelector).toContain('<option value="" selected="">Choisir</option>');
    expect(newDocumentSelector).toContain('<option value="0">0 % · Hors TVA / taux 0</option>');
  });

  it('reconstitue la base et affiche le total calculé d’un acompte', () => {
    const invoice: Invoice = {
      id: 'invoice-1',
      number: '',
      clientId: client.id,
      projectId: null,
      quoteId: null,
      originalInvoiceId: null,
      title: 'Acompte plomberie',
      type: 'deposit',
      depositPercentageBp: 3_000,
      depositBasisLines: [
        {
          id: 'invoice-line-1',
          catalogItemId: 'catalog-1',
          description: 'Intervention',
          quantity: 2,
          unit: 'heure',
          unitPriceCents: 5_000,
          discountBp: 0,
          vatRateBp: 0,
        },
      ],
      issueDate: '2026-09-03',
      dueDate: '2026-09-30',
      serviceDateFrom: '2026-09-03',
      serviceDateTo: '2026-09-03',
      currency: 'CHF',
      status: 'draft',
      lines: [
        {
          id: 'invoice-line-1',
          catalogItemId: null,
          description: 'Acompte 30 % — Intervention',
          quantity: 1,
          unit: 'acompte',
          unitPriceCents: 3_000,
          discountBp: 0,
          vatRateBp: 0,
        },
      ],
      notes: '',
      terms: '',
      createdAt: '2026-09-03T10:00:00Z',
    };
    const html = renderToStaticMarkup(
      <DocumentEditor
        entity="invoices"
        item={invoice}
        workspace={workspace({ invoices: [invoice] })}
        busy={false}
        close={() => undefined}
        act={async () => true}
      />,
    );

    expect(html).toContain('Base de calcul de l’acompte');
    expect(html).toContain('Base TTC');
    expect(html).toContain('Acompte TTC');
    expect(html).toContain('value="30"');
    expect(html).toContain('value="2"');
    expect(html).toContain('value="heure"');
    expect(html).toContain('100.00 CHF');
    expect(html).toContain('30.00 CHF');
  });

  it('préserve par défaut le montant d’un ancien acompte sans pourcentage enregistré', () => {
    const legacyInvoice: Invoice = {
      id: 'invoice-legacy-deposit',
      number: '',
      clientId: client.id,
      projectId: null,
      quoteId: null,
      originalInvoiceId: null,
      title: 'Ancien acompte',
      type: 'deposit',
      depositPercentageBp: null,
      depositBasisLines: null,
      issueDate: '2026-09-03',
      dueDate: '2026-09-30',
      serviceDateFrom: '2026-09-03',
      serviceDateTo: '2026-09-03',
      currency: 'CHF',
      status: 'draft',
      lines: [
        {
          id: 'invoice-line-legacy',
          catalogItemId: null,
          description: 'Acompte historique',
          quantity: 1,
          unit: 'forfait',
          unitPriceCents: 3_000,
          discountBp: 0,
          vatRateBp: 0,
        },
      ],
      notes: '',
      terms: '',
      createdAt: '2026-09-03T10:00:00Z',
    };
    const html = renderToStaticMarkup(
      <DocumentEditor
        entity="invoices"
        item={legacyInvoice}
        workspace={workspace({ invoices: [legacyInvoice] })}
        busy={false}
        close={() => undefined}
        act={async () => true}
      />,
    );

    expect(html).toContain('value="100"');
    expect(html).toContain('30.00 CHF');
    expect(html).not.toContain('9.00 CHF');
  });
});
