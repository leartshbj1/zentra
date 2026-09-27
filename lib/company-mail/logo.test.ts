import { describe, it, expect, vi } from 'vitest';
import { mailLogo } from './logo';
import { InfomaniakSender } from './provider';

const base64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=';
const dataUrl = 'data:image/png;base64,' + base64;
const mail = {
  recipient: 'client@example.ch',
  subject: 'Facture',
  body: 'Bonjour <img src="https://external.example">',
  filename: 'Facture.pdf',
  pdf: new Uint8Array([1]),
  logo: mailLogo(dataUrl),
};
const identity = {
  mailboxId: 'mailbox-a',
  identityId: 'identity-a',
  email: 'office@example.ch',
  name: 'A & B',
};
describe('bounded company logo and documented inline provider contract', () => {
  it('reads the native PNG format while keeping a small display size', () => {
    expect(mailLogo(dataUrl)).toMatchObject({ width: 1, height: 1 });
    expect(mailLogo(undefined)).toBeUndefined();
    expect(mailLogo(null)).toBeUndefined();
  });
  it.each([
    'https://example.ch/logo.png',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png;base64,a='.repeat(4),
    'data:image/png;base64,' + base64.slice(0, -4),
    false,
  ])('rejects an unsafe or truncated logo (%s)', (value) => {
    expect(() => mailLogo(value)).toThrow('logo');
  });
  it('bounds both dimensions and bytes before any provider request', () => {
    const large = Buffer.from(base64, 'base64');
    large.writeUInt32BE(10000, 16);
    expect(() =>
      mailLogo('data:image/png;base64,' + large.toString('base64')),
    ).toThrow('logo');
    expect(() =>
      mailLogo('data:image/png;base64,' + 'A'.repeat(350000)),
    ).toThrow('logo');
  });
  it('does not accept bytes appended after the PNG end marker', () => {
    expect(() =>
      mailLogo(
        'data:image/png;base64,' +
          Buffer.concat([
            Buffer.from(base64, 'base64'),
            Buffer.from('<script>'),
          ]).toString('base64'),
      ),
    ).toThrow('logo');
  });
  it('uploads PDF and PNG separately, references the returned content ID, and never requests an external image', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const address =
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        calls.push({ url: address, init });
        return Response.json({
          result: 'success',
          data: address.endsWith('/attachment')
            ? new Headers(init?.headers).get('x-ws-attachment-disposition') ===
              'inline'
              ? { uuid: 'logo-a', content_id: 'logo-1@example.ch' }
              : { uuid: 'pdf-a' }
            : { uuid: 'draft-a', uid: 'draft-uid' },
        });
      },
    );
    const draft = await new InfomaniakSender('synthetic-only', fetcher).prepare(
      identity,
      mail,
    );
    expect(calls).toHaveLength(3);
    expect(
      calls.every((c) =>
        c.url.startsWith(
          'https://mail.infomaniak.com/api/mail/mailbox-a/draft',
        ),
      ),
    ).toBe(true);
    expect(
      new Headers(calls[1].init?.headers).get('x-ws-attachment-mime-type'),
    ).toBe('image/png');
    expect(draft.payload.attachments).toEqual(['pdf-a', 'logo-a']);
    expect(draft.payload.body).toContain('src="cid:logo-1@example.ch"');
    expect(draft.payload.body).toContain('alt="A &amp; B"');
    expect(draft.payload.body).not.toContain('<img src="https://');
    expect(draft.payload.body).not.toContain('data:image');
    expect(draft.payload.identity_id).toBe('identity-a');
    expect(draft.payload.action).toBe('save');
  });
  it.each([undefined, '" onerror="alert(1)', 'https://example.ch/logo'])(
    'does not silently omit the logo on invalid provider content ID (%s)',
    async (content_id) => {
      const fetcher = vi.fn(async () =>
        Response.json({
          result: 'success',
          data: { uuid: 'attachment-a', content_id },
        }),
      );
      await expect(
        new InfomaniakSender('synthetic-only', fetcher).prepare(identity, mail),
      ).rejects.toThrow('logo intégré');
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});
