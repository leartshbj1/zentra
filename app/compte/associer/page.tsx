import { requireChatGPTUser } from '@/app/chatgpt-auth';
import { SubscriptionClaim } from '@/components/subscription-claim';

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
  await requireChatGPTUser(returnTo);

  return (
    <main className="min-h-screen bg-[#f6f4ee] px-5 py-16 text-[#173d2c]">
      <div className="mx-auto max-w-xl">
        <a href="/" className="text-sm font-semibold text-[#52645a]">← Zentra</a>
        <p className="mt-10 text-xs font-semibold uppercase tracking-[.24em] text-[#a66b1f]">
          Compte sécurisé
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-.04em]">
          Relier Stripe à votre entreprise
        </h1>
        <p className="mt-4 leading-7 text-[#5f6962]">
          Cette étape transforme la licence individuelle en espace d’entreprise
          partagé, sans recopier vos données locales.
        </p>
        <div className="mt-8">
          {sessionId ? (
            <SubscriptionClaim sessionId={sessionId} />
          ) : (
            <p className="rounded-3xl bg-[#fff1ed] p-6 text-sm text-[#8b3f2e]">
              La référence de paiement manque. Revenez depuis la page de succès Stripe.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
