import { AccountPublicError } from '@/lib/account-security';
import type { MailLogo } from './logo';

const ORIGIN = 'https://mail.infomaniak.com/api';
const MANAGER_ORIGIN = 'https://api.infomaniak.com/1';
const MAX_RESPONSE = 1024 * 1024;
export type MailIdentity = {
  mailboxId: string;
  identityId: string;
  email: string;
  name: string;
};
export type PreparedMail = {
  recipient: string;
  subject: string;
  body: string;
  filename?: string;
  pdf?: Uint8Array;
  logo?: MailLogo;
};
export type ProviderDraft = { uuid: string; payload: Record<string, unknown> };
export class MailProviderError extends AccountPublicError {
  constructor(
    message: string,
    status: number,
    public outcome: 'rejected' | 'uncertain' = 'rejected',
  ) {
    super(message, status);
  }
}
export function emailAddress(value: unknown): string {
  if (typeof value !== 'string')
    throw new AccountPublicError('Indiquez une adresse e-mail.');
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(
      email,
    )
  )
    throw new AccountPublicError('Vérifiez l’adresse e-mail.');
  return email;
}
export function mailToken(value: unknown): string {
  if (typeof value !== 'string')
    throw new AccountPublicError('Ajoutez la clé de connexion Infomaniak.');
  const token = value.trim().replace(/^Bearer\s+/i, '');
  if (!token || token.length > 8192 || /[^\x21-\x7e]/.test(token))
    throw new AccountPublicError('Vérifiez la clé de connexion Infomaniak.');
  return token;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(value))
    throw new MailProviderError(
      'Infomaniak a renvoyé une référence illisible. Réessayez.',
      502,
    );
  return value;
}
function providerReference(value: unknown): string {
  return identifier(
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : '',
  );
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

/** Only fixed HTTPS endpoints. No redirect, provider error text, secret logging,
 * automatic send retry. Callers enforce sender ownership and explicit reply authorization. API contract:
 * https://github.com/Infomaniak/mcp-server-mail/blob/main/src/mail-client.ts */
export class InfomaniakSender {
  private token: string;
  constructor(
    token: string,
    private fetcher: typeof fetch = fetch,
  ) {
    this.token = mailToken(token);
  }
  private async request(
    path: string,
    init: RequestInit = {},
    submitting = false,
    manager = false,
  ): Promise<Record<string, unknown>> {
    const uncertain = () =>
      new MailProviderError(
        'L’envoi n’a pas de confirmation certaine. Vérifiez les messages envoyés avant de préparer un nouvel envoi.',
        503,
        'uncertain',
      );
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${this.token}`);
      headers.set('Accept', 'application/json');
      if (!headers.has('Content-Type'))
        headers.set('Content-Type', 'application/json');
      response = await this.fetcher(
        (manager ? MANAGER_ORIGIN : ORIGIN) + path,
        {
          ...init,
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
          headers,
        },
      );
    } catch {
      if (submitting) throw uncertain();
      throw new MailProviderError(
        'Infomaniak ne répond pas. Aucun envoi n’a été demandé.',
        503,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (
        submitting &&
        (response.status >= 500 ||
          response.status === 408 ||
          (response.status >= 300 && response.status < 400))
      )
        throw uncertain();
      throw new MailProviderError(
        response.status === 401 || response.status === 403
          ? 'Infomaniak refuse cet accès. Reconnectez l’adresse avec une clé autorisée à envoyer des e-mails.'
          : response.status === 429
            ? 'Infomaniak limite les envois. Réessayez plus tard.'
            : 'Infomaniak a refusé la préparation de ce message.',
        response.status === 429 ? 429 : 422,
      );
    }
    const reader = response.body?.getReader();
    try {
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > MAX_RESPONSE) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      const payload = object(JSON.parse(new TextDecoder().decode(bytes)));
      if (payload.result !== 'success') throw new Error();
      return payload;
    } catch {
      if (submitting) throw uncertain();
      throw new MailProviderError(
        'La réponse d’Infomaniak est incomplète. Aucun envoi n’a été demandé.',
        502,
      );
    } finally {
      reader?.releaseLock();
    }
  }
  async verify(email: string, name: string): Promise<MailIdentity> {
    const address = emailAddress(email);
    const result = await this.request(
      '/mailbox?with=aliases,permissions,accountId,count_users',
    );
    const boxes = Array.isArray(result.data) ? result.data.map(object) : [];
    const box = boxes.find(
      (b) => typeof b.email === 'string' && b.email.toLowerCase() === address,
    );
    if (!box)
      throw new MailProviderError(
        'Cette adresse n’est pas accessible avec cette clé Infomaniak. Utilisez l’adresse principale de la boîte.',
        422,
      );
    const hostingId = providerReference(box.hosting_id);
    const mailbox = box.mailbox;
    if (
      !/^[1-9][0-9]{0,19}$/.test(hostingId) ||
      typeof mailbox !== 'string' ||
      !mailbox ||
      mailbox.length > 254 ||
      mailbox === '.' ||
      mailbox === '..' ||
      // eslint-disable-next-line no-control-regex -- reject controls in provider path segments
      /[\x00-\x20\x7f\\/?#]/.test(mailbox)
    )
      throw new MailProviderError(
        'Les informations d’expédition sont incomplètes dans Infomaniak. Vérifiez les réglages de la boîte.',
        422,
      );
    const response = await this.request(
      `/mail_hostings/${hostingId}/mailboxes/${encodeURIComponent(mailbox)}/signatures`,
      {},
      false,
      true,
    );
    const signatures = object(response.data).signatures;
    if (!Array.isArray(signatures))
      throw new MailProviderError(
        'Infomaniak ne confirme pas l’identité d’expédition. Réessayez.',
        502,
      );
    const matches = signatures.map(object).filter(
      (s) =>
        typeof s.sender === 'string' &&
        s.sender.toLowerCase() === address &&
        typeof s.full_name === 'string' &&
        !!s.full_name.trim() &&
        s.full_name.length <= 120 &&
        // eslint-disable-next-line no-control-regex -- sender names must not inject mail headers
        !/[\x00-\x1f\x7f]/.test(s.full_name),
    );
    const identity =
      matches.find(
        (s) =>
          (s.full_name as string).trim().toLowerCase() ===
          name.trim().toLowerCase(),
      ) ||
      matches.find((s) => s.is_default === true || s.is_default === 1) ||
      matches[0];
    if (!identity)
      throw new MailProviderError(
        'Ajoutez une identité d’expédition pour cette adresse dans Infomaniak Mail → Paramètres → Signatures, puis reconnectez-la dans Zentra.',
        422,
      );
    // Infomaniak ignores from.name: only identity_id controls the actual From header.
    // Return the provider's real name instead of claiming the requested name was applied.
    return {
      mailboxId: identifier(box.uuid),
      identityId: providerReference(identity.id),
      email: address,
      name: (identity.full_name as string).trim(),
    };
  }
  async prepare(
    identity: MailIdentity,
    input: PreparedMail,
  ): Promise<ProviderDraft> {
    const base = `/mail/${identifier(identity.mailboxId)}/draft`;
    const attachments: string[] = [];
    if (input.pdf && input.filename) {
    const attachment = await this.request(base + '/attachment', {
      method: 'POST',
      body: input.pdf as BodyInit,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-ws-attachment-disposition': 'attachment',
        // Header bytes remain ASCII; the actual user-visible document number is kept in the subject.
        'x-ws-attachment-filename': input.filename,
        'x-ws-attachment-mime-type': 'application/pdf',
      },
    });
    attachments.push(identifier(object(attachment.data).uuid));
    }
    let signature = '';
    if (input.logo) {
      // Official iOS API contract: disposition=inline returns content_id.
      // https://github.com/Infomaniak/ios-kMail/blob/master/MailCore/API/MailApiFetcher/MailApiFetcher%2BCommon.swift
      const upload = await this.request(base + '/attachment', {
        method: 'POST',
        body: input.logo.bytes as BodyInit,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-ws-attachment-disposition': 'inline',
          'x-ws-attachment-filename': 'logo-entreprise.png',
          'x-ws-attachment-mime-type': 'image/png',
        },
      });
      const data = object(upload.data),
        cid = data.content_id;
      if (typeof cid !== 'string' || !/^[a-z0-9._@+-]{1,200}$/i.test(cid))
        throw new MailProviderError(
          'Infomaniak ne confirme pas le logo intégré. Aucun envoi n’a été demandé.',
          502,
        );
      attachments.push(identifier(data.uuid));
      const scale = Math.max(input.logo.width / 180, input.logo.height / 60, 1);
      signature = `<p><img src="cid:${cid}" width="${Math.max(1, Math.round(input.logo.width / scale))}" height="${Math.max(1, Math.round(input.logo.height / scale))}" alt="${escapeHtml(identity.name)}" style="display:block;border:0"></p>`;
    }
    const payload: Record<string, unknown> = {
      uuid: null,
      subject: input.subject,
      body: `<html><body><p>${escapeHtml(input.body).replace(/\r?\n/g, '<br>')}</p>${signature}</body></html>`,
      mime_type: 'text/html',
      from: { id: null, name: identity.name, email: identity.email },
      reply_to: { name: identity.name, email: identity.email },
      to: [{ name: '', email: input.recipient }],
      cc: null,
      bcc: null,
      attachments,
      action: 'save',
      delay: 0,
      identity_id: identifier(identity.identityId),
      quote: null,
      uid: null,
      resource: null,
      priority: 'normal',
      encrypted: false,
      references: '',
      in_reply_to: null,
      in_reply_to_uid: null,
      forwarded_uid: null,
      ack_request: false,
      st_uuid: null,
      encryption_password: '',
      event_poll_uuid: null,
    };
    const result = await this.request(base, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = object(result.data),
      uuid = identifier(data.uuid);
    return {
      uuid,
      payload: {
        ...payload,
        uuid,
        uid: data.uid ?? null,
        resource: `/api/mail/${identity.mailboxId}/draft/${uuid}`,
      },
    };
  }
  async submit(identity: MailIdentity, draft: ProviderDraft): Promise<void> {
    await this.request(
      `/mail/${identifier(identity.mailboxId)}/draft/${identifier(draft.uuid)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...draft.payload, action: 'send', delay: 0 }),
      },
      true,
    );
  }
}
