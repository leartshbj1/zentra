import { notFound } from 'next/navigation';
import { requireZentraUser } from '@/app/zentra-auth';
import { PendingPayments } from '@/components/account/pending-payments';
import {
  listOwnedPendingPrepaidReceipts,
  PendingPrepaidReceiptCursorError,
  type OwnedPendingPrepaidReceiptsPage,
} from '@/lib/payments/pending-prepaid-receipts';
import { getSiteLanguage } from '@/lib/site-language-server';

export const dynamic = 'force-dynamic';

const titles = {
  fr: 'Suivi des paiements',
  de: 'Zahlungen im Blick',
  it: 'Stato dei pagamenti',
  en: 'Payment tracking',
};

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const cursor = query.avant;
  const returnTo =
    typeof cursor === 'string' && cursor.length <= 256
      ? `/compte/paiements?avant=${encodeURIComponent(cursor)}`
      : '/compte/paiements';
  const user = await requireZentraUser(returnTo, { offerAccess: false });
  if (cursor !== undefined && typeof cursor !== 'string') notFound();
  const language = await getSiteLanguage();
  let page: OwnedPendingPrepaidReceiptsPage | null = null;
  try {
    page = await listOwnedPendingPrepaidReceipts(user, { cursor });
  } catch (error) {
    if (error instanceof PendingPrepaidReceiptCursorError) notFound();
    console.warn('zentra_payment_followup', {
      provider: 'postfinance',
      code: 'list_unavailable',
    });
  }
  return (
    <>
      <h1>{titles[language]}</h1>
      <PendingPayments page={page} language={language} showEmpty />
    </>
  );
}
