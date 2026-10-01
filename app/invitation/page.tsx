import { requireZentraUser } from '@/app/zentra-auth';
import { InvitationAccept } from '@/components/invitation-accept';
import { ArrowLeft } from 'lucide-react';

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
  const user = await requireZentraUser(returnTo);

  return (
    <main className="site-task-page apple-task-page">
      <div className="apple-task-wrap">
        <a href="/" className="apple-task-return">
          <ArrowLeft size={17} aria-hidden="true" /> Zentra
        </a>
        <h1 className="apple-task-title">
          Invitation d’entreprise
        </h1>
        <p className="apple-task-lead">
          Connecté comme <strong>{user.email}</strong>.
        </p>
        <div className="mt-8">
          {token ? (
            <InvitationAccept token={token} />
          ) : (
            <p className="apple-task-notice" role="alert">
              Le jeton d’invitation manque. Ouvrez le lien complet envoyé par
              votre administrateur.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
