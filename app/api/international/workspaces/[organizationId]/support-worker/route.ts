import { usSupportWorkerHandlers } from '@/lib/international/us-support-worker-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context) { return usSupportWorkerHandlers.read(request, (await context.params).organizationId); }
export async function POST(request: Request, context: Context) { return usSupportWorkerHandlers.manage(request, (await context.params).organizationId); }
