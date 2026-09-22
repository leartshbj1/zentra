import { getZentraUser, zentraSignInPath } from '@/app/zentra-auth';
import { isAutomationFounder } from '@/lib/automation/access';
import { AutomationFounderSettings } from '@/components/automation/founder-settings';
import { AutomationCompanySettings } from '@/components/automation/company-settings';
import { membershipsForUser } from '@/lib/account';
import { ReferralPanel } from '@/components/automation/referral-panel';
import '@/components/automation/automation.css';
import { notFound } from 'next/navigation';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Zentra Automation · Mon compte',
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const user = await getZentraUser();
  const organizations = user ? await membershipsForUser(user.userId) : [];
  const selected = typeof query.organizationId === 'string' ? query.organizationId : typeof query.entreprise === 'string' ? query.entreprise : '';
  if(user && selected && !organizations.some(org=>org.organizationId===selected))notFound();
  return (
    <div className="automation-page">
      <div className="automation-wrap">
        <a href="/compte">← Mon compte</a>
        <h1>Zentra Automation</h1>

        {!user ? (
          <section className="automation-panel">
            <h2>Connectez-vous à Zentra</h2>
            <a
              className="automation-button"
              href={zentraSignInPath('/compte/automation')}
            >
              Se connecter
            </a>
          </section>
        ) : (
          <>
            <AutomationCompanySettings
              organizations={organizations}
              initialOrganization={
                typeof query.organizationId === 'string' ? query.organizationId : typeof query.entreprise === 'string' ? query.entreprise : ''
              }
              paymentReturned={query.paiement === 'retour'}
            />
            <details className="automation-account-extra"><summary>Parrainage</summary><ReferralPanel organizations={organizations} /></details>
            {isAutomationFounder(user) && <details className="automation-account-extra"><summary>Administration Zentra</summary><AutomationFounderSettings /></details>}
          </>
        )}
      </div>
    </div>
  );
}
