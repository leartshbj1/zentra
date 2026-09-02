import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GettingStartedChecklist } from './GettingStartedChecklist';
import type { Workspace } from './types';

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    clients: [],
    projects: [],
    quotes: [],
    invoices: [],
    payments: [],
    accountingSettings: null,
    backupStatus: {
      lastSuccessAt: null,
      lastPath: null,
      nextScheduledAt: null,
    },
    ...overrides,
  } as Workspace;
}

describe('checklist de premiers pas', () => {
  it('rend une seule prochaine action et une progression accessible', () => {
    const html = renderToStaticMarkup(
      <GettingStartedChecklist
        workspace={workspace()}
        readOnly={false}
        onAction={() => undefined}
      />,
    );

    expect(html).toContain('Avancez avec vos données réelles');
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('aria-valuemax="6"');
    expect(html).toContain('0 étapes terminées sur 6');
    expect(html).toContain('aria-current="step"');
    expect(html.match(/data-getting-started-action=/g)).toHaveLength(1);
    expect(html).toContain('data-getting-started-action="create_client"');
    expect(html).toContain('Ajouter mon premier client');
  });

  it('reste consultable en lecture seule sans promettre une modification', () => {
    const html = renderToStaticMarkup(
      <GettingStartedChecklist
        workspace={workspace()}
        readOnly
        onAction={() => undefined}
      />,
    );

    expect(html).toContain('La licence est en lecture seule');
    expect(html).toContain('Voir les clients');
    expect(html).not.toContain('Ajouter mon premier client');
    expect(html).toContain('button--secondary');
  });

  it('conserve la progression après le premier client au lieu de disparaître', () => {
    const html = renderToStaticMarkup(
      <GettingStartedChecklist
        workspace={workspace({
          clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
        })}
        readOnly={false}
        onAction={() => undefined}
      />,
    );

    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('1 étape terminée sur 6');
    expect(html).toContain('data-getting-started-action="create_project"');
    expect(html).toContain('Créer le premier projet');
  });

  it('n’affiche plus d’action lorsque toutes les preuves réelles existent', () => {
    const completeWorkspace = workspace({
      clients: [{ id: 'client-1', archivedAt: null } as Workspace['clients'][number]],
      projects: [{ id: 'project-1', clientId: 'client-1', archivedAt: null } as Workspace['projects'][number]],
      quotes: [{ id: 'quote-1', clientId: 'client-1', number: 'DEV-1', status: 'accepted' } as Workspace['quotes'][number]],
      invoices: [{ id: 'invoice-1', clientId: 'client-1', quoteId: 'quote-1', number: 'FAC-1', type: 'standard', status: 'paid' } as Workspace['invoices'][number]],
      payments: [{
        id: 'payment-1',
        invoiceId: 'invoice-1',
        amountCents: 10_000,
        journalEntryId: 'journal-1',
        journalEntryIsActive: true,
        journalEntrySemanticallyValid: true,
      } as Workspace['payments'][number]],
      backupStatus: {
        lastSuccessAt: '2026-09-02T08:00:00+02:00',
        lastPath: 'D:\\Sauvegardes Zentra\\zentra.zentra',
        nextScheduledAt: null,
      },
    });
    const html = renderToStaticMarkup(
      <GettingStartedChecklist
        workspace={completeWorkspace}
        readOnly={false}
        onAction={() => undefined}
      />,
    );

    expect(html).toContain('Votre chaîne initiale est opérationnelle');
    expect(html).toContain('Toutes les étapes ont été confirmées');
    expect(html).not.toContain('data-getting-started-action');
  });
});
