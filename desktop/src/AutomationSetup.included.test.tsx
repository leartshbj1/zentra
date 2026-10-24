import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AutomationSetup } from './AutomationControls';

it('presents Autopilote as included in every formula, with nothing to buy separately', () => {
  const html = renderToStaticMarkup(<AutomationSetup onSkip={() => {}} onContinue={() => {}} />);
  expect(html).toContain('Autopilote est inclus dans chaque formule');
  expect(html).toContain('Voir mon abonnement');
  expect(html).toContain('Plus tard');
  for (const sold of ['CHF', 'Ajouter Autopilote', 'Option facultative', 'sans cette option', 'paiement'])
    expect(html).not.toContain(sold);
});
