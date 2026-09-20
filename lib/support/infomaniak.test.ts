import { describe, expect, it, vi } from 'vitest';
import { listMail, mailRequest, readMail, verifyMailbox } from './infomaniak';

describe('API Infomaniak', () => {
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
