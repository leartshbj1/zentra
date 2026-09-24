'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowRight, ChevronDown, Menu, X } from 'lucide-react';
import { BrandWordmark } from './brand-mark';
import { AccountLink } from './account-link';

const products = [
  {
    name: 'Gestion',
    description: 'Pilotez votre entreprise.',
    href: '/gestion',
    key: 'gestion',
  },
  {
    name: 'Support',
    description: 'Chaque demande à sa place.',
    href: '/support',
    key: 'support',
  },
  {
    name: 'Automation',
    description: 'Les tâches du quotidien avancent.',
    href: '/automation',
    key: 'automation',
  },
  {
    name: 'Complet',
    description: 'Les trois produits, un seul pack.',
    href: '/complet',
    key: 'complet',
  },
] as const;
const productMenus = {
  complet: {
    name: 'Zentra Complet',
    href: '/complet',
    action: ['Choisir mon pack', '/complet#formules'],
    links: [
      ['Les packs', '/complet#formules'],
      ['Tout ce qui est inclus', '/complet#inclus'],
      ['Questions', '/complet#questions'],
    ],
  },
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
      ['En action', '/automation#parcours'],
      ['Fonctions', '/automation#fonctions'],
      ['Au quotidien', '/automation#quotidien'],
      ['Activer', '/automation#utilisation'],
      ['Tarif', '/automation#tarif'],
    ],
  },
} as const;

export function SiteHeader() {
  const pathname = usePathname() ?? '/';
  const product = pathname.startsWith('/complet')
    ? 'complet'
    : pathname.startsWith('/support')
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
            ].some(
              (path) => pathname === path || pathname.startsWith(path + '/'),
            )
          ? 'gestion'
          : null;
  const menu = product ? productMenus[product] : null;
  const [open, setOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const exploreToggle = useRef<HTMLButtonElement>(null);
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      setOpen(false);
      setExploreOpen(false);
    }
    previousPath.current = pathname;
  }, [pathname]);
  useEffect(() => {
    if (!open && !exploreOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setExploreOpen(false);
        (exploreOpen ? exploreToggle : toggle).current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false);
        setExploreOpen(false);
      }
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open, exploreOpen]);
  return (
    <header
      className="catalog-header intuitive-header"
      ref={root}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setOpen(false);
          setExploreOpen(false);
        }
      }}
    >
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
        <button
          className="catalog-explore-toggle"
          type="button"
          ref={exploreToggle}
          aria-label={exploreOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
          aria-expanded={exploreOpen}
          aria-controls="catalog-explore"
          onClick={() => {
            setExploreOpen(!exploreOpen);
            setOpen(false);
          }}
        >
          <span>Menu</span>
          {exploreOpen ? (
            <X size={20} aria-hidden="true" />
          ) : (
            <Menu size={20} aria-hidden="true" />
          )}
        </button>
      </div>
      <div
        className="catalog-explore"
        id="catalog-explore"
        hidden={!exploreOpen}
      >
        <div className="catalog-explore-inner">
          <nav
            className="catalog-explore-products"
            aria-label="Découvrir les produits"
          >
            {products.map((item) => (
              <a
                key={item.key}
                href={item.href}
                aria-current={product === item.key ? 'page' : undefined}
                onClick={() => setExploreOpen(false)}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                </span>
                <ArrowRight size={20} aria-hidden="true" />
              </a>
            ))}
          </nav>
          <nav className="catalog-shortcuts" aria-label="Accès directs">
            <p>Pour commencer</p>
            <a href="/#choisir" onClick={() => setExploreOpen(false)}>
              Trouver mon outil <ArrowRight size={16} aria-hidden="true" />
            </a>
            <a href="/complet#formules" onClick={() => setExploreOpen(false)}>
              Comparer les packs
            </a>
            <a href="/demo-facture" onClick={() => setExploreOpen(false)}>
              Essayer Gestion
            </a>
            <a href="/support/demo" onClick={() => setExploreOpen(false)}>
              Essayer Support
            </a>
            <a href="/download" onClick={() => setExploreOpen(false)}>
              Télécharger l’application
            </a>
            <a href="/support/espace" onClick={() => setExploreOpen(false)}>
              Ouvrir mon espace Support
            </a>
          </nav>
        </div>
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
                onClick={() => {
                  setOpen((value) => !value);
                  setExploreOpen(false);
                }}
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
