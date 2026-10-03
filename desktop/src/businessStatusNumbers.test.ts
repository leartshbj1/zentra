import {beforeEach,describe,expect,it,vi} from 'vitest';
import {classifyUserError,getUserError} from './userErrors';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn().mockRejectedValue(new Error('Unexpected native invocation in a helper-only test'))}));
beforeEach(()=>vi.resetModules());
const diagnostics=()=>import('./diagnostics');

const localErrors=[
 ['Erreur de base de données locale :','unknown','STORAGE'],
 ['Erreur de fichier local :','unknown','STORAGE'],
 ['Données JSON invalides :','unknown','VALIDATION'],
 ['Formulaire PDF invalide :','unknown','VALIDATION'],
 ['Archive Zentra invalide :','unknown','VALIDATION'],
 ['Champ invalide :','validation','VALIDATION'],
 ['Enregistrement introuvable :','unknown','NOT_FOUND'],
 ['Chemin refusé car il sort du dossier local autorisé :','unknown','PERMISSION'],
] as const;

describe('business references do not assert HTTP status',()=>{
 it.each(localErrors.flatMap(([prefix,human,category])=>[401,403,404,409,500].map(number=>({prefix,human,category,number}))))
 ('keeps a local $prefix reference $number in its existing category',async({prefix,human,category,number})=>{
  const reason=`${prefix} Référence FA-${number}.`,original=new Error(reason),journal=await diagnostics();
  expect(classifyUserError(reason)).toBe(human);
  expect(classifyUserError(original)).toBe(human);
  expect(journal.classifyDiagnosticError(reason)).toBe(category);
  expect(journal.classifyDiagnosticError(original)).toBe(category);
  expect(original.message).toBe(reason);
 });

 it('recognises native prefixes after whitespace without changing the original error',async()=>{
  const reason=' \n Champ invalide : La date de la facture FA-401 doit être corrigée.  ';
  const journal=await diagnostics();
  expect(classifyUserError(reason)).toBe('validation');
  expect(journal.classifyDiagnosticError(reason)).toBe('VALIDATION');
  await expect(journal.diagnosticOperation('command','test.synthetic_validation',async()=>{throw reason;})).rejects.toBe(reason);
 });

 it.each([[401,'session','SESSION'],[403,'permission','PERMISSION'],[409,'conflict','CONFLICT']] as const)
 ('keeps explicit HTTP status %s and structured metadata',async(status,human,category)=>{
  const journal=await diagnostics();
  for(const label of [`HTTP ${status}`,`HTTP/1.1 ${status}`,`status code: ${status}`]){
   const reason=`Champ invalide : Le service renvoie ${label}.`;
   expect(classifyUserError(reason)).toBe(human);
   expect(journal.classifyDiagnosticError(reason)).toBe(category);
  }
  const message='Champ invalide : La date de la facture FA-500 doit être corrigée.';
  expect(classifyUserError({status,message})).toBe(human);
  expect(classifyUserError({statusCode:String(status),message})).toBe(human);
  // Diagnostics has never read status metadata. Keep that independent contract.
  expect(journal.classifyDiagnosticError({status,message})).toBe('VALIDATION');
 });

 it('keeps an explicit database code while ignoring an invoice reference',()=>{
  expect(classifyUserError({code:'23505',message:'Champ invalide : La facture FA-401 doit être corrigée.'})).toBe('conflict');
  expect(classifyUserError({status:403,message:'Enregistrement introuvable : Facture FA-401.'})).toBe('permission');
 });

 it.each([
  'La connexion ou l’entreprise ouverte a changé. Rouvrez la réception.',
  'L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.',
  'L’espace de travail a changé pendant l’actualisation des réglages enregistrés.',
 ])('keeps the authored workspace refusal: %s',async(message)=>{
  const journal=await diagnostics(),reason=`Champ invalide : ${message}`;
  for(const value of [reason,reason.replaceAll('’',"'")]){
   expect(classifyUserError(value)).toBe('workspace');
   expect(journal.classifyDiagnosticError(value)).toBe('CONFLICT');
  }
 });

 it('keeps semantic read-only and expired-session refusals',async()=>{
  const journal=await diagnostics();
  expect(classifyUserError('Champ invalide : Mode lecture seule : cette action est refusée.')).toBe('permission');
  expect(journal.classifyDiagnosticError('Champ invalide : Mode lecture seule : cette action est refusée.')).toBe('PERMISSION');
  expect(classifyUserError('Champ invalide : Votre session a expiré.')).toBe('session');
  expect(journal.classifyDiagnosticError('Champ invalide : Votre session a expiré.')).toBe('SESSION');
 });

 it('retains the original refusal and one safe incident reference',async()=>{
  const journal=await diagnostics(),reason=new Error('Champ invalide : La date de la facture FA-401 doit être corrigée. alice@example.invalid token=synthetic-private-token');
  await expect(journal.diagnosticOperation('command','test.synthetic_validation',async()=>{throw reason;})).rejects.toBe(reason);
  const events=journal.recentDiagnosticEvents();
  expect(events.map(event=>event.phase)).toEqual(['start','failure']);
  expect(events[0].id).toBe(events[1].id);
  expect(events[1].errorCode).toBe('VALIDATION');
  expect(journal.resolveErrorIncident(reason).code).toBe(`ZT-${events[1].id}`);
  expect(JSON.stringify(events)).not.toMatch(/FA-401|alice@example|synthetic-private-token|Champ invalide/);
  for(const language of ['fr','de','it','en'] as const){
   const explained=getUserError(reason,{language,operation:'read'});
   expect(explained.kind).toBe('validation');
   expect(JSON.stringify(explained)).not.toMatch(/alice@example|synthetic-private-token/);
  }
 });

 it.each(['message','prototype','coercion'] as const)('never replaces a hostile %s rejection',async(kind)=>{
  const accessError=new Error('synthetic accessor failure');
  const reason=kind==='prototype'?new Proxy(new Error(''),{getPrototypeOf(){throw accessError;}}):new Error('');
  if(kind==='message')Object.defineProperty(reason,'message',{get(){throw accessError;}});
  if(kind==='coercion')Object.defineProperty(reason,'message',{value:{[Symbol.toPrimitive](){throw accessError;}}});
  const journal=await diagnostics();
  expect(classifyUserError(reason)).toBe('unknown');
  expect(journal.classifyDiagnosticError(reason)).toBe('INTERNAL');
  await expect(journal.diagnosticOperation('command','test.synthetic_validation',async()=>{throw reason;})).rejects.toBe(reason);
  const events=journal.recentDiagnosticEvents();
  expect(events.map(event=>event.phase)).toEqual(['start','failure']);
  expect(events[1].errorCode).toBe('INTERNAL');
  expect(journal.resolveErrorIncident(reason).code).toBe(`ZT-${events[1].id}`);
 });
});
