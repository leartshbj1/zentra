import { NextResponse } from 'next/server';
import { canonicalNavigationTarget } from './lib/canonical-navigation';
import { runtimeValue } from './lib/runtime';

export function middleware(request: Request) {
  const path=new URL(request.url).pathname;
  if(runtimeValue('PHASE2_RESET_MODE')==='maintenance' && !path.startsWith('/api/founder/') && (path.startsWith('/api/')||path.startsWith('/compte')||path==='/connexion'))
    return new Response(path.startsWith('/api/')?JSON.stringify({error:'Zentra prépare le nouvel espace Phase 2. Réessayez dans quelques minutes.'}):'Zentra prépare le nouvel espace Phase 2. Réessayez dans quelques minutes.',{status:503,headers:{'Content-Type':path.startsWith('/api/')?'application/json':'text/plain; charset=utf-8','Retry-After':'120','Cache-Control':'no-store'}});
  const target = canonicalNavigationTarget(request);
  if (!target) return NextResponse.next();
  const response = NextResponse.redirect(target, 307);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
