'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
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
    action: ['Télécharger', '/download'],
    links: [
      ['Fonctionnalités', '/features'],
      ['Tarifs', '/pricing'],
      ['Comparer avec bexio', '/comparatif/bexio'],
      ['Visite de l’app', '/demo-facture'],
    ],
  },
  support: {
    name: 'Zentra Support',
    href: '/support',
    action: ['Mon espace', '/support/espace'],
    links: [
      ['Fonctionnalités', '/support/fonctionnalites'],
      ['Connexions', '/support/connexions'],
      ['Tarifs', '/support/tarifs'],
      ['Démo', '/support/demo'],
    ],
  },
  automation: {
    name: 'Zentra Automation',
    href: '/automation',
    action: ['Configurer', '/compte/automation'],
    links: [
      ['Fonctions', '/automation#fonctions'],
      ['Activer', '/automation#utilisation'],
      ['Tarif', '/automation#tarif'],
    ],
  },
} as const;

const essentialLinks = {
  gestion: [['Fonctionnalités', '/features'], ['Tarifs', '/pricing']],
  support: [['Connexions', '/support/connexions'], ['Tarifs', '/support/tarifs']],
  automation: [['Fonctionnalités', '/automation#fonctions'], ['Tarif', '/automation#tarif']],
  complet: [['Inclus', '/complet#inclus'], ['Les packs', '/complet#formules']],
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
              '/comparatif',
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
  const [exploreOpen, setExploreOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const exploreToggle = useRef<HTMLButtonElement>(null);
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      setExploreOpen(false);
    }
    previousPath.current = pathname;
  }, [pathname]);
  useEffect(() => {
    if (!exploreOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExploreOpen(false);
        exploreToggle.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setExploreOpen(false);
      }
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
    };
  }, [exploreOpen]);
  return (
    <header
      className={`catalog-header intuitive-header${menu ? ' focused-product-header' : ''}`}
      ref={root}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
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
        {menu && <a className="catalog-current-product" href={menu.href}>{menu.name}</a>}
        {product ? <nav className="catalog-essentials" aria-label={'Explorer ' + menu?.name}>
          {essentialLinks[product].map(([label, href]) => <a key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>{label}</a>)}
        </nav> : <nav className="catalog-products" aria-label="Les produits Zentra">
          {products.map((item) => (
            <a
              key={item.key}
              href={item.href}
              aria-current={product === item.key ? 'true' : undefined}
            >
              {item.name}
            </a>
          ))}
        </nav>}
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
                aria-label={`Découvrir Zentra ${item.name}`}
                aria-current={product === item.key ? 'page' : undefined}
                onClick={() => setExploreOpen(false)}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                </span>
              </a>
            ))}
          </nav>
          <nav className="catalog-shortcuts" aria-label="Accès directs">
            {menu && <>
              <p>{menu.name}</p>
              {menu.links.map(([label, href]) => <a key={href} href={href} onClick={() => setExploreOpen(false)}>{label}</a>)}
              <a href={menu.action[1]} onClick={() => setExploreOpen(false)}>{menu.action[0]}</a>
            </>}
            <p>Pour commencer</p>
            <a href="/ecosysteme" onClick={() => setExploreOpen(false)}>Comment tout se relie</a>
            <a href="/questions" onClick={() => setExploreOpen(false)}>Questions fréquentes</a>
            <a href="/complet#formules" onClick={() => setExploreOpen(false)}>
              Comparer les offres
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

    </header>
  );
}
