import { runPostFinanceCreateRecovery } from '@/lib/payments/postfinance-create-recovery-route';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return runPostFinanceCreateRecovery(request);
}
