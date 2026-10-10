import { usSalesOrderHandlers } from '@/lib/international/us-sales-order-bindings';

type Context = { params: Promise<{ organizationId: string; salesOrderId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> { const params = await context.params; return usSalesOrderHandlers.DETAIL(request, params.organizationId, params.salesOrderId); }
