import { createTransport } from 'nodemailer';
import { InfomaniakSender, emailAddress } from '@/lib/company-mail/provider';
import { decodeImapCredentials } from './infomaniak-imap';
import { providerRequest, readProviderTicket } from './connectors';
import {
  record,
  numericId,
  SupportError,
  type Connection,
  type SourceTicket,
} from './types';

export type ReplyTarget = {
  recipient: string;
  from: string;
  name: string;
  sourceVersion: string;
};
export type ReplyMessage = { subject: string; body: string };
const html = (s: string) =>
  '<p>' +
  s
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c]!,
    )
    .replace(/\r?\n/g, '<br>') +
  '</p>';

// Resolve addresses from the trusted provider envelope, never the body or a browser-supplied recipient.
export async function resolveReplyTarget(
  c: Connection,
  secret: string,
  source: SourceTicket,
  company: string,
): Promise<ReplyTarget> {
  if (c.provider === 'infomaniak') {
    const from = emailAddress(c.login),
      identity = decodeImapCredentials(secret)
        ? null
        : await new InfomaniakSender(secret).verify(from, company);
    return {
      recipient: emailAddress(source.mail?.sender),
      from,
      name: identity?.name || company,
      sourceVersion: source.version,
    };
  }
  if (c.provider === 'api')
    throw new SupportError(
      'Ce connecteur reçoit les tickets mais ne permet pas encore de répondre. Copiez le texte dans votre messagerie.',
      422,
    );
  const fresh = await readProviderTicket(c, secret, source.externalId);
  if (
    fresh.subject !== source.subject ||
    fresh.body !== source.body ||
    fresh.closed
  )
    throw new SupportError(
      'Ce message a changé ou a été fermé. Actualisez-le avant de répondre.',
      409,
    );
  const id = numericId(source.externalId);
  if (c.provider === 'zendesk') {
    const data = record(
      await providerRequest(c, secret, `/api/v2/tickets/${id}.json`),
    );
    const t = record(data.ticket);
    const user = record(
      await providerRequest(
        c,
        secret,
        `/api/v2/users/${numericId(t.requester_id)}.json`,
      ),
    );
    return {
      recipient: emailAddress(record(user.user).email),
      from: 'Zendesk',
      name: company,
      sourceVersion: fresh.version,
    };
  }
  if (c.provider === 'freshdesk') {
    const t = record(
      await providerRequest(
        c,
        secret,
        `/api/v2/tickets/${id}?include=requester`,
      ),
    );
    return {
      recipient: emailAddress(record(t.requester).email),
      from: 'Freshdesk',
      name: company,
      sourceVersion: fresh.version,
    };
  }
  const messages = record(
    await providerRequest(
      c,
      secret,
      `/api/messages?ticket_id=${id}&limit=100&order_by=created_datetime:desc`,
    ),
  );
  const incoming = Array.isArray(messages.data)
    ? messages.data
        .map(record)
        .find((m) => m.from_agent === false && m.channel === 'email')
    : null;
  if (!incoming)
    throw new SupportError(
      'Ce ticket ne contient pas de message e-mail auquel répondre. Ouvrez-le dans Gorgias.',
      422,
    );
  const envelope = record(incoming.source),
    to = Array.isArray(envelope.to) ? envelope.to : [];
  // Multiple original recipients are ambiguous: never choose an arbitrary sender identity.
  if (to.length !== 1)
    throw new SupportError(
      'Choisissez l’adresse d’expédition directement dans Gorgias pour ce message.',
      422,
    );
  return {
    recipient: emailAddress(record(envelope.from).address),
    from: emailAddress(record(to[0]).address),
    name: company,
    sourceVersion: fresh.version,
  };
}

// Preparation is reversible. The returned submit callback is invoked once, after a durable send claim.
export async function prepareReplyTransport(
  c: Connection,
  secret: string,
  target: ReplyTarget,
  source: SourceTicket,
  message: ReplyMessage,
  requestId: string,
) {
  if (c.provider === 'infomaniak') {
    const imap = decodeImapCredentials(secret);
    if (imap) {
      const smtp = createTransport({
        host: 'mail.infomaniak.com',
        port: 465,
        secure: true,
        auth: { user: target.from, pass: imap.password },
        tls: {
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          servername: 'mail.infomaniak.com',
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      });
      try {
        await smtp.verify();
      } catch {
        smtp.close();
        throw new SupportError(
          'Infomaniak refuse l’envoi. Vérifiez les identifiants de la boîte dans Connexions. Aucun message envoyé.',
          422,
        );
      }
      return {
        close: () => smtp.close(),
        submit: async () => {
          const result = await smtp.sendMail({
            from: { address: target.from, name: target.name },
            to: target.recipient,
            subject: message.subject,
            text: message.body,
            messageId: `<${requestId}@${target.from.split('@')[1]}>`,
            disableFileAccess: true,
            disableUrlAccess: true,
          });
          if (
            !result.accepted
              .map(String)
              .some((v) => v.toLowerCase() === target.recipient)
          )
            throw new Error('No acceptance');
        },
      };
    }
    const sender = new InfomaniakSender(secret),
      identity = await sender.verify(target.from, target.name);
    const draft = await sender.prepare(identity, {
      recipient: target.recipient,
      ...message,
    });
    return { close: () => {}, submit: () => sender.submit(identity, draft) };
  }
  const id = numericId(source.externalId);
  if (c.provider === 'zendesk')
    return {
      close: () => {},
      submit: async () => {
        const result = record(
          await providerRequest(
            c,
            secret,
            `/api/v2/tickets/${id}.json`,
            'PUT',
            {
              ticket: {
                comment: { body: message.body, public: true },
                safe_update: true,
                updated_stamp: target.sourceVersion,
              },
            },
          ),
        );
        if (String(record(result.ticket).id) !== id)
          throw new Error('Reply not confirmed');
      },
    };
  if (c.provider === 'freshdesk')
    return {
      close: () => {},
      submit: async () => {
        const result = record(
          await providerRequest(
            c,
            secret,
            `/api/v2/tickets/${id}/reply`,
            'POST',
            {
              body: html(message.body),
              to_emails: [target.recipient],
              cc_emails: [],
              bcc_emails: [],
            },
          ),
        );
        numericId(result.id);
      },
    };
  if (c.provider === 'gorgias')
    return {
      close: () => {},
      submit: async () => {
        const result = record(
          await providerRequest(
            c,
            secret,
            `/api/tickets/${id}/messages`,
            'POST',
            {
              channel: 'email',
              via: 'api',
              from_agent: true,
              sender: { email: emailAddress(c.login) },
              receiver: { email: target.recipient },
              source: {
                from: { address: target.from },
                to: [{ address: target.recipient }],
              },
              subject: message.subject,
              body_text: message.body,
              body_html: html(message.body),
            },
          ),
        );
        numericId(result.id);
      },
    };
  throw new SupportError('Répondez à ce message depuis votre outil.', 422);
}
