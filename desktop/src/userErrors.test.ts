import { describe, expect, it } from 'vitest';
import { appLanguages } from './language';
import { classifyUserError, getUserError, safeErrorDetails, userErrorCopy } from './userErrors';
import { errorMessage } from './utils';

describe('messages humains et données brutes des erreurs', () => {
  it.each([
    [new Error('Failed to fetch'), 'network'], [{ status: 503, message: 'unavailable' }, 'network'], ['network request failed', 'network'],
    [{ status: 401, message: 'JWT expired' }, 'session'], ['refresh_token expired', 'session'],
    [{ statusCode: '403', message: 'denied' }, 'permission'], ['new row violates row-level security policy', 'permission'],
    [{ code: '23505', message: 'duplicate key' }, 'conflict'], ['database is locked', 'conflict'], ['version modifiée ailleurs', 'conflict'],
    [{ status: 422, message: 'invalid input' }, 'validation'], ['Le montant doit être positif.', 'validation'],
    ['ENOENT no such file', 'file'], ['no space left on device', 'file'], ['Fichier introuvable', 'file'],
    [new Error('unexpected internal state at crate::secret'), 'unknown'], [null, 'unknown'], [{ unexpected: true }, 'unknown'],
  ])('classe %s sans modifier la raison originale', (reason, kind) => {
    const raw = errorMessage(reason, 'fallback');
    expect(classifyUserError(reason)).toBe(kind);
    expect(errorMessage(reason, 'fallback')).toBe(raw);
  });

  it.each(appLanguages)('donne une explication et une correction pour toutes les familles en %s', language => {
    const labels = userErrorCopy(language);
    for (const kind of ['network', 'session', 'permission', 'workspace', 'conflict', 'validation', 'file', 'unknown'] as const) {
      expect(labels[kind].title.length).toBeGreaterThan(8);
      expect(labels[kind].message.length).toBeGreaterThan(20);
      expect(labels[kind].action.length).toBeGreaterThan(20);
      if (language !== 'fr') expect(labels[kind]).not.toEqual(userErrorCopy('fr')[kind]);
    }
  });

  it.each(appLanguages)('explique une mutation incertaine sans inviter à la répéter en %s', language => {
    const mutation = getUserError('Failed to fetch', { language, operation: 'mutation' });
    expect(mutation.action).toContain(userErrorCopy(language).uncertain);
    expect(getUserError('Failed to fetch', { language, operation: 'read' }).action).not.toContain(userErrorCopy(language).uncertain);
  });

  it.each(appLanguages)('distingue une lecture inconnue et un résultat de mutation incertain en %s', language => {
    const labels = userErrorCopy(language);
    const read = getUserError('unexpected internal state', { language, operation: 'read' });
    expect(read).toMatchObject({ kind: 'unknown', ...labels.unknownRead });
    expect(read.action).not.toContain(labels.unknown.action);
    expect(read.action).not.toContain(labels.uncertain);
    const mutation = getUserError('unexpected internal state', { language, operation: 'mutation' });
    expect(mutation).toMatchObject({ kind: 'unknown', title: labels.unknown.title, message: labels.unknown.message, action: `${labels.unknown.action} ${labels.uncertain}` });
    expect(getUserError('unexpected internal state', { language })).toEqual(mutation);
    expect(getUserError('unexpected internal state', { language, operation: 'read', fallback: 'Une lecture ciblée est indisponible.' }).message).toBe('Une lecture ciblée est indisponible.');
  });

  it('ne transforme pas un message interne inconnu en explication principale', () => {
    const raw = 'panic internal::billing customer="Alice" password=unsafe';
    const error = getUserError(raw, { fallback: 'Le brouillon reste ouvert.' });
    expect(error.message).toBe('Le brouillon reste ouvert.');
    expect(error.message).not.toContain('panic');
    expect(error.technicalDetails).not.toContain('Alice');
    expect(error.technicalDetails).not.toContain('unsafe');
  });

  it('évite les invitations à réenregistrer héritées des anciens fallbacks', () => {
    const error = getUserError('internal panic', { fallback: 'Réessayez de créer la facture.' });
    expect(error.message).not.toMatch(/Réessayez/);
    expect(error.action).toContain('vérifiez si l’action apparaît déjà');
  });

  it('conserve les messages métier utilisés par les garde-fous et contract tests', () => {
    const original = new Error('UNIQUE constraint failed: invoices.number');
    getUserError(original);
    expect(errorMessage(original, 'Erreur')).toBe('UNIQUE constraint failed: invoices.number');
    expect(original.message).toBe('UNIQUE constraint failed: invoices.number');
  });

  it.each([
    'La connexion ou l’entreprise ouverte a changé. Rouvrez la réception.',
    'L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.',
    'L’espace de travail a changé pendant l’actualisation des réglages enregistrés.',
  ])('reconnaît le changement d’espace derrière le préfixe natif : %s', message => {
    const reason = `Champ invalide : ${message}`;
    expect(classifyUserError(reason)).toBe('workspace');
    expect(classifyUserError(message)).toBe('workspace');
    expect(classifyUserError(reason.replaceAll('’', "'"))).toBe('workspace');
    expect(errorMessage(reason, '')).toBe(reason);
  });

  it.each([401, 403])('conserve la priorité HTTP %s sur le changement d’espace', status => {
    const message = 'Champ invalide : La connexion ou l’entreprise ouverte a changé. Rouvrez la réception.';
    expect(classifyUserError({ status, message })).toBe(status === 401 ? 'session' : 'permission');
    expect(classifyUserError(`${status} ${message}`)).toBe(status === 401 ? 'session' : 'permission');
  });

  it.each(appLanguages)('oriente vers l’entreprise et distingue lecture/mutation en %s', language => {
    const reason = 'Champ invalide : L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.';
    const read = getUserError(reason, { language, operation: 'read' });
    const mutation = getUserError(reason, { language, operation: 'mutation' });
    expect(read.kind).toBe('workspace'); expect(mutation.kind).toBe('workspace');
    expect(read.title).not.toBe(userErrorCopy(language).validation.title);
    expect(read.action).not.toBe(userErrorCopy(language).validation.action);
    expect(read.action).not.toContain(userErrorCopy(language).uncertain);
    expect(mutation.action).not.toBe(read.action);
    expect(mutation.action).not.toBe(userErrorCopy(language).validation.action);
    expect(getUserError(reason, { language })).toEqual(mutation);
  });

  it('ne transforme pas une autre validation d’entreprise en changement d’espace', () => {
    expect(classifyUserError('Champ invalide : Le nom de l’entreprise doit être complété.')).toBe('validation');
    expect(classifyUserError('Champ invalide : L’entreprise ouverte a changé. Vérifiez la date.')).toBe('validation');
  });

  it('garde les détails masqués et la raison métier intacte pour un changement d’espace', () => {
    const reason = new Error('Champ invalide : La connexion ou l’entreprise ouverte a changé. Rouvrez la réception. token=private-workspace-secret alice@example.ch C:\\Users\\Alice\\company.db');
    const message = reason.message, error = getUserError(reason, { operation: 'read' });
    expect(error.kind).toBe('workspace');
    expect(error.message).not.toContain('private-workspace-secret');
    expect(error.technicalDetails).not.toMatch(/private-workspace-secret|alice@example.ch|Alice/);
    expect(errorMessage(reason, '')).toBe(message);
  });
});

describe('détails techniques sans secrets', () => {
  it.each([
    ['Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
    ['password=very-secret', 'very-secret'],
    ['password contains private phrase with spaces', 'private phrase'],
    ['Cookie: first=secret; second=private-value', 'private-value'],
    ['{"client_secret":"very-secret"}', 'very-secret'],
    ['token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature', 'eyJhbGciOiJIUzI1NiJ9'],
    ['postgres://user:secret@host/private_db', 'secret@host'],
    ['https://host/private?api_key=my-secret#access', 'my-secret'],
    ['alice@example.ch', 'alice@example.ch'],
    ['C:\\Users\\Alice\\private\\bank.pdf', 'Alice'],
    ['/home/alice/private/company.db', 'alice'],
    ["INSERT INTO customers VALUES ('Private customer', 'confidential')", 'Private customer'],
    ['sk_test_123456789abcdefghijk', 'sk_test_'],
    ['CH9300762011623852957', 'CH9300762011623852957'],
  ])('retire la donnée sensible de %s', (raw, secret) => expect(safeErrorDetails(raw)).not.toContain(secret));

  it('borne les détails sans conserver une pile complète ni un objet arbitraire', () => {
    const reason = Object.assign(new Error('network failed'), { password: 'hidden', stack: 'secret stack' });
    expect(safeErrorDetails(reason)).toBe('network failed');
    expect(safeErrorDetails('unexpected '.repeat(1_000)).length).toBeLessThanOrEqual(900);
    expect(safeErrorDetails({ password: 'hidden' })).toBe('');
  });

  it('peut expliquer une erreur dont les propriétés ne sont pas lisibles', () => {
    const error = Object.defineProperties({}, { message: { get() { throw new Error('unreadable'); } }, status: { get() { throw new Error('unreadable'); } }, code: { get() { throw new Error('unreadable'); } } });
    expect(getUserError(error).kind).toBe('unknown');
    expect(safeErrorDetails(error)).toBe('');
  });
});

import {DocumentCreationUnconfirmedError,isDocumentCreationUnconfirmedError} from './documentCreationRequest';
import {diagnosticOperation,knownErrorIncident,recentDiagnosticEvents,resolveErrorIncident} from './diagnostics';
import {createLocalValidationError} from './localValidation';
describe('uncertain document creation guidance',()=>{
 it.each(appLanguages)('shows explicit creation guidance in %s without fields or blind retry',language=>{
   const reason=new DocumentCreationUnconfirmedError(new Error('Champ invalide : Réponse perdue.'));
   const expected=userErrorCopy(language).documentCreationUnknown;
   expect(classifyUserError(reason)).toBe('unknown');
   expect(getUserError(reason,{language,operation:'mutation',fallback:'Corrigez les champs.'})).toEqual({kind:'unknown',...expected,technicalDetails:reason.message});
   expect(getUserError(reason,{language,operation:'read',fallback:'Réessayez de créer.'})).toEqual({kind:'unknown',...expected,technicalDetails:reason.message});
   expect(expected.title).not.toBe(userErrorCopy(language).validation.title);expect(expected.action).not.toBe(userErrorCopy(language).validation.action);
   expect(expected.action).not.toMatch(/réessay|retry|try again|erneut erstellen|riprova/i);
   if(language!=='fr')expect(expected).not.toEqual(userErrorCopy('fr').documentCreationUnknown);
 });
 it('classifies genuine identity before reading message, status, code, name, prototype or cause',()=>{
   const reason=new DocumentCreationUnconfirmedError(null);let accesses=0;
   for(const key of ['message','status','statusCode','code','name','cause'])Object.defineProperty(reason,key,{configurable:true,get(){accesses++;throw Error('not classification input');}});
   expect(classifyUserError(reason)).toBe('unknown');expect(accesses).toBe(0);
 });
 it.each([
   ['native string','Champ invalide : La création du document doit être vérifiée avant tout nouvel envoi.'],
   ['ordinary native error',new Error('Champ invalide : Le montant doit être positif.')],
   ['same name',Object.assign(new Error('Champ invalide : Le montant doit être positif.'),{name:'DocumentCreationUnconfirmedError'})],
   ['borrowed prototype',Object.assign(Object.create(DocumentCreationUnconfirmedError.prototype),{message:'Champ invalide : Le montant doit être positif.'})],
   ['message alone',new DocumentCreationUnconfirmedError(null).message],
 ] as const)('preserves real validation for %s',(_name,reason)=>{expect(isDocumentCreationUnconfirmedError(reason)).toBe(false);expect(classifyUserError(reason)).toBe('validation');expect(getUserError(reason,{language:'fr'}).title).toBe(userErrorCopy('fr').validation.title);});
 it('preserves an explicit local validation and its 900-unit limit',()=>{
   const reason=createLocalValidationError('N'.repeat(1800),'fr');
   expect(getUserError(reason,{language:'fr'})).toMatchObject({kind:'validation',message:'N'.repeat(899)+'…',technicalDetails:''});expect(reason.message.length).toBe(900);
 });
 it('retains the known source incident without logging reasons, arguments or another presentation',async()=>{
   const source=new Error('Failed to fetch password=private-example');
   await expect(diagnosticOperation('command','native.save_document_with_items',async()=>{throw source;})).rejects.toBe(source);
   const known=knownErrorIncident(source);expect(known).toBeDefined();
   const wrapper=new DocumentCreationUnconfirmedError(source),count=recentDiagnosticEvents().length;
   expect(knownErrorIncident(wrapper)).toEqual(known);getUserError(wrapper,{language:'en'});expect(resolveErrorIncident(wrapper)).toEqual(known);
   expect(recentDiagnosticEvents()).toHaveLength(count);expect(JSON.stringify(recentDiagnosticEvents())).not.toContain('private-example');
 });
});
