import { runPostFinancePurchase } from '@/lib/payments/postfinance-purchase-route';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return runPostFinancePurchase(request);
}
