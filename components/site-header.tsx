'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { BrandWordmark } from './brand-mark';
import { AccountLink } from './account-link';

const products = [
  { name: 'Gestion', href: '/gestion', key: 'gestion' },
  { name: 'Support', href: '/support', key: 'support' },
  { name: 'Automation', href: '/automation', key: 'automation' },
] as const;
const productMenus = {
  gestion: {
    name: 'Zentra Gestion',
    href: '/gestion',
    action: ['Voir la démo', '/demo-facture'],
    links: [
      ['Présentation', '/gestion'],
      ['Fonctionnalités', '/features'],
      ['Tarifs', '/pricing'],
      ['Sécurité', '/security'],
      ['Télécharger', '/download'],
    ],
  },
  support: {
    name: 'Zentra Support',
    href: '/support',
    action: ['Mon espace', '/support/espace'],
    links: [
      ['Présentation', '/support'],
      ['Fonctionnalités', '/support/fonctionnalites'],
      ['Cas d’usage', '/support/solutions'],
      ['Connexions', '/support/connexions'],
      ['Tarifs', '/support/tarifs'],
      ['Sécurité', '/support/securite'],
      ['Démo', '/support/demo'],
    ],
  },
  automation: {
    name: 'Zentra Automation',
    href: '/automation',
    action: ['Configurer', '/compte/automation'],
    links: [
      ['Présentation', '/automation'],
      ['Utilisation', '/automation#utilisation'],
      ['Tarif', '/automation#tarif'],
      ['Mes réglages', '/compte/automation'],
    ],
  },
} as const;

export function SiteHeader() {
  const pathname = usePathname() ?? '/';
  const product = pathname.startsWith('/support')
    ? 'support'
    : pathname.includes('/automation')
      ? 'automation'
      : [
            '/gestion',
            '/features',
            '/pricing',
            '/download',
            '/telecharger',
            '/demo-facture',
            '/security',
          ].some((path) => pathname === path || pathname.startsWith(path + '/'))
        ? 'gestion'
        : null;
  const menu = product ? productMenus[product] : null;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname) setOpen(false);
    previousPath.current = pathname;
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  return (
    <header className="catalog-header" ref={root}>
      <div className="catalog-global">
        <a
          className="catalog-brand"
          href="/"
          aria-label="Zentra, tous les produits"
        >
          <BrandWordmark />
        </a>
        <nav className="catalog-products" aria-label="Les produits Zentra">
          {products.map((item) => (
            <a
              key={item.key}
              href={item.href}
              aria-current={product === item.key ? 'true' : undefined}
            >
              {item.name}
            </a>
          ))}
        </nav>
        <AccountLink className="catalog-account" />
      </div>
      {menu && (
        <div className="catalog-local">
          <div className="catalog-local-row">
            <a className="catalog-product-title" href={menu.href}>
              {menu.name}
            </a>
            <nav
              className="catalog-desktop-links"
              aria-label={'Explorer ' + menu.name}
            >
              {menu.links.map(([label, href]) => (
                <a
                  key={href}
                  href={href}
                  aria-current={pathname === href ? 'page' : undefined}
                >
                  {label}
                </a>
              ))}
            </nav>
            <div className="catalog-local-actions">
              <button
                className="catalog-menu-toggle"
                ref={toggle}
                type="button"
                aria-label={'Menu ' + menu.name}
                aria-expanded={open}
                aria-controls="catalog-product-menu"
                onClick={() => setOpen((value) => !value)}
              >
                <ChevronDown size={20} aria-hidden="true" />
              </button>
              <a className="catalog-action" href={menu.action[1]}>
                {menu.action[0]}
              </a>
            </div>
          </div>
          <nav
            className="catalog-mobile-links"
            id="catalog-product-menu"
            aria-label={'Explorer ' + menu.name + ' sur mobile'}
            hidden={!open}
          >
            {menu.links.map(([label, href]) => (
              <a
                key={href}
                href={href}
                aria-current={pathname === href ? 'page' : undefined}
                onClick={() => setOpen(false)}
              >
                {label}
              </a>
            ))}
            <a href="/produits" onClick={() => setOpen(false)}>
              Voir tous les produits
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
