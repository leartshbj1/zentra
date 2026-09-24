import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { AppTour } from '@/components/app-tour';

export const metadata: Metadata = {
  title: 'Visitez Zentra Gestion — les vrais écrans de l’application',
  description:
    'Découvrez Zentra Gestion en images : devis, factures, projets, équipe, comptabilité et Automation. Une entreprise fictive, tous les menus principaux, rien à remplir.',
  alternates: { canonical: '/demo-facture' },
  openGraph: {
    title: 'Entrez dans Zentra.',
    description:
      'Les vrais écrans de l’application, avec une entreprise de démonstration. Sans compte, sans formulaire.',
    url: '/demo-facture',
    images: [
      {
        url: '/tour/gestion/accueil-desktop.webp',
        width: 1440,
        height: 960,
        alt: 'Tableau de bord Zentra, entreprise fictive Atelier du Léman',
      },
    ],
  },
};
export default function AppTourPage() {
  return (
    <>
      <SiteHeader />
      <main className="tour-page">
        <header className="tour-intro">
          <h1>
            Entrez dans <span>Zentra.</span>
          </h1>
          <p>
            Une entreprise de démonstration. Les vrais écrans de l’app.
            <br className="tour-desktop-break" /> Choisissez un menu. Rien à
            remplir.
          </p>
        </header>
        <AppTour />
        <section className="tour-finish">
          <h2>Vous avez trouvé vos repères.</h2>
          <p>Retrouvez cet espace dans votre entreprise.</p>
          <div>
            <a className="page-primary" href="/download">
              Télécharger Zentra <ArrowRight size={17} />
            </a>
            <a className="page-text-link" href="/pricing">
              Voir les formules <ArrowRight size={17} />
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
