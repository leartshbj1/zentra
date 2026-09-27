/** Vinext reads the original request before applying middleware overrides to
 * rendering. Discard visitor-supplied policy hints at the Worker boundary. */
export function withoutCallerScriptPolicy(request: Request): Request {
  const names = ['content-security-policy', 'content-security-policy-report-only', 'x-nonce'];
  if (!names.some(name => request.headers.has(name))) return request;
  const headers = new Headers(request.headers);
  for (const name of names) headers.delete(name);
  return new Request(request, { headers });
}

/** Give each HTML response its own script nonce. APIs keep their route-specific
 * policies (including sandboxed attachments and the OAuth callback).
 * Vinext forwards this nonce to its bootstrap and streamed hydration scripts. */
export function pageScriptPolicy(request: Request) {
  const path = new URL(request.url).pathname;
  if (!['GET', 'HEAD'].includes(request.method) || path === '/api' || path.startsWith('/api/')
    || request.headers.get('rsc') === '1' || !request.headers.get('accept')?.includes('text/html')) return null;

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const policy = [
    "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'",
    "form-action 'self'", "img-src 'self' data:", "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'", `script-src 'self' 'nonce-${nonce}'`,
    "script-src-attr 'none'", "connect-src 'self'", 'upgrade-insecure-requests',
  ].join('; ');
  const headers = new Headers(request.headers);
  // The caller cannot select the nonce or substitute a report-only policy.
  headers.delete('content-security-policy-report-only');
  headers.set('content-security-policy', policy);
  headers.set('x-nonce', nonce);
  return { headers, policy };
}
