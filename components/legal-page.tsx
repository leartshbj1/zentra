import type { ReactNode } from 'react';
import { SiteHeader } from './site-header';
import { SiteFooter } from './site-footer';
import { LegalPrintButton } from './legal-print-button';
import { LEGAL_DATE, LEGAL_OPERATOR } from '@/lib/legal';

export type LegalSection = { id: string; title: string; content: ReactNode };

export function OperatorContact() {
  return <address className="not-italic"><strong>{LEGAL_OPERATOR.name} · Zentra</strong><br />{LEGAL_OPERATOR.street}<br />{LEGAL_OPERATOR.locality}, {LEGAL_OPERATOR.country}<br /><a href={`mailto:${LEGAL_OPERATOR.email}`}>{LEGAL_OPERATOR.email}</a></address>;
}

export function LegalPage({title, intro, sections}: {title: string; intro: string; sections: LegalSection[]}) {
  return <>
    <a href="#contenu" className="site-skip-link">Aller au contenu</a>
    <div className="legal-site-navigation"><SiteHeader /></div>
    <main id="contenu" tabIndex={-1} className="legal-page min-h-screen bg-[#f5f5f7] px-5 py-10 text-[#1d1d1f] sm:py-16">
      <div className="mx-auto max-w-5xl">
        <header className="max-w-3xl">
          <p className="text-sm font-medium text-[#626267]">Zentra · Version du {LEGAL_DATE}</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
          <p className="mt-5 text-lg leading-8 text-[#626267]">{intro}</p>
          <div className="mt-6"><LegalPrintButton /></div>
        </header>
        <div className="mt-10 grid items-start gap-8 lg:grid-cols-[210px_minmax(0,1fr)]">
          <nav aria-label="Sommaire" className="legal-toc rounded-2xl border border-[#dedee3] bg-white p-5 lg:sticky lg:top-24">
            <p className="mb-3 text-sm font-semibold">Sur cette page</p>
            {sections.map(s => <a key={s.id} href={`#${s.id}`} className="block min-h-11 py-2 text-sm leading-6 text-[#466454] hover:underline">{s.title}</a>)}
          </nav>
          <div className="min-w-0 space-y-5">{sections.map(s => <section key={s.id} id={s.id} className="scroll-mt-28 rounded-2xl border border-[#dedee3] bg-white p-6 sm:p-8">
            <h2 className="text-xl font-semibold tracking-tight">{s.title}</h2>
            <div className="legal-copy mt-4 space-y-4 text-base leading-7 text-[#48484d]">{s.content}</div>
          </section>)}</div>
        </div>
        <nav aria-label="Documents légaux" className="legal-related mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-[#315e48]">
          <a href="/mentions-legales">Mentions légales</a><a href="/conditions">Conditions</a><a href="/confidentialite">Confidentialité</a><a href="/sous-traitance">Traitement des données</a><a href="/cookies">Cookies</a>
        </nav>
      </div>
    </main>
    <div className="legal-site-navigation"><SiteFooter /></div>
  </>;
}
