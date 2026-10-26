// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChapterHeading, MeasurementPanel, withMeasurements } from './LineLayout';
import type { DocumentLine } from './types';

vi.mock('./language', () => ({ useAppLanguage: () => 'fr', getAppLocale: () => 'fr-CH', t: (text: string, values?: Record<string, unknown>) => text.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? '')) }));

const line: DocumentLine = { id: 'l1', description: 'Peinture murs', quantity: 1, unit: 'm²', unitPriceCents: 2_500, vatRateBp: 810 };

describe('chapitres et métré dans l’éditeur', () => {
  it('la quantité suit le métré et revient libre quand il est vide', () => {
    const measured = withMeasurements(line, [{ label: 'Mur', formula: '4,2 × 2,6' }, { label: 'Porte', formula: '0,9 × 2,1', deduct: true }]);
    expect(measured.quantity).toBe(9.03);
    expect(measured.measurements).toHaveLength(2);
    // Une formule en cours de saisie ne remet pas la quantité à zéro.
    expect(withMeasurements(measured, [...measured.measurements!, { label: '', formula: '2 ×' }]).quantity).toBe(9.03);
    const cleared = withMeasurements(measured, []);
    expect(cleared).not.toHaveProperty('measurements');
    expect(cleared.quantity).toBe(9.03);
  });

  it('affiche le calcul de chaque mesure et la quantité totale', () => {
    const html = renderToStaticMarkup(<MeasurementPanel line={withMeasurements(line, [{ label: 'Mur', formula: '4,2 × 2,6' }, { label: 'Porte', formula: '0,9 × 2,1', deduct: true }])} onChange={() => undefined} />);
    expect(html).toContain('10,92 m²');
    expect(html).toContain('− 1,89 m²');
    expect(html).toContain('Quantité calculée');
    expect(html).toContain('9,03');
    const wrong = renderToStaticMarkup(<MeasurementPanel line={{ ...line, measurements: [{ label: '', formula: '4,2 ×' }] }} onChange={() => undefined} />);
    expect(wrong).toContain('Une formule est à corriger.');
  });

  it('montre le titre du chapitre et son sous-total', () => {
    const html = renderToStaticMarkup(<ChapterHeading title="Salon" subtotal="CHF 575.75" onRename={() => undefined} onRemove={() => undefined} />);
    expect(html).toContain('value="Salon"');
    expect(html).toContain('CHF 575.75');
    expect(html).toContain('Retirer le chapitre');
  });
});
