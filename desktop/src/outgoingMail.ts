import { invoke } from '@tauri-apps/api/core';

export type MailTemplate = { subject: string; body: string };
export type MailTemplates = { quotes: MailTemplate; invoices: MailTemplate };
export type MailTarget = { entity: 'quotes' | 'invoices' | 'reminders'; id: string };
export type MailConnection = { host: string; port: number; security: 'tls' | 'starttls'; username: string; fromEmail: string; fromName: string; password: string };
export type MailState = { scope: string; connection: Partial<Omit<MailConnection, 'password'>> & { connected: boolean }; templates: MailTemplates; canConfigure: boolean };
// Status returned by the native reader is not part of the strict write contract.
export function mailConnectionInput(connection: MailConnection): MailConnection {
  const { host, port, security, username, fromEmail, fromName, password } = connection;
  return { host, port, security, username, fromEmail, fromName, password };
}
export type MailPreview = { scope: string; target: MailTarget; sourceRevision: string; recipient: string; subject: string; body: string; attachmentName: string; history: Array<{ recipient: string; subject: string; status: 'pending' | 'accepted' | 'rejected' | 'uncertain'; createdAt: string }> };
export const mailVariables = [
  ['entreprise', 'Entreprise'], ['client', 'Client'], ['numero', 'N° du document'], ['montant', 'Montant total'],
  ['solde', 'Solde'], ['echeance', 'Échéance'], ['date', 'Date'], ['email_entreprise', 'E-mail de l’entreprise'], ['telephone', 'Téléphone'],
] as const;
export function mailTemplateError(template: MailTemplate): string {
  if (!template.subject.trim() || template.subject.length > 250 || /[\r\n\0]/.test(template.subject)) return 'Indiquez un objet de 1 à 250 caractères, sur une seule ligne.';
  if (!template.body.trim() || new TextEncoder().encode(template.body).length > 24000) return 'Ajoutez un message de moins de 24 000 caractères.';
  const content = `${template.subject}\n${template.body}`;
  const unknown = [...content.matchAll(/\{([^}]*)\}/g)].find(([, key]) => !mailVariables.some(([allowed]) => allowed === key));
  if (unknown) return `Variable inconnue : ${unknown[0]}. Choisissez une variable proposée.`;
  if (content.replace(/\{[^}]*\}/g, '').includes('{')) return 'Fermez chaque variable avec }, par exemple {entreprise}.';
  return '';
}
export const outgoingMail = {
  state: () => invoke<MailState>('outgoing_mail_state'),
  connect: (scope: string, connection: MailConnection) => invoke<MailState['connection']>('connect_outgoing_mail', { scope, connection: mailConnectionInput(connection) }),
  disconnect: (scope: string) => invoke<void>('disconnect_outgoing_mail', { scope }),
  saveTemplates: (scope: string, templates: MailTemplates) => invoke<void>('save_outgoing_mail_templates', { scope, templates }),
  preview: (target: MailTarget) => invoke<MailPreview>('preview_outgoing_mail', { target }),
  send: (input: { requestId: string; scope: string; target: MailTarget; sourceRevision: string; recipient: string; subject: string; body: string }) => invoke<{ status: 'accepted'; replayed: boolean; historyWarning?: boolean }>('send_outgoing_mail', { input }),
};
