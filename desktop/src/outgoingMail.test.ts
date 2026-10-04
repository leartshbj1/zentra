import './languageTestPacks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailInterfaceMessage, mailTemplateError, outgoingMail } from './outgoingMail';
import { setAppLanguage } from './language';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
describe('company email templates', () => {
  it('uses the explicit shared sender revision and keeps status recovery separate from sending', async () => {
    const input = { requestId: 'request-a', scope: 'company-a', target: { entity: 'invoices' as const, id: 'invoice-a' }, sourceRevision: 'revision-1', recipient: 'client@example.com', subject: 'Facture', body: 'Bonjour' };
    await outgoingMail.sendShared(input, 'connection-revision-a');
    expect(invoke).toHaveBeenLastCalledWith('send_shared_mail', { input, connectionId: 'connection-revision-a' });
    await outgoingMail.recoverShared('company-a', 'request-a');
    expect(invoke).toHaveBeenLastCalledWith('recover_shared_mail', { scope: 'company-a', requestId: 'request-a' });
    const connection={token:'SYNTHETIC',fromEmail:'office@example.com',fromName:'Company',connected:true,password:'NOT-TO-BE-SENT'};
    await outgoingMail.connectShared('company-a',connection);
    expect(invoke).toHaveBeenLastCalledWith('connect_shared_mail',{scope:'company-a',connection:{token:'SYNTHETIC',fromEmail:'office@example.com',fromName:'Company'}});
  });
  it.each(['de','it','en'] as const)('translates shared mail guidance in %s', async language => {
    await setAppLanguage(language);
    for(const message of ['Vérifier l’état de l’envoi','L’adresse d’envoi a changé. Rouvrez l’e-mail pour vérifier l’expéditeur.','Connectez votre compte dans Paramètres → Compte et choisissez l’entreprise pour partager une adresse d’envoi.'])expect(mailInterfaceMessage(message)).not.toBe(message);
  });
  afterEach(async () => await setAppLanguage('fr'));
  it('translates native validation messages and variable names without translating customer values', async () => {
    await setAppLanguage('de');
    expect(mailInterfaceMessage('Champ invalide : Saisissez de nouveau le mot de passe après un changement de serveur ou d’identifiant.')).toContain('Passwort');
    expect(mailInterfaceMessage('Variable inconnue : {custom_customer}. Choisissez une variable proposée.')).toBe('Unbekannte Variable: {custom_customer}. Wählen Sie eine der angebotenen Variablen.');
    await setAppLanguage('it');
    expect(mailInterfaceMessage('Variable inconnue : {custom_customer}. Utilisez les variables proposées.')).toContain('Variabile sconosciuta: {custom_customer}');
    await setAppLanguage('en');
    expect(mailInterfaceMessage('Champ invalide : Fermez chaque variable avec }, par exemple {entreprise}.')).toBe('Close each variable with }, for example {entreprise}.');
    expect(mailTemplateError({subject:'Dear {client}, from {entreprise}',body:'Guten Tag\nBuongiorno\nBonjour'})).toBe('');
  });
  it('saves company-wide signature preferences separately from strict legacy templates', async () => {
    const templates = { quotes: { subject: 'Devis', body: 'Bonjour' }, invoices: { subject: 'Facture', body: 'Bonjour' } };
    await outgoingMail.saveTemplates('company-a', templates, { includeCompanyLogo: true });
    expect(invoke).toHaveBeenLastCalledWith('save_outgoing_mail_templates', { scope: 'company-a', templates, signature: { includeCompanyLogo: true } });
    await outgoingMail.saveTemplates('company-a', templates);
    expect(invoke).toHaveBeenLastCalledWith('save_outgoing_mail_templates', { scope: 'company-a', templates });
  });
  it('keeps multiline professional copy and supported company variables', () => {
    expect(mailTemplateError({ subject: 'Facture {numero} — {entreprise}', body: 'Bonjour {client},\n\nTotal {montant}. Échéance : {echeance}.\n{telephone}' })).toBe('');
  });
  it('rejects unknown and unclosed variables and header injection', () => {
    for (const subject of ['{client_name}', '{entreprise', 'Sujet\r\nBcc: attacker@example.com', '']) expect(mailTemplateError({ subject, body: 'Bonjour' })).not.toBe('');
    expect(mailTemplateError({ subject: 'Facture', body: ' ' })).not.toBe('');
  });
  it('uses the same immutable attempt ID and company revision when invoking the native sender', async () => {
    const input = { requestId: 'test-request', scope: 'company-a', target: { entity: 'invoices' as const, id: 'invoice-a' }, sourceRevision: 'revision-1', recipient: 'client@example.com', subject: 'Facture', body: 'Bonjour\nMerci' };
    await outgoingMail.send(input);
    expect(invoke).toHaveBeenLastCalledWith('send_outgoing_mail', { input });
  });
  it('stores secrets only through the dedicated native connection command', async () => {
    const connection = { host: 'mail.infomaniak.com', port: 465, security: 'tls' as const, username: 'example@example.com', fromEmail: 'example@example.com', fromName: 'Entreprise', password: 'FAKE-TEST-PASSWORD' };
    await outgoingMail.connect('company-a', connection);
    expect(invoke).toHaveBeenLastCalledWith('connect_outgoing_mail', { scope: 'company-a', connection });
  });
  it.each([false, true])('excludes read-only connection metadata from native arguments (connected=%s)', async connected => {
    const writable = { host: 'mail.infomaniak.com', port: 465, security: 'tls' as const, username: 'example@example.com', fromEmail: 'example@example.com', fromName: 'Entreprise', password: connected ? '' : 'FAKE-TEST-PASSWORD' };
    const draft = { ...writable, connected, hasPassword: connected, lastCheckedAt: '2026-09-26' };
    await outgoingMail.connect('company-a', draft);
    expect(invoke).toHaveBeenLastCalledWith('connect_outgoing_mail', { scope: 'company-a', connection: writable });
    expect(draft.connected).toBe(connected);
  });
});


import { recentDiagnosticEvents } from './diagnostics';
import type { MailResult, MailStatus } from './outgoingMail';
const mailLogIds = () => new Set(recentDiagnosticEvents().map(event => event.id));
const newMailEvents = (before: Set<string>) => recentDiagnosticEvents().filter(event => !before.has(event.id));
const privateMailInput={requestId:'PRIVATE_REQUEST_ID',scope:'PRIVATE_COMPANY_SCOPE',target:{entity:'invoices' as const,id:'PRIVATE_DOCUMENT_ID'},sourceRevision:'PRIVATE_REVISION',recipient:'private-synthetic@example.invalid',subject:'PRIVATE_SUBJECT',body:'PRIVATE_BODY token=PRIVATE_TOKEN amount=108.10'};
function sharedWorkflow(kind:'send'|'recover') { return kind==='send' ? outgoingMail.sendShared(privateMailInput,'PRIVATE_CONNECTION_ID') : outgoingMail.recoverShared(privateMailInput.scope,privateMailInput.requestId); }
describe('shared mail business diagnostics without replay or private content',()=>{
  for(const kind of ['send','recover'] as const) for(const status of ['pending','accepted','rejected','uncertain'] as const) it(`${kind} returns the exact ${status} result and distinguishes its state from IPC success`,async()=>{
    const result:MailResult=Object.freeze({status,replayed:kind==='recover',historyWarning:true,message:'PRIVATE_SERVER_MESSAGE'}), before=mailLogIds(), calls=invoke.mock.calls.length;
    invoke.mockResolvedValueOnce(result); expect(await sharedWorkflow(kind)).toBe(result);
    expect(invoke.mock.calls.slice(calls)).toEqual(kind==='send' ? [['send_shared_mail',{input:privateMailInput,connectionId:'PRIVATE_CONNECTION_ID'}]] : [['recover_shared_mail',{scope:privateMailInput.scope,requestId:privateMailInput.requestId}]]);
    const events=newMailEvents(before), command=kind==='send'?'send_shared_mail':'recover_shared_mail';
    expect(events.map(event=>[event.operation,event.phase])).toEqual([[command,'start'],[command,'success'],[`mail.shared.${status}`,'info']]);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|private-synthetic|108\.10/);
  });
  it.each(['send','recover'] as const)('preserves the original %s failure with no result trace, retry or fallback',async kind=>{
    const original=Error('PRIVATE native refusal recipient=private-synthetic@example.invalid'),before=mailLogIds(),calls=invoke.mock.calls.length;
    invoke.mockRejectedValueOnce(original); await expect(sharedWorkflow(kind)).rejects.toBe(original);
    expect(invoke.mock.calls.slice(calls)).toHaveLength(1); const command=kind==='send'?'send_shared_mail':'recover_shared_mail';
    expect(newMailEvents(before).map(event=>[event.operation,event.phase])).toEqual([[command,'start'],[command,'failure']]);
    expect(JSON.stringify(newMailEvents(before))).not.toMatch(/PRIVATE|private-synthetic/);
  });
  it('ignores an inherited status instead of reading its prototype',async()=>{
    const result=Object.create({status:'accepted'}) as MailResult,before=mailLogIds(); invoke.mockResolvedValueOnce(result);
    expect(await sharedWorkflow('send')).toBe(result); expect(newMailEvents(before).map(event=>event.operation)).toEqual(['send_shared_mail','send_shared_mail']);
  });
  it('never executes a status getter or changes its authentic result',async()=>{
    const result={replayed:false} as MailResult, getter=vi.fn(()=>{throw Error('PRIVATE getter');}),before=mailLogIds();Object.defineProperty(result,'status',{get:getter});invoke.mockResolvedValueOnce(result);
    expect(await sharedWorkflow('send')).toBe(result);expect(getter).not.toHaveBeenCalled();expect(newMailEvents(before).map(event=>event.operation)).toEqual(['send_shared_mail','send_shared_mail']);
  });
  it('keeps a proxy result when own-descriptor inspection throws and never reads its prototype',async()=>{
    const descriptor=vi.fn(()=>{throw Error('PRIVATE descriptor trap');}),prototype=vi.fn(()=>{throw Error('PRIVATE prototype trap');}),result=new Proxy({status:'accepted' as const,replayed:false},{getOwnPropertyDescriptor:descriptor,getPrototypeOf:prototype}),before=mailLogIds();invoke.mockResolvedValueOnce(result);
    expect(await sharedWorkflow('send')).toBe(result);expect(descriptor).toHaveBeenCalledTimes(1);expect(prototype).not.toHaveBeenCalled();expect(newMailEvents(before).map(event=>event.operation)).toEqual(['send_shared_mail','send_shared_mail']);
  });
  it('refuses arbitrary status text as an operation name',async()=>{
    const result={status:'PRIVATE_TOKEN.private-synthetic@example.invalid',replayed:false} as unknown as MailResult,before=mailLogIds();invoke.mockResolvedValueOnce(result);
    expect(await sharedWorkflow('recover')).toBe(result);expect(newMailEvents(before).map(event=>event.operation)).toEqual(['recover_shared_mail','recover_shared_mail']);expect(JSON.stringify(newMailEvents(before))).not.toContain('PRIVATE_TOKEN');
  });
  it('leaves the legacy direct sender unchanged and does not add a shared-mail state',async()=>{
    const result:MailResult={status:'accepted',replayed:false},before=mailLogIds(),calls=invoke.mock.calls.length;invoke.mockResolvedValueOnce(result);
    expect(await outgoingMail.send(privateMailInput)).toBe(result);expect(invoke.mock.calls.slice(calls)).toEqual([['send_outgoing_mail',{input:privateMailInput}]]);expect(newMailEvents(before).map(event=>event.operation)).toEqual(['send_outgoing_mail','send_outgoing_mail']);
  });
});
