import { getZentraUser } from '@/app/zentra-auth';
import { completePlan } from '@/lib/complete/plans';
import { CompleteCheckout } from '@/components/complete-checkout';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import { validPostFinanceTargetId } from '@/lib/payments/postfinance-client-navigation';
import '@/components/zentra-presentation.css';
import '../complet.css';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Choisir Zentra Complet',
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ formule?: string; organizationId?: string | string[] }>;
}) {
  const params = await searchParams,
    plan = completePlan(params.formule),
    user = await getZentraUser({ offerAccess: false });
  if (params.organizationId !== undefined && !validPostFinanceTargetId(params.organizationId)) notFound();
  return (
    <div className="zentra-presentation complete-page">
      <SiteHeader />
      <main className="complete-checkout apple-complete-checkout">
        <a href="/complet#formules"><ArrowLeft size={17} aria-hidden="true" /> Les packs</a>
        <h1>{plan ? 'Tout commence ici.' : 'Choisissez votre pack.'}</h1>
        {plan ? (
          <CompleteCheckout key={`${user?.userId ?? 'guest'}:${plan.id}:${params.organizationId ?? ''}`} planId={plan.id} signedIn={!!user} initialOrganization={params.organizationId as string | undefined} />
        ) : (
          <p>
            <a href="/complet#formules">Voir Solo, Équipe et Pro</a>
          </p>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
