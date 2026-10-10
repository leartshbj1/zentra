import { usSupportMailboxHandlers } from '@/lib/international/us-support-mailbox-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context) { return usSupportMailboxHandlers.read(request, (await context.params).organizationId); }
export async function POST(request: Request, context: Context) { return usSupportMailboxHandlers.write(request, (await context.params).organizationId); }
