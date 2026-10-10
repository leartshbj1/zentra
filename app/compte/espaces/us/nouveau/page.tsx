import { notFound, redirect } from 'next/navigation';
import { getZentraUser, requireZentraUser, zentraSignInPath } from '@/app/zentra-auth';
import { getSiteLanguage } from '@/lib/site-language-server';
import { usTestBillingEnabled } from '@/lib/international/us-saas-test-bindings';
import { creationUuid } from '@/lib/international/workspace-creation';
import { UsTestOnboarding } from '@/components/account/us-test-onboarding';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };
export default async function UsTestOnboardingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await usTestBillingEnabled()) notFound();
  const path = '/compte/espaces/us/nouveau', user = await requireZentraUser(path, { offerAccess: false }), language = await getSiteLanguage(), query = await searchParams;
  let requestId: string | null = null;
  try { if (typeof query.requestId === 'string') requestId = creationUuid(query.requestId); } catch { /* A return locator never grants a workspace or purchase. */ }
  const checkoutReturn = query.checkout === 'returned' || query.checkout === 'canceled' ? query.checkout : null;
  const current = await getZentraUser({ offerAccess: false });
  if (!current || current.userId !== user.userId) redirect(zentraSignInPath(path));
  if (!await usTestBillingEnabled()) notFound();
  return <UsTestOnboarding expectedUserId={user.userId} language={language} initialRequestId={requestId} checkoutReturn={checkoutReturn}/>;
}
