import { describe, expect, it, vi } from 'vitest';
import { listMail, mailRequest, normalizeMailToken, readMail, verifyMailbox } from './infomaniak';

describe('API Infomaniak', () => {
  it('reprend les dossiers standards si les dossiers virtuels échouent', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/mailbox?')) return Response.json({result:'success',data:[{uuid:'my-box',email:'info@example.test'}]});
      if (String(url).includes('?with=ik-static')) return new Response('private upstream failure',{status:500});
      expect(String(url)).toBe('https://mail.infomaniak.com/api/mail/my-box/folder');
      return Response.json({result:'success',data:[{id:'real-inbox',role:'INBOX'}]});
    });
    await expect(verifyMailbox('info@example.test','token',fetcher)).resolves.toEqual({mailboxId:'my-box',folderId:'real-inbox'});
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([401,403,429,302])('ne retente pas un refus %i pour les dossiers', async status => {
    const fetcher=vi.fn(async(url:string|URL|Request)=>String(url).includes('/mailbox?')?Response.json({result:'success',data:[{uuid:'box',email:'info@example.test'}]}):new Response('',{status}));
    await expect(verifyMailbox('info@example.test','token',fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('accepte une clé copiée avec des espaces autour ou son préfixe Bearer', async () => {
    expect(normalizeMailToken('  Bearer abc.def-123  \n')).toBe('abc.def-123');
    const fetcher = vi.fn(async () => Response.json({ result: 'success', data: [] }));
    await mailRequest(' Bearer abc.def-123 ', '/mailbox', fetcher);
    expect(fetcher).toHaveBeenCalledWith('https://mail.infomaniak.com/api/mailbox', expect.objectContaining({
      headers: { Authorization: 'Bearer abc.def-123', Accept: 'application/json', 'Content-Type': 'application/json' },
      redirect: 'manual',
    }));
  });
  it.each(['', 'Bearer ', 'private token', 'token\nInjected: value', 'x'.repeat(8193)])(
    'refuse une clé mal copiée avant toute requête', async (value) => {
      const fetcher = vi.fn();
      await expect(mailRequest(value, '/mailbox', fetcher)).rejects.toMatchObject({ status: 422 });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([[401, 'expirée'], [403, 'workspace:mail']] as const)(
    'explique comment corriger le refus %i', async (status, message) => {
      await expect(mailRequest('secret', '/mailbox', async () => new Response('secret', { status })))
        .rejects.toMatchObject({ status: 422, message: expect.stringContaining(message) });
    },
  );
  it.each([301, 302, 307, 308, 401, 403, 429, 500])(
    'refuse une réponse %i sans divulguer sa réponse ni suivre une redirection',
    async (status) => {
      const fetcher = vi.fn(
        async () =>
          new Response('provider-secret', {
            status,
            headers: { Location: 'https://outside.example' },
          }),
      );
      let error: unknown;
      try {
        await mailRequest('private-token', '/mailbox', fetcher);
      } catch (e) {
        error = e;
      }
      expect(String(error)).not.toContain('provider-secret');
      expect(String(error)).not.toContain('private-token');
      expect(error).toBeInstanceOf(Error);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('refuse de sélectionner la première boîte si l’adresse demandée est absente', async () => {
    await expect(
      verifyMailbox('target@example.test', 'token', async () =>
        Response.json({
          result: 'success',
          data: [{ uuid: 'other', email: 'other@example.test' }],
        }),
      ),
    ).rejects.toThrow('Cette adresse');
  });
  it('ne traite jamais une liste invalide comme une boîte vide', async () => {
    await expect(
      listMail('token', 'box', 'inbox', 0, 1000, async () =>
        Response.json({ result: 'success', data: {} }),
      ),
    ).rejects.toThrow('illisible');
  });
  it('récupère tous les messages sans confondre un fil et un mail', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      Response.json({
        result: 'success',
        data: {
          threads: [
            {
              messages: [
                { uid: '1@inbox', date: 12345 },
                { uid: '2@inbox', date: 12346 },
              ],
            },
          ],
        },
      }),
    );
    expect(
      (await listMail('token', 'box', 'inbox', 20, 1000, fetcher)).messages.map(
        (m) => m.uid,
      ),
    ).toEqual(['1', '2']);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('thread=off');
  });
  it('garde le contenu comme texte et signale un mail sans texte', async () => {
    const mail = await readMail(
      'token',
      'box',
      'inbox',
      { uid: '1', date: 123 },
      async () =>
        Response.json({
          result: 'success',
          data: {
            subject: 'Facture',
            body: '<script>danger()</script><p>Bonjour &amp; merci</p>',
          },
        }),
    );
    expect(mail.body).toBe('Bonjour & merci');
    const empty = await readMail(
      'token',
      'box',
      'inbox',
      { uid: '2', date: 123 },
      async () =>
        Response.json({
          result: 'success',
          data: { subject: 'Document', body: '' },
        }),
    );
    expect(empty.incomplete).toBe(true);
    expect(empty.body).toBe('Document');
  });
});
