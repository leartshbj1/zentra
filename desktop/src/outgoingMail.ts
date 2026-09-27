import { invoke } from '@tauri-apps/api/core';
import { t } from './language';

/** Native error envelopes are interface copy; customer document text is never passed here. */
export function mailInterfaceMessage(message: string): string {
  const source = message.replace(/^Champ invalide\s*:\s*/u, '').trim();
  const variable =
    /^Variable inconnue : (\{[^}]*\})\. (?:Choisissez une variable proposée|Utilisez les variables proposées)\.$/u.exec(
      source,
    );
  return variable
    ? t('Variable inconnue : {variable}. Choisissez une variable proposée.', {
        variable: variable[1],
      })
    : t(source);
}

export type MailTemplate = { subject: string; body: string };
export type MailTemplates = { quotes: MailTemplate; invoices: MailTemplate };
export type MailSignature = { includeCompanyLogo: boolean };
export type MailTarget = {
  entity: 'quotes' | 'invoices' | 'reminders';
  id: string;
};
export type MailConnection = {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  fromEmail: string;
  fromName: string;
  password: string;
};
export type MailState = {
  scope: string;
  connection: Partial<Omit<MailConnection, 'password'>> & {
    connected: boolean;
  };
  templates: MailTemplates;
  signature?: MailSignature;
  companyLogoDataUrl?: string | null;
  companyLogoError?: string | null;
  canConfigure: boolean;
};
// Status returned by the native reader is not part of the strict write contract.
export function mailConnectionInput(
  connection: MailConnection,
): MailConnection {
  const { host, port, security, username, fromEmail, fromName, password } =
    connection;
  return { host, port, security, username, fromEmail, fromName, password };
}
export type MailStatus = 'pending' | 'accepted' | 'rejected' | 'uncertain';
export type MailHistory = {
  requestId?: string;
  channel?: string;
  recipient: string;
  subject: string;
  status: MailStatus;
  createdAt: string;
};
export type MailPreview = {
  scope: string;
  target: MailTarget;
  sourceRevision: string;
  recipient: string;
  subject: string;
  body: string;
  signatureLogoDataUrl?: string | null;
  signatureLogoError?: string | null;
  attachmentName: string;
  history: MailHistory[];
};
export type SharedMailState = {
  available: boolean;
  scope: string;
  organizationId?: string;
  connection: {
    connected: boolean;
    connectionId?: string;
    fromEmail?: string;
    fromName?: string;
  };
  canConfigure?: boolean;
  canSend?: boolean;
  history: MailHistory[];
};
export type MailSubmission = {
  requestId: string;
  scope: string;
  target: MailTarget;
  sourceRevision: string;
  recipient: string;
  subject: string;
  body: string;
};
export type MailResult = {
  message?: string;
  status: MailStatus;
  replayed: boolean;
  historyWarning?: boolean;
};
export const mailVariables = [
  ['entreprise', 'Entreprise'],
  ['client', 'Client'],
  ['numero', 'N° du document'],
  ['montant', 'Montant total'],
  ['solde', 'Solde'],
  ['echeance', 'Échéance'],
  ['date', 'Date'],
  ['email_entreprise', 'E-mail de l’entreprise'],
  ['telephone', 'Téléphone'],
] as const;
export function mailTemplateError(template: MailTemplate): string {
  if (
    !template.subject.trim() ||
    template.subject.length > 250 ||
    /[\r\n\0]/.test(template.subject)
  )
    return 'Indiquez un objet de 1 à 250 caractères, sur une seule ligne.';
  if (
    !template.body.trim() ||
    new TextEncoder().encode(template.body).length > 24000
  )
    return 'Ajoutez un message de moins de 24 000 caractères.';
  const content = `${template.subject}\n${template.body}`;
  const unknown = [...content.matchAll(/\{([^}]*)\}/g)].find(
    ([, key]) => !mailVariables.some(([allowed]) => allowed === key),
  );
  if (unknown)
    return `Variable inconnue : ${unknown[0]}. Choisissez une variable proposée.`;
  if (content.replace(/\{[^}]*\}/g, '').includes('{'))
    return 'Fermez chaque variable avec }, par exemple {entreprise}.';
  return '';
}
export const outgoingMail = {
  state: () => invoke<MailState>('outgoing_mail_state'),
  connect: (scope: string, connection: MailConnection) =>
    invoke<MailState['connection']>('connect_outgoing_mail', {
      scope,
      connection: mailConnectionInput(connection),
    }),
  disconnect: (scope: string) =>
    invoke<void>('disconnect_outgoing_mail', { scope }),
  saveTemplates: (
    scope: string,
    templates: MailTemplates,
    signature?: MailSignature,
  ) =>
    invoke<void>('save_outgoing_mail_templates', {
      scope,
      templates,
      ...(signature ? { signature } : {}),
    }),
  preview: (target: MailTarget) =>
    invoke<MailPreview>('preview_outgoing_mail', { target }),
  send: (input: MailSubmission) =>
    invoke<MailResult>('send_outgoing_mail', { input }),
  sharedState: (scope: string, target?: MailTarget) =>
    invoke<SharedMailState>('shared_mail_state', {
      scope,
      target: target ?? null,
    }),
  connectShared: (
    scope: string,
    connection: { token: string; fromEmail: string; fromName: string },
  ) =>
    invoke<SharedMailState>('connect_shared_mail', {
      scope,
      connection: {
        token: connection.token,
        fromEmail: connection.fromEmail,
        fromName: connection.fromName,
      },
    }),
  disconnectShared: (scope: string) =>
    invoke<void>('disconnect_shared_mail', { scope }),
  sendShared: (input: MailSubmission, connectionId: string) =>
    invoke<MailResult>('send_shared_mail', { input, connectionId }),
  recoverShared: (scope: string, requestId: string) =>
    invoke<MailResult>('recover_shared_mail', { scope, requestId }),
};

