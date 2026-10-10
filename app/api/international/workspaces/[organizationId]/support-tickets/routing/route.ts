import { usSupportTicketHandlers } from '@/lib/international/us-support-ticket-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function POST(request: Request, context: Context) { return usSupportTicketHandlers.routing(request, (await context.params).organizationId); }
