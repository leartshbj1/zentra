import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site-footer';
import { SupportMarketingHeader } from './marketing-header';
import { SupportNavigationLinks } from './product-navigation';
import { currentSiteLanguage, siteText } from '@/lib/site-language-server';
import '@/app/support/presentation.css';
import '@/app/support/support.css';

const supportPages = [
  ['/support', 'Présentation'],
  ['/support/fonctionnalites', 'Fonctionnalités'],
  ['/support/connexions', 'Connexions'],
  ['/support/solutions', 'Cas d’usage'],
  ['/support/securite', 'Sécurité'],
  ['/support/tarifs', 'Tarifs'],
] as const;

export function SupportProductNavigation({
  current = '/support',
}: {
  current?: string;
}) {
  const controls = {
    fr: {
      previous: 'Afficher les rubriques précédentes',
      next: 'Afficher les rubriques suivantes',
    },
    de: {
      previous: 'Vorherige Bereiche anzeigen',
      next: 'Weitere Bereiche anzeigen',
    },
    it: {
      previous: 'Mostra le sezioni precedenti',
      next: 'Mostra le sezioni successive',
    },
    en: { previous: 'Show previous sections', next: 'Show more sections' },
  }[currentSiteLanguage()];
  return (
    <div className="sp-product-navigation">
      <div className="sp-wrap">
        <a className="sp-product-name" href="/support">
          Zentra Support
        </a>
        <SupportNavigationLinks
          current={current}
          controls={controls}
          label={siteText('Découvrir Zentra Support')}
          links={supportPages.map(([href, label]) => ({
            href,
            label: siteText(label),
          }))}
        />
        <a className="sp-product-demo" href="/support/demo">
          Essayer la démo
        </a>
      </div>
    </div>
  );
}

export function SupportMarketingShell({
  children,
  current = '/support',
}: {
  children: ReactNode;
  current?: string;
}) {
  return (
    <div className="support-presentation">
      <a href="#support-content" className="site-skip-link">
        Aller au contenu
      </a>
      <SupportMarketingHeader />
      <SupportProductNavigation current={current} />
      <main id="support-content" tabIndex={-1}>
        {children}
      </main>
      <SupportMarketingFooter />
    </div>
  );
}

export function SupportPageIntro({
  title,
  description,
}: {
  eyebrow: string;
  title: ReactNode;
  description: string;
}) {
  return (
    <section className="sp-page-intro sp-wrap">
      <h1>{title}</h1>
      <p className="sp-lead">{description}</p>
      <p className="sp-caption sp-dependency-note">
        Le classement intelligent et le routage automatique nécessitent l’option{' '}
        <a href="/automation">Zentra Automation</a> : +15 CHF/mois pour
        l’entreprise reliée à Zentra Gestion.
      </p>
    </section>
  );
}

export function SupportCallToAction() {
  return (
    <section className="sp-finish sp-wrap">
      <h2>Votre prochain pas.</h2>
      <div className="sp-actions">
        <a className="sp-button sp-button-dark" href="/support/tarifs">
          Voir les formules
        </a>
        <a className="sp-text-link" href="/support/espace">
          Ouvrir mon espace
        </a>
      </div>
      <p className="sp-caption">
        Support dès 29 CHF/mois. Tri automatique avec Automation et Gestion
        reliés.
      </p>
    </section>
  );
}

export function SupportMarketingFooter() {
  return <SiteFooter />;
}
