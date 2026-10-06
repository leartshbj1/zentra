import { runPostFinanceReceipt } from '@/lib/payments/postfinance-receipt-route';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return runPostFinanceReceipt(request); }
