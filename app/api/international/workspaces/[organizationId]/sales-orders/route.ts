import { usSalesOrderHandlers } from '@/lib/international/us-sales-order-bindings';

type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> { return usSalesOrderHandlers.GET(request, (await context.params).organizationId); }
export async function POST(request: Request, context: Context): Promise<Response> { return usSalesOrderHandlers.POST(request, (await context.params).organizationId); }
