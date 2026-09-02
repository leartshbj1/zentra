import { ArrowLeft, Cloud, Database, FileCheck2, LockKeyhole } from 'lucide-react';

export const metadata = {
  title: 'Données et confidentialité — Zentra',
  description:
    'Comprendre précisément quelles données restent sur votre ordinateur et lesquelles sont traitées par le compte ou le coffre de factures Zentra.',
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
    text: 'Le service conserve l’identifiant du compte, l’e-mail, le nom affiché, l’entreprise, le rôle, les appareils autorisés et les dates techniques de session. Les jetons secrets de session, d’invitation et d’appareil sont hachés avant stockage côté serveur.',
  },
  {
    icon: FileCheck2,
    title: 'Coffre de factures sur option',
    text: 'Un PDF n’est transmis que lorsque vous demandez son archivage. Chaque version conserve son numéro, ses dates, son motif éventuel, son empreinte SHA-256 et sa chaîne de versions.',
  },
  {
    icon: Cloud,
    title: 'Prestataires techniques',
    text: 'Stripe traite l’abonnement et la facturation. L’hébergement Sites fournit l’authentification et l’exécution du site; D1/R2 hébergent les métadonnées de compte et les PDF archivés.',
  },
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#f6f4ee] px-5 py-10 text-[#173d2c] sm:py-16">
      <div className="mx-auto max-w-5xl">
        <a
          href="/"
          className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#52645a]"
        >
          <ArrowLeft className="size-4" /> Retour à Zentra
        </a>
        <header className="mt-7 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#a66b1f]">
            Transparence des données
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-.045em] sm:text-6xl">
            Local par défaut. Hébergé seulement quand c’est utile.
          </h1>
          <p className="mt-5 text-lg leading-8 text-[#5f6962]">
            Cette page décrit le périmètre technique actuellement prévu pour
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
              ans après la fin de l’exercice comptable concerné. Une correction
              crée une nouvelle version; l’original n’est pas écrasé et aucune
              route de suppression d’archive n’est exposée.
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
          <h2 className="text-2xl font-semibold">Accès, rectification et contact</h2>
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
            . Une archive soumise à une obligation légale de conservation ne
            peut pas être effacée avant son échéance; une information erronée
            est rectifiée par une nouvelle version traçable.
          </p>
        </section>
      </div>
    </main>
  );
}
