import { requireZentraUser } from '@/app/zentra-auth';
import { DeviceApproval } from '@/components/device-approval';
import { membershipsForUser } from '@/lib/account';
import { ArrowLeft } from 'lucide-react';

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
    <main className="site-task-page apple-task-page">
      <div className="apple-task-wrap">
        <a href="/" className="apple-task-return">
          <ArrowLeft size={17} aria-hidden="true" /> Zentra
        </a>
        <h1 className="apple-task-title">
          Autoriser un appareil
        </h1>
        <p className="apple-task-lead">
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
