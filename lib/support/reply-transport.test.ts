import { beforeEach, it, expect, vi } from 'vitest';
import type { Connection, SourceTicket } from './types';
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  verify: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
  request: vi.fn(),
  read: vi.fn(),
  apiVerify: vi.fn(),
  apiPrepare: vi.fn(),
  apiSubmit: vi.fn(),
}));
vi.mock('nodemailer', () => ({ createTransport: mocks.create }));
vi.mock('./connectors', () => ({
  providerRequest: mocks.request,
  readProviderTicket: mocks.read,
}));
vi.mock('@/lib/company-mail/provider', async (original) => {
  const m = await original<typeof import('@/lib/company-mail/provider')>();
  return {
    ...m,
    InfomaniakSender: class {
      verify = mocks.apiVerify;
      prepare = mocks.apiPrepare;
      submit = mocks.apiSubmit;
    },
  };
});
import { resolveReplyTarget, prepareReplyTransport } from './reply-transport';
import { encodeImapCredentials } from './infomaniak-imap';
const source = {
  externalId: '42',
  subject: 'Offre',
  body: 'Proposition',
  version: 'stamp',
  closed: false,
  groupId: null,
  agentId: null,
  mail: { sender: 'vendor@example.test', attachments: [] },
} satisfies SourceTicket;
const target = {
  recipient: 'vendor@example.test',
  from: 'team@example.test',
  name: 'Atelier',
  sourceVersion: 'stamp',
};
const c = { provider: 'infomaniak', login: 'team@example.test' } as Connection;
const message = { subject: 'Re: Offre', body: 'STOP\n<script>test</script>' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockReturnValue({
    verify: mocks.verify,
    sendMail: mocks.send,
    close: mocks.close,
  });
  mocks.verify.mockResolvedValue(true);
  mocks.send.mockResolvedValue({ accepted: ['vendor@example.test'] });
  mocks.read.mockResolvedValue(source);
});
it('utilise SMTP fixe TLS, sans pièce ni récupération de liens, après vérification', async () => {
  const secret = encodeImapCredentials({ password: 'fixture', firstUid: 1 });
  expect(await resolveReplyTarget(c, secret, source, 'Atelier')).toEqual(
    target,
  );
  const transport = await prepareReplyTransport(
    c,
    secret,
    target,
    source,
    message,
    '123',
  );
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      host: 'mail.infomaniak.com',
      port: 465,
      secure: true,
      disableUrlAccess: true,
      disableFileAccess: true,
      tls: expect.objectContaining({ rejectUnauthorized: true }),
    }),
  );
  await transport.submit();
  transport.close();
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      text: message.body,
      to: target.recipient,
      from: { address: target.from, name: 'Atelier' },
    }),
  );
  expect(mocks.close).toHaveBeenCalled();
});
it('ne soumet rien si SMTP refuse les identifiants', async () => {
  mocks.verify.mockRejectedValue(new Error('private provider text'));
  await expect(
    prepareReplyTransport(
      c,
      encodeImapCredentials({ password: 'fixture', firstUid: 1 }),
      target,
      source,
      message,
      'id',
    ),
  ).rejects.toThrow('Aucun message envoyé');
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalled();
});
it('ne transforme pas un destinataire refusé en succès', async () => {
  mocks.send.mockResolvedValue({ accepted: [] });
  const prepared = await prepareReplyTransport(
    c,
    encodeImapCredentials({ password: 'fixture', firstUid: 1 }),
    target,
    source,
    message,
    'id',
  );
  await expect(prepared.submit()).rejects.toThrow();
});
it('conserve l’identité réelle Infomaniak API et prépare sans PDF', async () => {
  mocks.apiVerify.mockResolvedValue({
    email: target.from,
    name: 'Nom réel',
    mailboxId: 'box',
    identityId: 'identity',
  });
  mocks.apiPrepare.mockResolvedValue({ uuid: 'draft', payload: {} });
  const resolved = await resolveReplyTarget(
    c,
    'token-fixture',
    source,
    'Atelier',
  );
  expect(resolved.name).toBe('Nom réel');
  const p = await prepareReplyTransport(
    c,
    'token-fixture',
    resolved,
    source,
    message,
    'id',
  );
  expect(mocks.apiPrepare).toHaveBeenCalledWith(expect.anything(), {
    recipient: target.recipient,
    ...message,
  });
  expect(mocks.apiSubmit).not.toHaveBeenCalled();
  await p.submit();
  expect(mocks.apiSubmit).toHaveBeenCalledTimes(1);
});
it('refuse un destinataire injecté dans le texte sans adresse source', async () => {
  await expect(
    resolveReplyTarget(
      c,
      encodeImapCredentials({ password: 'x', firstUid: 1 }),
      { ...source, mail: undefined },
      'Atelier',
    ),
  ).rejects.toThrow();
});
it('conserve la version Zendesk pour une réponse publique contrôlée', async () => {
  mocks.request.mockResolvedValue({ ticket: { id: 42 } });
  const p = await prepareReplyTransport(
    { ...c, provider: 'zendesk' },
    'secret',
    target,
    source,
    message,
    'id',
  );
  await p.submit();
  expect(mocks.request).toHaveBeenCalledWith(
    expect.anything(),
    'secret',
    '/api/v2/tickets/42.json',
    'PUT',
    {
      ticket: {
        comment: { body: message.body, public: true },
        safe_update: true,
        updated_stamp: 'stamp',
      },
    },
  );
});
it('encode le HTML Freshdesk et supprime les copies par défaut', async () => {
  mocks.request.mockResolvedValue({ id: 50 });
  const p = await prepareReplyTransport(
    { ...c, provider: 'freshdesk' },
    'secret',
    target,
    source,
    message,
    'id',
  );
  await p.submit();
  expect(mocks.request.mock.calls[0][4]).toEqual({
    body: '<p>STOP<br>&lt;script&gt;test&lt;/script&gt;</p>',
    to_emails: [target.recipient],
    cc_emails: [],
    bcc_emails: [],
  });
});
it('ne prétend pas réussir si le fournisseur ne confirme pas la réponse', async () => {
  mocks.request.mockResolvedValue({});
  for (const provider of ['zendesk', 'freshdesk', 'gorgias'] as const) {
    const p = await prepareReplyTransport(
      { ...c, provider },
      'secret',
      target,
      source,
      message,
      'id',
    );
    await expect(p.submit()).rejects.toThrow();
  }
});
it('refuse une adresse Gorgias ambiguë', async () => {
  mocks.request.mockResolvedValue({
    data: [
      {
        from_agent: false,
        channel: 'email',
        source: {
          from: { address: 'vendor@example.test' },
          to: [{ address: 'a@example.test' }, { address: 'b@example.test' }],
        },
      },
    ],
  });
  await expect(
    resolveReplyTarget(
      { ...c, provider: 'gorgias' },
      'secret',
      source,
      'Atelier',
    ),
  ).rejects.toThrow('adresse d’expédition');
});
it('refuse de répondre à un contenu devenu différent', async () => {
  mocks.read.mockResolvedValue({ ...source, body: 'Nouvelle demande client' });
  await expect(
    resolveReplyTarget(
      { ...c, provider: 'zendesk' },
      'secret',
      source,
      'Atelier',
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(mocks.request).not.toHaveBeenCalled();
});
