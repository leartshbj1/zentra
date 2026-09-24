import type { Metadata } from 'next';
import {
  ArrowRight,
  BookOpenCheck,
  Building2,
  CalendarDays,
  FileCheck2,
  FolderKanban,
  Users,
} from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { GestionExperience } from '@/components/gestion-experience';

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
];

export default function GestionPage() {
  return (
    <>
      <a href="#contenu" className="site-skip-link">
        Aller au contenu
      </a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1} className="gestion-page polished-page">
        <section className="page-intro page-width">
          <h1>
            Votre entreprise.
            <br />
            <span>Bien organisée.</span>
          </h1>
          <p>
            Vos devis, vos chiffres et votre équipe.
            <br />
            Tout se retrouve, tout devient plus simple.
          </p>
          <div className="page-actions">
            <a className="page-primary" href="#fonctionnalites">
              Découvrir les fonctionnalités <ArrowRight size={17} aria-hidden="true" />
            </a>
            <a className="page-text-link" href="/pricing">
              Dès 49 CHF / mois <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
        </section>
        <GestionExperience />
        <section
          className="page-section page-width"
          id="fonctionnalites"
          aria-labelledby="gestion-tools"
        >
          <div className="page-section-heading">
            <h2 id="gestion-tools">
              Tout votre quotidien.
              <br />
              <span>Au même endroit.</span>
            </h2>
            <p>
              Passez d’une tâche à la suivante, avec les mêmes informations.
            </p>
          </div>
          <div className="page-module-list">
            {modules.map(({ icon: Icon, title, text, href }) => (
              <a key={title} href={href}>
                <Icon size={24} strokeWidth={1.5} aria-hidden="true" />
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
                <ArrowRight size={18} aria-hidden="true" />
              </a>
            ))}
          </div>
        </section>
        <section className="page-band" id="equipe">
          <div className="page-width page-split">
            <div>
              <h2>
                Une équipe.
                <br />
                <span>Le même espace.</span>
              </h2>
              <p>
                Une facture créée, un paiement enregistré, un document ajouté :
                les membres autorisés retrouvent les changements dans
                l’entreprise partagée, avec une connexion Internet.
              </p>
              <a className="page-text-link" href="/features#partage">
                Découvrir le travail en équipe{' '}
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            </div>
            <div
              className="gestion-shared-example"
              aria-label="Exemple fictif de dossier partagé"
            >
              <p className="journey-demo-label">Exemple de dossier partagé</p>
              <h3>Aménagement des bureaux</h3>
              <ul>
                <li>
                  <FileCheck2 size={21} aria-hidden="true" />
                  <span>
                    Devis accepté<small>Les prestations convenues</small>
                  </span>
                  <CheckMark />
                </li>
                <li>
                  <BookOpenCheck size={21} aria-hidden="true" />
                  <span>
                    Facture et encaissement
                    <small>Le suivi financier du projet</small>
                  </span>
                  <CheckMark />
                </li>
                <li>
                  <FolderKanban size={21} aria-hidden="true" />
                  <span>
                    Plans et documents
                    <small>Les pièces utiles à l’équipe</small>
                  </span>
                  <CheckMark />
                </li>
              </ul>
            </div>
          </div>
        </section>
        <section
          className="page-section page-width page-split"
          id="automatisation"
        >
          <div>
            <h2>
              Et si la suite
              <br />
              <span>se préparait toute seule&nbsp;?</span>
            </h2>
            <p>
              Ajoutez Automation à Gestion. Les factures fournisseurs, les
              rendez-vous et les tâches trouvent leur place selon les règles que
              vous activez.
            </p>
            <p className="page-caption">
              Option à 15 CHF/mois par entreprise. Les parcours e-mail
              nécessitent Support relié. Les informations incertaines restent à
              vérifier.
            </p>
            <a className="page-text-link" href="/automation">
              Découvrir Automation <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          <div className="gestion-automation-flow">
            <div>
              <span>Dans Support</span>
              <strong>Une facture arrive.</strong>
            </div>
            <ArrowRight size={23} aria-hidden="true" />
            <div>
              <span>Avec Automation</span>
              <strong>Les informations sont extraites.</strong>
            </div>
            <ArrowRight size={23} aria-hidden="true" />
            <div>
              <span>Dans Gestion</span>
              <strong>Votre achat est préparé.</strong>
            </div>
          </div>
        </section>
        <section
          className="page-section page-width page-trust"
          id="confidentialite"
        >
          <h2>
            Vos données vous suivent.
            <br />
            <span>Vous en gardez la maîtrise.</span>
          </h2>
          <p>
            Une copie de travail sur votre appareil, le partage avec votre
            équipe et des sauvegardes à organiser. Retrouvez les détails en
            toute transparence.
          </p>
          <a className="page-text-link" href="/security">
            Comprendre les données et la sécurité{' '}
            <ArrowRight size={17} aria-hidden="true" />
          </a>
        </section>
        <section className="page-finish page-width" id="tarif">
          <h2>Faites votre premier pas.</h2>
          <p>Téléchargez Zentra pour votre entreprise.</p>
          <div className="page-actions">
            <a className="page-primary" href="/download">
              Télécharger l’app <ArrowRight size={17} aria-hidden="true" />
            </a>
            <a className="page-text-link" href="/demo-facture">
              Voir la démo <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
function CheckMark() {
  return (
    <span className="shared-document-mark" aria-label="Dans le dossier">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="m5 12 4 4L19 6" />
      </svg>
    </span>
  );
}
