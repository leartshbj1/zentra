'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { BrandWordmark } from '@/components/brand-mark';
import { supportNavigation } from '@/lib/support/marketing';

export function SupportMarketingHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    const onOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
    };
  }, [open]);

  return (
    <>
      <nav className="sp-product-bar" aria-label="Produits Zentra">
        <a href="/produits">Les produits Zentra</a>
        <div>
          <a href="/">Gestion</a>
          <a href="/support" aria-current="true">
            Support
          </a>
        </div>
      </nav>
      <header className="sp-header" ref={root}>
        <a
          href="/support"
          className="sp-brand"
          aria-label="Zentra Support, accueil"
        >
          <BrandWordmark />
          <span>Support</span>
        </a>
        <nav className="sp-desktop-navigation" aria-label="Zentra Support">
          {supportNavigation.map(([href, label]) => (
            <a
              key={href}
              href={href}
              aria-current={pathname === href ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="sp-header-actions">
          <a className="sp-header-account" href="/support/espace">
            Mon espace <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <button
            className="sp-menu-toggle"
            type="button"
            ref={toggle}
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="support-mobile-navigation"
            aria-label={
              open
                ? 'Fermer le menu Zentra Support'
                : 'Ouvrir le menu Zentra Support'
            }
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        <nav
          id="support-mobile-navigation"
          className="sp-mobile-navigation"
          aria-label="Zentra Support sur mobile"
          hidden={!open}
        >
          <a
            href="/support"
            aria-current={pathname === '/support' ? 'page' : undefined}
            onClick={() => setOpen(false)}
          >
            Présentation
          </a>
          {supportNavigation.map(([href, label]) => (
            <a
              key={href}
              href={href}
              aria-current={pathname === href ? 'page' : undefined}
              onClick={() => setOpen(false)}
            >
              {label}
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          ))}
          <a href="/support/demo" onClick={() => setOpen(false)}>
            Voir la démo
          </a>
        </nav>
      </header>
    </>
  );
}
