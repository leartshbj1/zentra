'use client';

import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const links = [
  ['/#workflow', 'Produit'],
  ['/features', 'Fonctionnalités'],
  ['/pricing', 'Tarifs'],
  ['/security', 'Sécurité & données'],
  ['/download', 'Télécharger'],
  ['/compte', 'Mon compte'],
] as const;

export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;

    document.documentElement.classList.add('mobile-menu-open');
    const focusFrame = window.requestAnimationFrame(() => {
      navRef.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    });

    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || !navRef.current) return;
      const focusable = [
        ...navRef.current.querySelectorAll<HTMLAnchorElement>('a[href]'),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyboard);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.documentElement.classList.remove('mobile-menu-open');
      document.removeEventListener('keydown', handleKeyboard);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="site-mobile-nav relative xl:hidden"
      data-open={open}
    >
      <button
        ref={buttonRef}
        type="button"
        className="grid size-11 place-items-center rounded-full border border-[#d4d2ca] bg-white/75 text-[#294536] transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315f47] focus-visible:ring-offset-2"
        aria-label={open ? 'Fermer le menu' : 'Ouvrir le menu'}
        aria-expanded={open}
        aria-controls="zentra-mobile-navigation"
        onClick={() => setOpen((current) => !current)}
      >
        <Plus
          aria-hidden="true"
          className={`size-5 transition-transform duration-200 ${open ? 'rotate-45' : ''}`}
        />
      </button>
      <button
        type="button"
        className="site-mobile-nav__backdrop fixed inset-0 z-40 bg-[#10271b]/18 backdrop-blur-[2px]"
        aria-label="Fermer le menu"
        tabIndex={open ? 0 : -1}
        onClick={() => {
          setOpen(false);
          buttonRef.current?.focus();
        }}
      />
      <nav
        ref={navRef}
        id="zentra-mobile-navigation"
        className="fixed inset-x-4 top-[4.75rem] z-50 grid min-w-0 gap-1 rounded-2xl border border-[#d9d5ca] bg-[#fffdf9] p-2 text-sm shadow-[0_22px_55px_rgba(24,52,36,.18)] sm:left-auto sm:w-80"
        aria-label="Navigation mobile"
        aria-hidden={!open}
        inert={!open}
      >
        {links.map(([href, label]) => (
          <a
            key={href}
            href={href}
            tabIndex={open ? undefined : -1}
            onClick={() => {
              setOpen(false);
              buttonRef.current?.focus();
            }}
          >
            {label}
          </a>
        ))}
      </nav>
    </div>
  );
}
