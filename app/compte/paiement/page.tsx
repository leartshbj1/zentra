import { requireZentraUser } from '@/app/zentra-auth';
import { PaymentReceipt } from '@/components/account/payment-receipt';
import { ownedPrepaidReceipt } from '@/lib/payments/prepaid-receipt';
import {
  prepaidReceiptPath,
  validPrepaidReceiptId,
} from '@/lib/payments/prepaid-receipt-types';
import { getSiteLanguage } from '@/lib/site-language-server';
import { runtimeValue } from '@/lib/runtime';
import {
  postFinancePurchaseConfiguration,
  postFinanceTestPurchaseAllowed,
} from '@/lib/payments/postfinance-purchase-configuration';

export const dynamic = 'force-dynamic';
export default async function PaymentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const intentId = validPrepaidReceiptId(query.achat) ? query.achat : '';
  const user = await requireZentraUser(prepaidReceiptPath(intentId), {
    offerAccess: false,
  });
  const language = await getSiteLanguage();
  let receipt = null;
  try {
    receipt = await ownedPrepaidReceipt(user, intentId);
  } catch {
    /* The client offers a safe, read-only retry after a transient outage. */
  }
  let canRecover = false;
  if (
    receipt?.environment === 'TEST' &&
    ['pending', 'verification_required'].includes(receipt.status) &&
    runtimeValue('POSTFINANCE_CREATE_RECOVERY_ENABLED') === 'true'
  ) {
    try {
      const configuration = postFinancePurchaseConfiguration(runtimeValue);
      canRecover =
        configuration.enabled &&
        configuration.connection.prepaidEnvironment === 'TEST' &&
        postFinanceTestPurchaseAllowed(
          configuration,
          user.userId,
          runtimeValue,
        );
    } catch {
      /* Keep the private staged action hidden if configuration is unavailable. */
    }
  }
  return (
    <PaymentReceipt
      key={intentId}
      intentId={intentId}
      initial={receipt}
      language={language}
      canRecover={canRecover}
    />
  );
}
