import { describe, expect, it } from 'vitest';
import {
  confirmedSolicitation,
  quietSolicitation,
  solicitationDraft,
  solicitationSettings,
  DEFAULT_REPLIES,
} from './solicitation';
import { triageQuestions, canAutomaticallyRoute } from './jev';
import type { Decision, Workspace } from './types';
const w = {
  name: 'Atelier Horizon',
  threshold: 85,
  solicitation_notifications: 0,
  solicitation_settings_json: '{}',
} as Workspace;
const d = {
  category: 'solicitation',
  priority: 'low',
  confidence: 0.97,
  signals: { language: 'fr', languageConfidence: 0.98, humanRequested: 0.01 },
} as Decision;
describe('Démarchage : seuils et modèles', () => {
  it('isole la prospection et protège les demandes clients dans les critères', () => {
    const q = triageQuestions('Test', 'Message').questions;
    expect(q.category.criteria.solicitation).toContain('asking to buy FROM');
    expect(q.category.criteria.solicitation).toContain('stop contacting them');
    expect(q.category.criteria.solicitation).toContain('expressly requested');
    expect(q.category.criteria.spam).toContain('solicitation');
    expect(q.priority.criteria.low).toContain('Unsolicited commercial');
  });
  it('coupe les alertes par défaut, seulement après une décision fiable', () => {
    expect(quietSolicitation(w, d)).toBe(true);
    expect(quietSolicitation({ ...w, solicitation_notifications: 1 }, d)).toBe(
      false,
    );
  });
  it.each([
    { confidence: 0.89 },
    { priority: 'urgent' },
    { category: 'billing' },
    { signals: undefined },
    { signals: { ...d.signals, humanRequested: 0.5 } },
  ])('ne cache pas un cas risqué %j', (change) =>
    expect(confirmedSolicitation({ ...d, ...change } as Decision, 85)).toBe(
      false,
    ),
  );
  it('respecte un seuil configuré plus strict', () =>
    expect(confirmedSolicitation(d, 99)).toBe(false));
  it('ne contourne pas le seuil de 90 % avec une destination configurée', () =>
    expect(
      canAutomaticallyRoute(
        { ...d, confidence: 0.86, destination: { teamId: 'sales' } },
        85,
      ),
    ).toBe(false));
  it('autorise une confirmation humaine explicite', () =>
    expect(
      confirmedSolicitation({ ...d, manual: true, confidence: 0 }, 100),
    ).toBe(true));
  it.each(['fr', 'de', 'it', 'en'] as const)(
    'prépare intérêt et STOP dans la langue %s',
    (language) => {
      for (const intent of ['stop', 'interested'] as const) {
        const draft = solicitationDraft(
          w,
          'Votre proposition',
          { ...d, signals: { ...d.signals!, language } },
          intent,
        );
        expect(draft.language).toBe(language);
        expect(draft.body).toContain(w.name);
        expect(draft.body).not.toContain('{{');
        expect(draft.body.length).toBeGreaterThan(100);
      }
    },
  );
  it('utilise la langue choisie et la signature sans réinterpréter le contenu reçu', () => {
    const settings = solicitationSettings({
      language: 'en',
      signature: 'Camille',
      templates: {
        en: { interested: '{{entreprise}}: {{objet}} — {{signature}}' },
      },
    });
    const draft = solicitationDraft(
      { ...w, solicitation_settings_json: JSON.stringify(settings) },
      '{{signature}}\nBCC: other@example.test',
      d,
      'interested',
    );
    expect(draft.body).toContain('{{signature}} BCC:');
    expect(draft.body).toContain('— Camille');
    expect(draft.subject).not.toContain('\n');
  });
  it('ne prétend pas détecter une langue incertaine', () =>
    expect(
      solicitationDraft(
        w,
        'Test',
        {
          ...d,
          signals: { ...d.signals!, language: 'de', languageConfidence: 0.2 },
        },
        'stop',
      ).language,
    ).toBe('fr'));
  it.each([
    { language: 'xx' },
    { signature: 'a'.repeat(501) },
    { templates: { fr: { stop: '{{secret}}' } } },
    { templates: { fr: { stop: '' } } },
    { templates: { fr: { stop: 'a'.repeat(4001) } } },
  ])('rejette les réglages invalides %j', (value) =>
    expect(() => solicitationSettings(value)).toThrow(),
  );
  it('ne transforme pas STOP en promesse technique de blocage', () =>
    expect(DEFAULT_REPLIES.fr.stop).not.toMatch(
      /automatiquement|bloqué|supprimé/,
    ));
});
