import { requireZentraUser } from '@/app/zentra-auth';
import { SubscriptionClaim } from '@/components/subscription-claim';
import { ArrowLeft } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function LinkSubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id: rawSessionId } = await searchParams;
  const sessionId = rawSessionId?.trim() ?? '';
  const returnTo = sessionId
    ? `/compte/associer?session_id=${encodeURIComponent(sessionId)}`
    : '/compte/associer';
  await requireZentraUser(returnTo);

  return (
    <section className="site-task-page apple-task-page">
      <div className="apple-task-wrap">
        <a href="/" className="apple-task-return">
          <ArrowLeft size={17} aria-hidden="true" /> Zentra
        </a>
        <h1 className="apple-task-title">
          Relier Stripe à votre entreprise
        </h1>
        <p className="apple-task-lead">
          Cette étape transforme la licence individuelle en espace d’entreprise
          partagé, sans recopier vos données locales.
        </p>
        <div className="mt-8">
          {sessionId ? (
            <SubscriptionClaim sessionId={sessionId} />
          ) : (
            <p className="apple-task-notice" role="alert">
              La référence de paiement manque. Revenez depuis la page de succès
              Stripe.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
