import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { BrandWordmark } from '@/components/brand-mark';
import { SupportMarketingHeader } from './marketing-header';
import { supportNavigation } from '@/lib/support/marketing';
import '@/app/support/presentation.css';
import '@/app/support/support.css';

export function SupportMarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="support-presentation">
      <a href="#support-content" className="site-skip-link">
        Aller au contenu
      </a>
      <SupportMarketingHeader />
      <main id="support-content" tabIndex={-1}>
        {children}
      </main>
      <SupportMarketingFooter />
    </div>
  );
}

export function SupportPageIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: ReactNode;
  description: string;
}) {
  return (
    <section className="sp-page-intro sp-wrap">
      <p className="sp-kicker">ZENTRA SUPPORT / {eyebrow}</p>
      <h1>{title}</h1>
      <p className="sp-lead">{description}</p>
    </section>
  );
}

export function SupportCallToAction() {
  return (
    <section className="sp-finish sp-wrap">
      <p className="sp-kicker">PLACE AUX CLIENTS</p>
      <h2>
        Découvrez votre prochain
        <br />
        quotidien côté support.
      </h2>
      <div className="sp-actions">
        <a className="sp-button sp-button-dark" href="/support/demo">
          Explorer la démo <ArrowRight size={17} aria-hidden="true" />
        </a>
        <a className="sp-text-link" href="/support/espace">
          Créer mon espace <ArrowRight size={17} aria-hidden="true" />
        </a>
      </div>
      <p className="sp-caption">
        Démo sans compte. Compte gratuit ; analyse et routage avec abonnement.
      </p>
    </section>
  );
}

export function SupportMarketingFooter() {
  return (
    <footer className="sp-footer sp-wrap">
      <div>
        <a
          href="/support"
          className="sp-brand"
          aria-label="Zentra Support, accueil"
        >
          <BrandWordmark />
          <span>Support</span>
        </a>
        <p>Le bon ticket. La bonne équipe.</p>
      </div>
      <nav aria-label="Explorer Zentra Support">
        {supportNavigation.map(([href, label]) => (
          <a key={href} href={href}>
            {label}
          </a>
        ))}
        <a href="/support/demo">Démo</a>
      </nav>
      <nav aria-label="Informations Zentra Support">
        <a href="/support/conditions">Conditions de Zentra Support</a>
        <a href="/confidentialite#support-ia">Confidentialité</a>
        <a href="/mentions-legales">Mentions légales</a>
        <a href="mailto:info@zentraapp.ch">Nous contacter</a>
        <a href="/produits">Tous nos produits</a>
      </nav>
      <small>
        © 2026 Zentra · Zentra Support est un produit et un abonnement distincts
        de Zentra Gestion.
      </small>
    </footer>
  );
}
