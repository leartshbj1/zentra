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
  return <SiteFooter />;
}
