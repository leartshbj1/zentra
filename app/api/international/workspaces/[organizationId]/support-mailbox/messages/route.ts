import { usSupportMailboxHandlers } from '@/lib/international/us-support-mailbox-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context) { return usSupportMailboxHandlers.messages(request, (await context.params).organizationId); }
