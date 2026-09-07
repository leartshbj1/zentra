'use client';

import { UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';

export function AccountLink({ className = '' }: { className?: string }) {
  const [authenticated, setAuthenticated] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/account/browser-session', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { authenticated?: boolean })
          : null,
      )
      .then((session) => setAuthenticated(session?.authenticated === true))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return (
    <a
      href={authenticated ? '/compte' : '/connexion'}
      className={`inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold text-[#173d2c] ${className}`}
    >
      <UserRound className="size-4 shrink-0" aria-hidden="true" />
      {authenticated ? 'Mon compte' : 'Se connecter'}
    </a>
  );
}
