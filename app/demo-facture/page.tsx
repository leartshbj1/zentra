import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { InvoiceDemo } from './invoice-demo';

export const metadata: Metadata = {
  title: 'Créer une facture suisse — démonstration Elyko',
  description:
    'Saisissez vos propres informations, calculez la TVA et imprimez une facture avec aperçu QR sans envoyer vos données.',
  openGraph: {
    title: 'Créer une facture suisse — démonstration Elyko',
    description: 'Un aperçu interactif local, vide au départ, avec calcul de TVA et bande QR structurée.',
  },
  twitter: {
    title: 'Créer une facture suisse — démonstration Elyko',
    description: 'Un aperçu interactif local, vide au départ, avec calcul de TVA et bande QR structurée.',
  },
};

export default function InvoiceDemoPage() {
  return (
    <main className="min-h-screen bg-[#f4f2ed] text-[#17231d]">
      <header className="print-hidden mx-auto flex max-w-7xl items-center justify-between px-5 py-5 lg:px-8">
        <a href="/" className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-[#173d2c] text-[#efaa3c]">
            <BrandMark className="size-9" />
          </span>
          <span className="font-semibold tracking-[-.03em]">Elyko</span>
        </a>
        <a href="/" className="flex items-center gap-2 text-sm text-[#637068]">
          <ArrowLeft className="size-4" /> Retour au site
        </a>
      </header>

      <section className="print-hidden mx-auto max-w-7xl px-5 pb-10 pt-10 lg:px-8 lg:pt-16">
        <p className="text-xs font-semibold uppercase tracking-[.13em] text-[#9b651e]">
          Démonstration interactive locale
        </p>
        <h1 className="mt-4 max-w-4xl text-4xl font-semibold leading-tight tracking-[-.05em] sm:text-6xl">
          Construisez une facture avec vos propres informations.
        </h1>
        <p className="mt-5 max-w-3xl text-lg leading-8 text-[#67716a]">
          Rien n’est prérempli, enregistré ou transmis. Les calculs et l’aperçu sont réalisés dans votre navigateur, puis le bouton d’impression permet d’enregistrer le document en PDF. Cet exemple ne remplace pas une validation fiscale ou SIX.
        </p>
      </section>

      <InvoiceDemo />
    </main>
  );
}
