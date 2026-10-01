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
    <main className="site-task-page apple-task-page">
      <div className="apple-task-wrap apple-task-wrap-wide">
        <a href="/" className="apple-task-brand">
          <BrandMark className="size-9" />
          <span className="font-semibold tracking-[-.03em]">Zentra</span>
        </a>
        <div className="apple-task-heading">
          <h1 className="apple-task-title">
            Votre abonnement Zentra
          </h1>
          <p className="apple-task-lead">
            Un seul compte pour votre abonnement et vos appareils. Aucun jeton à
            copier : connectez-vous à Zentra pour activer votre accès.
          </p>
        </div>
        {sessionId ? (
          <AccountActivation sessionId={sessionId} />
        ) : (
          <div className="apple-task-notice" role="alert">
            La référence de paiement manque. Reprenez l’achat depuis la page
            tarif ou contactez le support.
          </div>
        )}
        <p className="apple-task-help">
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
