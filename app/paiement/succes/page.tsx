import { HardHat, ShieldCheck } from 'lucide-react';
import { LicenseDelivery } from '@/components/license-delivery';

export const metadata = {
  title: 'Activer HelviChantier',
  description: 'Récupérez votre licence HelviChantier après le paiement Stripe.',
  robots: { index: false, follow: false },
};

export default async function PaymentSuccessPage({ searchParams }: { searchParams: Promise<{ session_id?: string }> }) {
  const sessionId = (await searchParams).session_id?.trim() ?? '';
  return (
    <main className="min-h-screen bg-[#f4f2ed] px-5 py-10 text-[#17231d]">
      <div className="mx-auto max-w-2xl">
        <a href="/" className="inline-flex items-center gap-2.5"><span className="grid size-9 place-items-center rounded-xl bg-[#173d2c] text-[#efaa3c]"><HardHat className="size-5" /></span><span className="font-semibold tracking-[-.03em]">HelviChantier</span></a>
        <div className="mb-8 mt-14"><p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.13em] text-[#397055]"><ShieldCheck className="size-4" /> Activation protégée</p><h1 className="mt-4 text-4xl font-semibold tracking-[-.045em] sm:text-5xl">Votre abonnement HelviChantier</h1><p className="mt-4 text-base leading-7 text-[#6e7770]">Stripe gère le paiement. HelviChantier reçoit uniquement l’état de l’abonnement et l’identifiant d’installation nécessaire à la licence.</p></div>
        {sessionId ? <LicenseDelivery sessionId={sessionId} /> : <div className="rounded-2xl border border-[#e0b5a8] bg-[#fff1ed] p-5 text-sm text-[#7b3e31]">La référence de paiement manque. Reprenez l’achat depuis la page tarif ou contactez le support.</div>}
        <p className="mt-7 text-center text-xs text-[#7a837c]">Support : <a className="font-semibold underline" href="mailto:leartshabija@gmail.com">leartshabija@gmail.com</a></p>
      </div>
    </main>
  );
}
