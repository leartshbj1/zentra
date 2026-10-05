import { NextResponse } from 'next/server';
import { canonicalNavigationTarget } from './lib/canonical-navigation';
import { runtimeValue } from './lib/runtime';
import { isPrivateSearchPath } from './lib/seo-indexing';
import { pageScriptPolicy } from './lib/page-csp';
import { resolveSiteLanguage, isSiteLanguage, SITE_LANGUAGE_COOKIE, SITE_LANGUAGE_HEADER, SITE_LANGUAGE_TAGS, SITE_PATH_HEADER } from './lib/site-language';
import { siteServiceCopy } from './lib/site-service-copy';

export function middleware(request: Request) {
  const path=new URL(request.url).pathname;
  if(runtimeValue('PHASE2_RESET_MODE')==='maintenance' && !path.startsWith('/api/founder/') && (path.startsWith('/api/')||path.startsWith('/compte')||path==='/connexion')) {
    const language=resolveSiteLanguage(request),message=siteServiceCopy('maintenance',language);
    return new Response(path.startsWith('/api/')?JSON.stringify({error:message}):message,{status:503,headers:{'Content-Type':path.startsWith('/api/')?'application/json':'text/plain; charset=utf-8','Content-Language':SITE_LANGUAGE_TAGS[language],'Retry-After':'120','Cache-Control':'no-store'}});
  }
  const target = canonicalNavigationTarget(request);
  if (!target && path === '/telecharger' && ['GET', 'HEAD'].includes(request.method)) {
    const url = new URL(request.url);
    url.pathname = '/download';
    return NextResponse.redirect(url, 308);
  }
  if (!target) {
    const scriptPolicy = pageScriptPolicy(request);
    const isPage = !path.startsWith('/api/') && path !== '/api' && !path.startsWith('/_') && !/\.[a-z0-9]{1,8}$/i.test(path);
    const language = resolveSiteLanguage(request);
    const requestHeaders = new Headers(scriptPolicy?.headers || request.headers);
    requestHeaders.delete(SITE_LANGUAGE_HEADER);
    requestHeaders.delete(SITE_PATH_HEADER);
    if (isPage) {
      requestHeaders.set(SITE_LANGUAGE_HEADER, language);
      requestHeaders.set(SITE_PATH_HEADER, path);
    }
    const response = NextResponse.next({request:{headers:requestHeaders}});
    if (isPage) {
      response.headers.set('Content-Language', SITE_LANGUAGE_TAGS[language]);
      response.headers.set('Vary', 'Cookie, Accept-Language');
      response.headers.set('Cache-Control', 'private, no-store');
      const explicit = new URL(request.url).searchParams.get('lang');
      if (isSiteLanguage(explicit)) response.headers.append('Set-Cookie', `${SITE_LANGUAGE_COOKIE}=${explicit}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`);
    }
    if (scriptPolicy) {
      response.headers.set('Content-Security-Policy', scriptPolicy.policy);
      // A cached HTML document would reuse its nonce, or mismatch a fresh CSP.
      response.headers.set('Cache-Control', 'private, no-store');
    }
    if (isPrivateSearchPath(path)) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
  }
  const response = NextResponse.redirect(target, isPrivateSearchPath(path) ? 307 : 308);
  if (isPrivateSearchPath(path)) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
