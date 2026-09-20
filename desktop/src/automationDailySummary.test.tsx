import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutomationDailySummaryView } from './AutomationDailySummary';
import type { AutomationState } from './automation';

const state: AutomationState = {
  organizationId: 'company-a', active: true, canManage: false,
  available: ['transaction_classification'],
  settings: { enabled: true, consent: true, mode: 'suggest', flags: ['transaction_classification'], thresholds: { medium: .65, high: .9 } },
  activity: { date: '2026-09-20', timeZone: 'Europe/Zurich', updatedAt: 1, displayName: 'Camille',
    totals: { analyzed: 4, suggestions: 3, confirmed: 2, needsReview: 1, observed: 0 },
    features: [{ feature: 'transaction_classification', analyzed: 4, suggestions: 3, confirmed: 2, needsReview: 1, observed: 0 }] },
};
it('renders no promotion, placeholder or activity for companies without Automation', () => {
  expect(renderToStaticMarkup(<AutomationDailySummaryView state={{ ...state, active: false }} />)).toBe('');
  expect(renderToStaticMarkup(<AutomationDailySummaryView state={{ ...state, activity: null }} />)).toBe('');
});
it('shows the same company totals to a collaborator and a manager without claiming automatic payments', () => {
  const member = renderToStaticMarkup(<AutomationDailySummaryView state={state} />);
  const owner = renderToStaticMarkup(<AutomationDailySummaryView state={{ ...state, canManage: true }} />);
  expect(member).toBe(owner);
  expect(member).toContain('Bonjour, Camille');
  expect(member).toContain('Choix validés par l’équipe');
  expect(member).toContain('pas des paiements ou des écritures automatiques');
  expect(member).not.toContain('15 CHF');
});
it('keeps an honest empty state instead of displaying invented savings or completed tasks', () => {
  const html = renderToStaticMarkup(<AutomationDailySummaryView state={{ ...state, activity: { ...state.activity!, totals: { analyzed: 0, suggestions: 0, confirmed: 0, needsReview: 0, observed: 0 }, features: [] } }} />);
  expect(html).toContain('Les prochaines analyses apparaîtront ici');
  expect(html).not.toContain('<dd>');
});
