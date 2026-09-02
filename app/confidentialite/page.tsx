import { Cloud, Database, FileCheck2, LockKeyhole } from 'lucide-react';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

export const metadata = {
  title: 'Données et confidentialité — Zentra',
  description:
    'Comprendre précisément quelles données restent sur votre ordinateur et lesquelles sont traitées par le compte ou le coffre de factures Zentra.',
  alternates: { canonical: '/confidentialite' },
};

const sections = [
  {
    icon: Database,
    title: 'Données opérationnelles locales',
    text: 'Clients, fournisseurs, salariés, salaires, projets, temps, banque, écritures et réglages sont conservés dans la base SQLite de l’application. Zentra ne les synchronise pas automatiquement.',
  },
  {
    icon: LockKeyhole,
    title: 'Compte et accès',
    text: 'Supabase Auth traite l’adresse e-mail, le nom affiché, le mot de passe et la session de connexion. Zentra ne stocke jamais le mot de passe dans D1/R2 ni dans le navigateur : les jetons de session restent dans des cookies HttpOnly. Le service de compte conserve ensuite l’entreprise, le rôle, les appareils autorisés et les dates techniques utiles.',
  },
  {
    icon: FileCheck2,
    title: 'Coffre de factures sur option',
    text: 'Un PDF n’est transmis que lorsque vous demandez son archivage. Chaque version conserve son numéro, ses dates, son motif éventuel, son empreinte SHA-256 et sa chaîne de versions.',
  },
  {
    icon: Cloud,
    title: 'Prestataires techniques',
    text: 'Supabase fournit l’authentification; le projet de test actuel est hébergé en Ohio et devra être remplacé par une région validée avant l’ouverture commerciale. Stripe traite l’abonnement et sa facturation. Sites exécute le site et conserve encore un accès SIWC transitoire; D1/R2 hébergent actuellement les métadonnées de compte et les PDF archivés sur demande.',
  },
];

export default function PrivacyPage() {
  return (
    <>
      <a href="#contenu" className="site-skip-link">
        Aller au contenu
      </a>
      <SiteHeader />
      <main
        id="contenu"
        tabIndex={-1}
        className="min-h-screen bg-[#f6f4ee] px-5 py-10 text-[#173d2c] sm:py-16"
      >
        <div className="mx-auto max-w-5xl">
          <header className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#a66b1f]">
              Transparence des données
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-[-.045em] sm:text-6xl">
              Local par défaut. Hébergé seulement quand c’est utile.
            </h1>
            <p className="mt-5 text-lg leading-8 text-[#5f6962]">
              Cette page décrit le périmètre technique actuellement actif pour
              Zentra. Le coffre de factures est facultatif et ne remplace jamais
              votre sauvegarde locale complète.
            </p>
          </header>

          <section className="mt-10 grid gap-4 sm:grid-cols-2">
            {sections.map(({ icon: Icon, title, text }) => (
              <article
                key={title}
                className="rounded-[1.6rem] border border-[#d9d4c9] bg-white p-6 shadow-[0_18px_50px_rgba(29,45,35,.05)]"
              >
                <Icon className="size-6 text-[#397150]" />
                <h2 className="mt-5 text-xl font-semibold">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-[#667168]">{text}</p>
              </article>
            ))}
          </section>

          <section className="mt-8 rounded-[1.8rem] bg-[#173d2c] p-7 text-white sm:p-9">
            <h2 className="text-2xl font-semibold">Conservation et contrôle</h2>
            <div className="mt-5 grid gap-6 text-sm leading-7 text-white/76 sm:grid-cols-2">
              <p>
                Les PDF archivés sont conservés jusqu’à l’échéance calculée dix
                ans après la fin de l’exercice comptable concerné. Une
                correction crée une nouvelle version; l’original n’est pas
                écrasé et aucune route de suppression d’archive n’est exposée.
              </p>
              <p>
                Ces protections applicatives et empreintes facilitent la preuve
                d’intégrité, mais ne constituent pas une certification Olico ni
                une garantie de stockage WORM. Les sauvegardes et la validation
                fiduciaire restent sous la responsabilité de l’entreprise.
              </p>
            </div>
          </section>

          <section className="mt-8 rounded-[1.8rem] border border-[#d9d4c9] bg-[#fffdf9] p-7 sm:p-9">
            <h2 className="text-2xl font-semibold">
              Accès, rectification et contact
            </h2>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-[#5f6962]">
              Le propriétaire peut révoquer un membre, une invitation ou un
              appareil depuis « Mon compte ». Pour une demande relative aux
              données de compte, écrivez à{' '}
              <a
                href="mailto:leartshabija@gmail.com?subject=Zentra%20-%20données%20personnelles"
                className="font-semibold text-[#315f47] underline underline-offset-4"
              >
                leartshabija@gmail.com
              </a>
              . Zentra n’expose actuellement aucune route utilisateur pour
              supprimer une archive avant son échéance; une information erronée
              est rectifiée par une nouvelle version traçable. Le coffre n’étant
              pas certifié WORM, cette règle applicative ne constitue pas une
              garantie technique absolue contre une intervention privilégiée de
              l’opérateur.
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
