import { describe, expect, it, vi } from 'vitest';
import { loadAuthFormSession } from './auth-form-session';

describe('sign-in page restored in another tab', () => {
  it('preserves a new login when old switch-account tabs reopen', async () => {
    let authenticated = false;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'GET') authenticated = false;
      return Response.json({ authenticated, ...(authenticated ? {user:{email:'owner@example.test'}} : {}) });
    });
    const signal = new AbortController().signal;
    expect((await loadAuthFormSession(signal, fetcher)).authenticated).toBe(false);
    authenticated = true; // Explicit successful sign-in in the other tab.
    for (let tab = 0; tab < 4; tab++) {
      expect(await loadAuthFormSession(signal, fetcher)).toEqual({authenticated:true,user:{email:'owner@example.test'}});
    }
    expect(fetcher.mock.calls.every(([url, init]) => url === '/api/auth/session' && init?.method === 'GET')).toBe(true);
  });
  it('reports service errors without silently signing out', async () => {
    const fetcher = vi.fn(async () => new Response('', {status:503}));
    await expect(loadAuthFormSession(new AbortController().signal, fetcher)).rejects.toThrow('session');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
