import { requireZentraUser } from '@/app/zentra-auth';
import { DeviceApproval } from '@/components/device-approval';
import { membershipsForUser } from '@/lib/account';

export const dynamic = 'force-dynamic';

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code = '' } = await searchParams;
  const returnTo = code
    ? `/appareil?code=${encodeURIComponent(code)}`
    : '/appareil';
  const user = await requireZentraUser(returnTo);
  const memberships = await membershipsForUser(user.userId);

  return (
    <main className="min-h-screen bg-[#f6f4ee] px-5 py-14 text-[#173d2c]">
      <div className="mx-auto max-w-xl">
        <a href="/" className="text-sm font-semibold text-[#52645a]">← Zentra</a>
        <p className="mt-10 text-xs font-semibold uppercase tracking-[.24em] text-[#a66b1f]">
          Connexion sécurisée
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-.04em] sm:text-5xl">
          Autoriser un ordinateur
        </h1>
        <p className="mt-4 leading-7 text-[#5f6962]">
          Connecté comme <strong>{user.email}</strong>. Vérifiez que le code
          correspond exactement à celui affiché dans l’application.
        </p>
        <div className="mt-8">
          <DeviceApproval initialCode={code} memberships={memberships} />
        </div>
      </div>
    </main>
  );
}
