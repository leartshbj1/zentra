import { requireChatGPTUser } from '@/app/chatgpt-auth';
import { InvitationAccept } from '@/components/invitation-accept';

export const dynamic = 'force-dynamic';

export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token: rawToken = '' } = await searchParams;
  const token = rawToken.trim();
  const returnTo = token
    ? `/invitation?token=${encodeURIComponent(token)}`
    : '/invitation';
  const user = await requireChatGPTUser(returnTo);

  return (
    <main className="min-h-screen bg-[#f6f4ee] px-5 py-14 text-[#173d2c]">
      <div className="mx-auto max-w-xl">
        <a href="/" className="text-sm font-semibold text-[#52645a]">← Zentra</a>
        <p className="mt-10 text-xs font-semibold uppercase tracking-[.24em] text-[#a66b1f]">
          Équipe Zentra
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-.04em] sm:text-5xl">
          Invitation d’entreprise
        </h1>
        <p className="mt-4 leading-7 text-[#5f6962]">
          Connecté comme <strong>{user.email}</strong>.
        </p>
        <div className="mt-8">
          {token ? (
            <InvitationAccept token={token} />
          ) : (
            <p className="rounded-3xl bg-[#fff1ed] p-6 text-sm text-[#8b3f2e]">
              Le jeton d’invitation manque. Ouvrez le lien complet envoyé par
              votre administrateur.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
