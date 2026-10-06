import { requireZentraUser } from '@/app/zentra-auth';
import { PaymentReceipt } from '@/components/account/payment-receipt';
import { ownedPrepaidReceipt } from '@/lib/payments/prepaid-receipt';
import { prepaidReceiptPath, validPrepaidReceiptId } from '@/lib/payments/prepaid-receipt-types';
import { getSiteLanguage } from '@/lib/site-language-server';

export const dynamic = 'force-dynamic';
export default async function PaymentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const intentId = validPrepaidReceiptId(query.achat) ? query.achat : '';
  const user = await requireZentraUser(prepaidReceiptPath(intentId), { offerAccess: false });
  const language = await getSiteLanguage();
  let receipt = null;
  try { receipt = await ownedPrepaidReceipt(user, intentId); }
  catch { /* The client offers a safe, read-only retry after a transient outage. */ }
  return <PaymentReceipt key={intentId} intentId={intentId} initial={receipt} language={language} />;
}
