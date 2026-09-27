import { isPrivateSearchPath } from './seo-indexing';

/** Observe stricter script execution on uncached private HTML first. API, RSC,
 * assets and public landing pages retain their current delivery behavior. */
export function privatePageCspObservation(request: Request) {
  const path = new URL(request.url).pathname;
  if (!['GET', 'HEAD'].includes(request.method) || !isPrivateSearchPath(path)
    || path === '/api' || path.startsWith('/api/') || request.headers.get('rsc') === '1'
    || !request.headers.get('accept')?.includes('text/html')) return null;
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const policy = `script-src 'self' 'nonce-${nonce}'; object-src 'none'; base-uri 'self'`;
  const headers = new Headers(request.headers);
  // Never use a nonce supplied by the caller. Vinext reads the nonce from CSP.
  headers.delete('content-security-policy');
  headers.set('content-security-policy-report-only', policy);
  headers.set('x-nonce', nonce);
  return { headers, policy };
}
