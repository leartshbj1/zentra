import { getZentraUser } from '@/app/zentra-auth';
import { completePlan } from '@/lib/complete/plans';
import { CompleteCheckout } from '@/components/complete-checkout';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
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
  searchParams: Promise<{ formule?: string }>;
}) {
  const params = await searchParams,
    plan = completePlan(params.formule),
    user = await getZentraUser();
  return (
    <div className="zentra-presentation complete-page">
      <SiteHeader />
      <main className="complete-checkout">
        <a href="/complet#formules">← Les packs</a>
        <h1>{plan ? 'Tout commence ici.' : 'Choisissez votre pack.'}</h1>
        {plan ? (
          <CompleteCheckout planId={plan.id} signedIn={!!user} />
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
