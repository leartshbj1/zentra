import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailInterfaceMessage, mailTemplateError, outgoingMail } from './outgoingMail';
import { setAppLanguage } from './language';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
describe('company email templates', () => {
  afterEach(() => setAppLanguage('fr'));
  it('translates native validation messages and variable names without translating customer values', () => {
    setAppLanguage('de');
    expect(mailInterfaceMessage('Champ invalide : Saisissez de nouveau le mot de passe après un changement de serveur ou d’identifiant.')).toContain('Passwort');
    expect(mailInterfaceMessage('Variable inconnue : {custom_customer}. Choisissez une variable proposée.')).toBe('Unbekannte Variable: {custom_customer}. Wählen Sie eine der angebotenen Variablen.');
    setAppLanguage('it');
    expect(mailInterfaceMessage('Variable inconnue : {custom_customer}. Utilisez les variables proposées.')).toContain('Variabile sconosciuta: {custom_customer}');
    setAppLanguage('en');
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
