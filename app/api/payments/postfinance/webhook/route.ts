import { receivePostFinanceWebhook } from '@/lib/payments/postfinance-webhook';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return receivePostFinanceWebhook(request);
}
