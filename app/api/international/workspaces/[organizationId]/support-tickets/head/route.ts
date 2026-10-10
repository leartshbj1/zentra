import { usSupportTicketHandlers } from '@/lib/international/us-support-ticket-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context) { return usSupportTicketHandlers.head(request, (await context.params).organizationId); }
