import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { SiteFooter } from '@/components/site-footer';
import { SupportMarketingHeader } from './marketing-header';
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
      <p className="sp-caption">
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
      <h2>Voyez la différence.</h2>
      <div className="sp-actions">
        <a className="sp-button sp-button-dark" href="/support/demo">
          Essayer la démo <ArrowRight size={17} aria-hidden="true" />
        </a>
        <a className="sp-text-link" href="/support/espace">
          Créer mon espace <ArrowRight size={17} aria-hidden="true" />
        </a>
      </div>
      <p className="sp-caption">
        Démo sans compte. Support sur abonnement ; analyse et routage
        automatique avec l’option Automation à +15 CHF/mois par entreprise.
      </p>
    </section>
  );
}

export function SupportMarketingFooter() {
  return <SiteFooter />;
}
