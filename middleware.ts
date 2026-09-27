import { NextResponse } from 'next/server';
import { canonicalNavigationTarget } from './lib/canonical-navigation';
import { runtimeValue } from './lib/runtime';
import { isPrivateSearchPath } from './lib/seo-indexing';
import { privatePageCspObservation } from './lib/csp-observation';

export function middleware(request: Request) {
  const path=new URL(request.url).pathname;
  if(runtimeValue('PHASE2_RESET_MODE')==='maintenance' && !path.startsWith('/api/founder/') && (path.startsWith('/api/')||path.startsWith('/compte')||path==='/connexion'))
    return new Response(path.startsWith('/api/')?JSON.stringify({error:'Zentra prépare le nouvel espace Phase 2. Réessayez dans quelques minutes.'}):'Zentra prépare le nouvel espace Phase 2. Réessayez dans quelques minutes.',{status:503,headers:{'Content-Type':path.startsWith('/api/')?'application/json':'text/plain; charset=utf-8','Retry-After':'120','Cache-Control':'no-store'}});
  const target = canonicalNavigationTarget(request);
  if (!target && path === '/telecharger' && ['GET', 'HEAD'].includes(request.method)) {
    const url = new URL(request.url);
    url.pathname = '/download';
    return NextResponse.redirect(url, 308);
  }
  if (!target) {
    const observation = privatePageCspObservation(request);
    const response = observation ? NextResponse.next({request:{headers:observation.headers}}) : NextResponse.next();
    if (observation) {
      response.headers.set('Content-Security-Policy-Report-Only', observation.policy);
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
