import { ShieldCheck } from 'lucide-react';
import { AccountActivation } from '@/components/account-activation';
import { BrandMark } from '@/components/brand-mark';

export const metadata = {
  title: 'Activer Zentra',
  description:
    'Votre abonnement est associé automatiquement à votre compte Zentra.',
  robots: { index: false, follow: false },
};

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const sessionId = (await searchParams).session_id?.trim() ?? '';
  return (
    <main className="site-task-page min-h-screen bg-[#f4f2ed] px-5 py-10 text-[#17231d]">
      <div className="mx-auto max-w-2xl">
        <a href="/" className="inline-flex min-h-11 items-center gap-2.5">
          <BrandMark className="size-9" />
          <span className="font-semibold tracking-[-.03em]">Zentra</span>
        </a>
        <div className="mb-8 mt-14" data-reveal>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.13em] text-[#397055]">
            <ShieldCheck className="size-4" /> Activation protégée
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-.045em] sm:text-5xl">
            Votre abonnement Zentra
          </h1>
          <p className="mt-4 text-base leading-7 text-[#5f6962]">
            Un seul compte pour votre abonnement et vos appareils. Aucun jeton à
            copier : connectez-vous à Zentra pour activer votre accès.
          </p>
        </div>
        {sessionId ? (
          <AccountActivation sessionId={sessionId} />
        ) : (
          <div className="rounded-2xl border border-[#e0b5a8] bg-[#fff1ed] p-5 text-sm text-[#7b3e31]">
            La référence de paiement manque. Reprenez l’achat depuis la page
            tarif ou contactez le support.
          </div>
        )}
        <p className="mt-7 text-center text-xs text-[#5f6962]">
          Support :{' '}
          <a
            className="font-semibold underline"
            href="mailto:info@zentraapp.ch"
          >
            info@zentraapp.ch
          </a>
        </p>
      </div>
    </main>
  );
}
