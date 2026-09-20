'use client';
import { useEffect } from 'react';
import { AUTH_CHANGED_EVENT } from '@/lib/auth-browser-events';

export function AuthSessionGuard() {
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key === AUTH_CHANGED_EVENT) window.location.reload();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('storage', refresh);
    window.addEventListener('pageshow', restored);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('pageshow', restored);
    };
  }, []);
  return null;
}
