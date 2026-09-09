import { describe, expect, it } from 'vitest';
import {
  automaticGuidedTourSteps,
  guidedTourSteps,
  type TourView,
} from './GuidedTour';
import { guideLessons, restoredGuideIndex } from './guideLessons';

describe('guide interactif', () => {
  it('reprend un sujet existant et ignore une progression inconnue ou supprimée', () => {
    const ids = guidedTourSteps.map((step) => step.id);
    expect(restoredGuideIndex(ids, 'invoices')).toBe(ids.indexOf('invoices'));
    expect(restoredGuideIndex(ids, null)).toBe(0);
    expect(restoredGuideIndex(ids, 'removed-lesson')).toBe(0);
    expect(restoredGuideIndex(ids, '999')).toBe(0);
  });
  it('accompagne chaque écran avec trois actions et un conseil', () => {
    for (const step of [...guidedTourSteps, ...automaticGuidedTourSteps]) {
      const lesson = guideLessons[step.id];
      expect(lesson.chapter).toBeTruthy();
      expect(lesson.actions).toHaveLength(3);
      expect(lesson.actions.every((action) => action.length > 20)).toBe(true);
      expect(lesson.tip.length).toBeGreaterThan(30);
    }
  });
  it('couvre chaque module clé du menu', () => {
    const expectedViews: TourView[] = [
      'dashboard',
      'agenda',
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

  it('limite le guide automatique au démarrage, au premier client et à la préparation', () => {
    expect(automaticGuidedTourSteps).toHaveLength(3);
    expect(automaticGuidedTourSteps.map((step) => step.id)).toEqual([
      'overview',
      'clients',
      'readiness',
    ]);
    expect(automaticGuidedTourSteps.map((step) => step.view)).toEqual([
      'dashboard',
      'clients',
      'settings',
    ]);
    expect(automaticGuidedTourSteps.at(-1)?.target).toBe('.setup-readiness');
  });

  it('garde des identifiants, cibles et explications exploitables', () => {
    const ids = guidedTourSteps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of [...guidedTourSteps, ...automaticGuidedTourSteps]) {
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
