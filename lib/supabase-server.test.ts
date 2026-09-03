import { describe, expect, it, vi } from 'vitest';
import {
  createSupabaseServerClient,
  SupabaseServerError,
  validateSupabaseServerConfiguration,
} from './supabase-server';

const serverSecret = `sb_secret_${'a'.repeat(32)}`;
type TestFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

describe('SupabaseServerClient', () => {
  it('rejects publishable keys and unsafe origins', () => {
    expect(() =>
      validateSupabaseServerConfiguration({
        url: 'https://example.supabase.co',
        secretKey: `sb_publishable_${'a'.repeat(32)}`,
      }),
    ).toThrow('server secret');
    expect(() =>
      validateSupabaseServerConfiguration({
        url: 'https://example.supabase.co/rest/v1',
        secretKey: serverSecret,
      }),
    ).toThrow('HTTPS origin');
  });

  it('sends the secret only in headers and uses the public schema', async () => {
    const fetcher = vi.fn<TestFetch>(async () =>
      Response.json([{ subscription_id: 'sub_1' }]),
    );
    const client = createSupabaseServerClient(
      { url: 'https://example.supabase.co', secretKey: serverSecret },
      fetcher,
    );
    await expect(
      client.select('subscriptions', {
        select: 'subscription_id',
        subscription_id: 'eq.sub_1',
      }),
    ).resolves.toEqual([{ subscription_id: 'sub_1' }]);

    const [url, init] = fetcher.mock.calls[0]!;
    const requestedUrl =
      typeof url === 'string'
        ? url
        : url instanceof URL
          ? url.href
          : url.url;
    expect(requestedUrl).toBe(
      'https://example.supabase.co/rest/v1/subscriptions?select=subscription_id&subscription_id=eq.sub_1',
    );
    expect(requestedUrl).not.toContain(serverSecret);
    expect(new Headers(init?.headers).get('apikey')).toBe(serverSecret);
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      `Bearer ${serverSecret}`,
    );
    expect(new Headers(init?.headers).get('Accept-Profile')).toBe('public');
  });

  it('requires filters for update and delete operations', async () => {
    const fetcher = vi.fn<TestFetch>();
    const client = createSupabaseServerClient(
      { url: 'https://example.supabase.co', secretKey: serverSecret },
      fetcher,
    );
    await expect(
      client.update('subscriptions', { status: 'active' }, {}),
    ).rejects.toThrow('filtered update');
    await expect(client.delete('subscriptions', {})).rejects.toThrow(
      'filtered delete',
    );
    await expect(
      client.update(
        'subscriptions',
        { status: 'active' },
        { query: { select: 'subscription_id', limit: 1 } },
      ),
    ).rejects.toThrow('filtered update');
  });

  it('accepts an empty successful body for return=minimal mutations', async () => {
    const fetcher = vi.fn<TestFetch>(async () =>
      new Response(null, { status: 201 }),
    );
    const client = createSupabaseServerClient(
      { url: 'https://example.supabase.co', secretKey: serverSecret },
      fetcher,
    );
    await expect(
      client.insert(
        'checkout_attempts',
        { claim_hash: '\\x00' },
        { returning: false },
      ),
    ).resolves.toEqual([]);
  });

  it('does not expose a secret or a database error body', async () => {
    const fetcher = vi.fn<TestFetch>(async () =>
      Response.json(
        { code: '23505', message: `duplicate ${serverSecret}` },
        { status: 409 },
      ),
    );
    const client = createSupabaseServerClient(
      { url: 'https://example.supabase.co', secretKey: serverSecret },
      fetcher,
    );
    const error = await client
      .insert('subscriptions', { subscription_id: 'sub_1' })
      .catch((reason) => reason);
    expect(error).toBeInstanceOf(SupabaseServerError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('23505');
    expect(error.message).not.toContain(serverSecret);
  });

  it('validates relation and conflict identifiers before network access', async () => {
    const fetcher = vi.fn<TestFetch>();
    const client = createSupabaseServerClient(
      { url: 'https://example.supabase.co', secretKey: serverSecret },
      fetcher,
    );
    await expect(client.select('../auth/users')).rejects.toThrow(
      'relation name',
    );
    await expect(
      client.upsert('subscriptions', {}, { onConflict: 'id);drop table' }),
    ).rejects.toThrow('conflict target');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
