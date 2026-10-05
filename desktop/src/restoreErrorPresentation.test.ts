import { describe, expect, it } from 'vitest';
import { appLanguages } from './language';
import { restoreErrorPresentation } from './restoreErrorPresentation';
import { classifyUserError } from './userErrors';
import { createLocalValidationError } from './localValidation';
import { DocumentCreationUnconfirmedError } from './documentCreationRequest';
import { diagnosticOperation, knownErrorIncident } from './diagnostics';

const pending = 'Une restauration doit être reprise avant de rouvrir l’entreprise. Les fichiers disponibles sont conservés. Fermez puis rouvrez Zentra. Si le problème persiste, contactez le support sans supprimer le dossier local.';
const committed = 'La restauration est terminée et les données sont enregistrées. Le nettoyage des anciennes copies n’a pas pu se terminer. Fermez puis rouvrez Zentra pour le reprendre. Si ce message revient, contactez le support.';
const rollback = 'La restauration a été annulée et les données précédentes ont été rétablies. Cause : FA-401 source failure Une sauvegarde de sécurité reste disponible dans C:\\Users\\Test\\safety.zentra.';
const incomplete = 'La restauration a échoué (Champ invalide : FA-403) et le retour automatique est incomplet (Access is denied. (os error 5)). Récupérez la sauvegarde de sécurité : C:\\Users\\Test\\safety.zentra.';
const messages = [
  [pending, 'resume'], [committed, 'committed'], [rollback, 'rolledBack'], [incomplete, 'resume'],
  [`Champ invalide : ${rollback}`, 'rolledBack'], [`Champ invalide : ${incomplete}`, 'resume'],
  ['La préparation de la restauration a échoué (ENOENT) et le retour automatique est incomplet (permission denied). Les fichiers disponibles sont conservés ; fermez puis rouvrez Zentra avant de reprendre.', 'resume'],
  ['L’installation de la sauvegarde a échoué (FA-401) et les données précédentes n’ont pas pu être entièrement rétablies (Access is denied. (os error 5)).', 'resume'],
  ['Les pièces jointes à restaurer sont inaccessibles. Les fichiers disponibles sont conservés.', 'sourceFiles'],
] as const;

describe('native restore envelopes are presentation only', () => {
  for (const language of appLanguages) {
    it.each(messages)('presents the closed %s envelope in ' + language, (raw, state) => {
      const original = raw, kind = classifyUserError(raw);
      const guide = restoreErrorPresentation(raw, language);
      expect(guide?.state).toBe(state);
      expect(guide?.title.length).toBeGreaterThan(8);
      expect(guide?.message.length).toBeGreaterThan(25);
      expect(guide?.action.length).toBeGreaterThan(30);
      expect(guide?.message).not.toContain('FA-');
      expect(guide?.action).not.toMatch(/montants|Beträge|importi|amounts/);
      if (language !== 'fr') expect(guide?.title).not.toBe(restoreErrorPresentation(raw, 'fr')?.title);
      expect(raw).toBe(original);
      expect(classifyUserError(raw)).toBe(kind);
    });
  }
  it.each([
    null, undefined, 401, { message: pending }, { status: 401, message: pending }, { code: 'storage.restore', message: committed },
    new Error(pending), createLocalValidationError(pending, 'fr'), new DocumentCreationUnconfirmedError(pending),
    'La restauration doit être reprise.', `Champ invalide : ${pending}`, `Champ invalide : ${committed}`,
    `Le nom du client « ${pending} » est invalide.`, `Champ invalide : Le nom du client « ${rollback} » doit être corrigé.`,
    `Erreur de fichier local : ${incomplete}`, `Cause : ${rollback}`, `${committed} FA-401`, pending.toLowerCase(),
    'La restauration a été annulée et les données précédentes ont été rétablies. Cause : ',
    'La restauration a échoué (cause) et le retour automatique est incomplet',
    'L’installation de la sauvegarde a échoué (cause).',
  ])('does not reinterpret user values, field errors or unrelated errors: %s', reason => {
    expect(restoreErrorPresentation(reason, 'en')).toBeNull();
  });
  it('never reads properties of an arbitrary object', () => {
    const reason = Object.defineProperty({}, 'message', { get() { throw Error('must not inspect'); } });
    expect(restoreErrorPresentation(reason, 'en')).toBeNull();
  });
  it('does not change legacy auth classification or decide whether to replay', () => {
    expect(classifyUserError(rollback)).toBe('session');
    const guide = restoreErrorPresentation(rollback, 'en');
    expect(guide?.state).toBe('rolledBack');
    expect(guide).not.toHaveProperty('kind');
    expect(guide).not.toHaveProperty('retry');
    expect(guide?.message).toBe('The previous data has been restored.');
  });
  it('retains the original command failure and its known incident association', async () => {
    let caught: unknown;
    try { await diagnosticOperation('command', 'restore_backup', async () => { throw incomplete; }); }
    catch (reason) { caught = reason; }
    const incident = knownErrorIncident(caught);
    expect(incident?.code).toMatch(/^ZT-/);
    expect(restoreErrorPresentation(caught, 'de')?.state).toBe('resume');
    expect(caught).toBe(incomplete);
    expect(knownErrorIncident(caught)).toEqual(incident);
  });
});
