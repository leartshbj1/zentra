import type { ReactNode } from 'react';
import { SiteHeader } from './site-header';
import { SiteFooter } from './site-footer';
import { LegalPrintButton } from './legal-print-button';
import { ChevronDown } from 'lucide-react';
import { LEGAL_DATE, LEGAL_OPERATOR } from '@/lib/legal';

export type LegalSection = { id: string; title: string; content: ReactNode };

export function OperatorContact() {
  return (
    <address className="not-italic">
      <strong>{LEGAL_OPERATOR.name} · Zentra</strong>
      <br />
      {LEGAL_OPERATOR.street}
      <br />
      {LEGAL_OPERATOR.locality}, {LEGAL_OPERATOR.country}
      <br />
      <a href={`mailto:${LEGAL_OPERATOR.email}`}>{LEGAL_OPERATOR.email}</a>
    </address>
  );
}

export function LegalPage({
  title,
  intro,
  sections,
  versionDate = LEGAL_DATE,
  header,
  footer,
}: {
  title: string;
  intro: string;
  sections: LegalSection[];
  versionDate?: string;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <a href="#contenu" className="site-skip-link">
        Aller au contenu
      </a>
      <div className="legal-site-navigation">{header ?? <SiteHeader />}</div>
      <main id="contenu" tabIndex={-1} className="legal-page">
        <div className="legal-frame">
          <header className="legal-header">
            <div className="legal-heading">
              <h1>{title}</h1>
              <p>{intro}</p>
            </div>
            <div className="legal-tools">
              <p>Zentra · Version du {versionDate}</p>
              <LegalPrintButton />
            </div>
          </header>
          <details className="legal-mobile-toc">
            <summary>
              Sommaire <ChevronDown size={18} aria-hidden="true" />
            </summary>
            <nav aria-label="Sommaire mobile">
              {sections.map((s) => (
                <a key={s.id} href={`#${s.id}`}>
                  {s.title}
                </a>
              ))}
            </nav>
          </details>
          <div className="legal-layout">
            <nav aria-label="Sommaire" className="legal-toc">
              <h2>Sur cette page</h2>
              {sections.map((s) => (
                <a key={s.id} href={`#${s.id}`}>
                  {s.title}
                </a>
              ))}
            </nav>
            <div className="legal-sections">
              {sections.map((s) => (
                <section key={s.id} id={s.id}>
                  <h2>{s.title}</h2>
                  <div className="legal-copy">{s.content}</div>
                </section>
              ))}
            </div>
          </div>
          <nav aria-label="Documents légaux" className="legal-related">
            <a href="/mentions-legales">Mentions légales</a>
            <a href="/conditions">Conditions</a>
            <a href="/confidentialite">Confidentialité</a>
            <a href="/sous-traitance">Traitement des données</a>
            <a href="/cookies">Cookies</a>
          </nav>
        </div>
      </main>
      <div className="legal-site-navigation">{footer ?? <SiteFooter />}</div>
    </>
  );
}
