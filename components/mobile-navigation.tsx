'use client';

import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const links = [
  ['#logiciel', 'Voir le logiciel'],
  ['#lot-19', 'Nouveautés 1.9'],
  ['#capacites', 'Capacités'],
  ['#confidentialite', 'Données locales'],
  ['#tarif', 'Tarif'],
  ['mailto:leartshabija@gmail.com', 'Contact'],
] as const;

export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="site-mobile-nav relative lg:hidden"
      data-open={open}
    >
      <button
        type="button"
        className="grid size-11 place-items-center rounded-full border border-[#d4d2ca] bg-white/75 text-[#294536] transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315f47] focus-visible:ring-offset-2"
        aria-label={open ? 'Fermer le menu' : 'Ouvrir le menu'}
        aria-expanded={open}
        aria-controls="elyko-mobile-navigation"
        onClick={() => setOpen((current) => !current)}
      >
        <Plus
          aria-hidden="true"
          className={`size-5 transition-transform duration-200 ${open ? 'rotate-45' : ''}`}
        />
      </button>
      {open ? (
        <nav
          id="elyko-mobile-navigation"
          className="absolute right-0 top-[calc(100%+.65rem)] z-50 grid min-w-64 max-w-[calc(100vw-2.5rem)] gap-1 rounded-2xl border border-[#d9d5ca] bg-[#fffdf9] p-2 text-sm shadow-[0_22px_55px_rgba(24,52,36,.18)]"
          aria-label="Navigation mobile"
        >
          {links.map(([href, label]) => (
            <a key={href} href={href} onClick={() => setOpen(false)}>
              {label}
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
