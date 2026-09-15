const CANONICAL_ORIGIN = 'https://zentraapp.ch';
const FORMER_HOST = 'elyko.alb-leart1.chatgpt.site';

/** Redirect human navigation, without forwarding API credentials across hosts. */
export function canonicalNavigationTarget(request: Request): string | null {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const url = new URL(request.url);
  if (![FORMER_HOST, 'www.zentraapp.ch'].includes(url.hostname)) return null;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_next/') || url.pathname.startsWith('/assets/')) return null;
  // Links already sent need their original host-only PKCE cookies to finish.
  if (url.pathname === '/mot-de-passe/nouveau' ||
      (url.pathname === '/connexion' && (url.searchParams.has('code') || url.searchParams.has('error')))) return null;
  const target = new URL(CANONICAL_ORIGIN);
  target.pathname = url.pathname;
  target.search = url.search;
  return target.toString();
}
