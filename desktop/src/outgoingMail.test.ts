import { describe, expect, it, vi } from 'vitest';
import { mailTemplateError, outgoingMail } from './outgoingMail';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
describe('company email templates', () => {
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
});
