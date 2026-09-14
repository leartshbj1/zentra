function safeOrigin(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('L’adresse du site doit être une origine HTTPS exacte.');
  return url.origin;
}

// Preserve the initiating host for host-only session and PKCE cookies.
// Aliases are explicitly configured; forwarded host headers are never trusted.
export function trustedSiteRequestOrigin(
  request: Request,
  canonical: string,
  aliases = '',
): string {
  const requested = new URL(request.url);
  const origin = safeOrigin(requested.origin);
  if (!canonical) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(requested.hostname)) {
      throw new Error('PUBLIC_SITE_URL est requis hors développement local.');
    }
    return origin;
  }
  const allowed = [
    canonical,
    ...aliases
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ].map(safeOrigin);
  if (!allowed.includes(origin)) throw new Error('Origine du site refusée.');
  return origin;
}
