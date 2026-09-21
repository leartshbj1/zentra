import { getZentraUser, zentraSignInPath } from '@/app/zentra-auth';
import { requireBrowserMembership } from '@/lib/account';
import { inboxState } from '@/lib/supplier-inbox/service';
import { notFound, redirect } from 'next/navigation';
import { SupplierReceipts } from '@/components/automation/supplier-receipts';
import '@/components/automation/automation.css';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Factures reçues · Zentra',
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const org =
    typeof query.organizationId === 'string'
      ? query.organizationId
      : typeof query.entreprise === 'string'
        ? query.entreprise
        : '';
  const user = await getZentraUser();
  if (!user) redirect(zentraSignInPath('/compte/automation'));
  if (!org) redirect('/compte/automation');
  const member = await requireBrowserMembership(user.userId, org).catch(
    () => null,
  );
  if (!member) notFound();
  const state = await inboxState({
    organizationId: org,
    userId: user.userId,
    role: member.role,
    founder: false,
  });
  return (
    <main className="automation-page">
      <div className="automation-wrap">
        <a href={`/compte/automation?entreprise=${encodeURIComponent(org)}`}>
          ← Zentra Automation
        </a>
        <h1>Vos factures reçues</h1>
        <p>
          {member.organizationName} · Retrouvez ici leur arrivée et leur état
          dans Gestion.
        </p>
        <SupplierReceipts key={org} organizationId={org} initialState={state} />
      </div>
    </main>
  );
}
