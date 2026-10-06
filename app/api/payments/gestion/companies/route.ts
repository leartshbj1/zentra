import { getZentraUser } from '@/app/zentra-auth';
import { database } from '@/lib/runtime';
import { noStoreHeaders } from '@/lib/stripe';
import { ownedGestionPurchaseCompanies } from '@/lib/payments/owned-gestion-companies';
export const dynamic = 'force-dynamic';
export async function GET() {
  const headers = noStoreHeaders();
  try {
    const user = await getZentraUser({ refreshSession: true });
    if (!user || user.emailConfirmed !== true)
      return Response.json(
        { error: 'Connectez-vous à votre compte Zentra.' },
        { status: 401, headers },
      );
    const companies = await ownedGestionPurchaseCompanies(
      database(),
      user.userId,
    );
    return Response.json({ companies }, { headers });
  } catch {
    return Response.json(
      { error: 'Le paiement est momentanément indisponible.' },
      { status: 503, headers },
    );
  }
}
