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
