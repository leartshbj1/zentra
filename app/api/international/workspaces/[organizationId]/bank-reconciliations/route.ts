import { usBankHandlers } from '@/lib/international/us-bank-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> { return usBankHandlers.GET(request, (await context.params).organizationId); }
export async function POST(request: Request, context: Context): Promise<Response> { return usBankHandlers.POST(request, (await context.params).organizationId); }
