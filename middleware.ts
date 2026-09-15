import { NextResponse } from 'next/server';
import { canonicalNavigationTarget } from './lib/canonical-navigation';

export function middleware(request: Request) {
  const target = canonicalNavigationTarget(request);
  if (!target) return NextResponse.next();
  const response = NextResponse.redirect(target, 307);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
