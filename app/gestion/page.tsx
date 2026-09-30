import type { Metadata } from 'next';
import {
  BookOpenCheck,
  Building2,
  CalendarDays,
  FileCheck2,
  FolderKanban,
  NotebookPen,
  Users,
} from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ProductHero, ProductCapture, ProductDetails } from '@/components/quiet-product';

export const metadata: Metadata = {
  title: {
    absolute: 'Zentra Gestion — Facturation et gestion pour PME suisses',
  },
  description:
    'Devis, factures, achats, comptabilité, salaires et projets dans un même espace. Découvrez Zentra Gestion, dès 49 CHF par mois.',
  alternates: { canonical: '/gestion' },
  openGraph: {
    url: '/gestion',
    title: 'Zentra Gestion — Votre entreprise. Bien organisée.',
    description:
      'Toute votre gestion, du devis au paiement. Dès 49 CHF par mois.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
  },
};

const modules = [
  {
    icon: FileCheck2,
    title: 'Devis et factures',
    text: 'Présentez vos prestations, facturez avec un QR suisse et suivez vos encaissements.',
    href: '/features#ventes',
  },
  {
    icon: Building2,
    title: 'Achats et fournisseurs',
    text: 'Retrouvez les factures reçues, les commandes et les informations de vos fournisseurs.',
    href: '/features#achats',
  },
  {
    icon: BookOpenCheck,
    title: 'Comptabilité et TVA',
    text: 'Reliez vos écritures aux documents et préparez vos états comptables.',
    href: '/features#comptabilite',
  },
  {
    icon: Users,
    title: 'Salaires',
    text: 'Préparez vos fiches de salaire avec les informations de chaque collaborateur.',
    href: '/features#salaires',
  },
  {
    icon: FolderKanban,
    title: 'Projets',
    text: 'Rassemblez documents, tâches, temps et coûts dans le bon dossier.',
    href: '/features#projets',
  },
  {
    icon: CalendarDays,
    title: 'Banque et suivi',
    text: 'Importez vos relevés et vérifiez les paiements proposés avant de les confirmer.',
    href: '/features#banque',
  },
  {
    icon: NotebookPen,
    title: 'Notes de terrain',
    text: 'Mesures, observations et listes à cocher. Découvrez le carnet mobile de la prochaine mise à jour.',
    href: '/gestion/notes',
  },
];


export default function GestionPage() {
  return (
    <div className="quiet-site quiet-gestion">
      <a href="#contenu" className="site-skip-link">Aller au contenu</a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <ProductHero title={<>Votre entreprise.<br /><span>Bien organisée.</span></>}
          description="Devis, factures, projets et comptabilité. Retrouvez votre activité dans un même espace."
          href="/download" action="Télécharger Zentra" price="Voir les formules" priceHref="/pricing">
          <ProductCapture screen="factures" label="Les factures et leurs encaissements dans Zentra Gestion" />
        </ProductHero>
        <section className="quiet-section quiet-width" id="fonctionnalites">
          <h2>Tout ce qui fait votre quotidien.</h2>
          <div className="quiet-module-links">
            {modules.map(({ title, text, href }) => <a key={title} href={href}><h3>{title}</h3><p>{text}</p></a>)}
          </div>
        </section>
        <ProductDetails title="Et pour votre entreprise ?" id="equipe">
          <details><summary>Travailler avec mon équipe</summary>
            <p>Devis, factures et documents appartiennent à l’entreprise partagée. Les membres autorisés retrouvent les changements en ligne. Choisissez 1, 3 ou 10 personnes, titulaire compris.</p>
            <a className="quiet-link" href="/features#partage">Le travail en équipe</a>
          </details>
          <details id="automatisation"><summary>Ajouter Automation</summary>
            <p>Factures fournisseurs, rendez-vous et tâches sont préparés selon vos règles. L’option coûte 15 CHF/mois par entreprise. Les parcours e-mail nécessitent aussi un espace Support relié ; les informations incertaines restent à vérifier.</p>
            <a className="quiet-link" href="/automation">Découvrir Automation</a>
          </details>
          <details id="confidentialite"><summary>Garder la maîtrise de mes données</summary>
            <p>Une copie de travail sur votre appareil, des sauvegardes à organiser et un partage dans votre entreprise.</p>
            <a className="quiet-link" href="/security">Sécurité et données</a>
          </details>
          <details><summary>Passer de bexio à Zentra</summary>
            <p>Comparez les fonctions et préparez la reprise de vos données.</p>
            <a className="quiet-link" href="/comparatif/bexio">Comparaison et import</a>
          </details>
        </ProductDetails>
        <section className="quiet-offer quiet-width" id="tarif">
          <div><h2>Votre prochain pas.</h2><p>Choisissez la formule adaptée à votre équipe.</p></div>
          <div className="quiet-actions"><a className="quiet-primary" href="/pricing">Voir les formules</a><a className="quiet-link" href="/demo-facture">Visiter l’app</a></div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
