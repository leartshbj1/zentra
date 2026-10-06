import { runPostFinanceReconciliation } from '@/lib/payments/postfinance-reconciliation-route';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return runPostFinanceReconciliation(request);
}
