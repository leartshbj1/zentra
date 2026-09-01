import { describe, expect, it } from 'vitest';
import { guidedTourSteps, type TourView } from './GuidedTour';

describe('guide interactif', () => {
  it('couvre chaque module clé du menu', () => {
    const expectedViews: TourView[] = [
      'dashboard',
      'projects',
      'clients',
      'catalog',
      'quotes',
      'orders',
      'invoices',
      'reminders',
      'time',
      'team',
      'expenses',
      'bank',
      'reports',
      'accounting',
      'settings',
    ];
    expect(new Set(guidedTourSteps.map((step) => step.view))).toEqual(
      new Set(expectedViews),
    );
  });

  it('garde des identifiants, cibles et explications exploitables', () => {
    const ids = guidedTourSteps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of guidedTourSteps) {
      expect(step.target.startsWith('.')).toBe(true);
      expect(step.title.trim().length).toBeGreaterThan(8);
      expect(step.text.trim().length).toBeGreaterThan(35);
    }
  });

  it('termine par la maintenance afin de laisser une action sûre et relançable', () => {
    const last = guidedTourSteps.at(-1);
    expect(last?.view).toBe('settings');
    expect(last?.target).toBe('.app-updater');
  });
});
