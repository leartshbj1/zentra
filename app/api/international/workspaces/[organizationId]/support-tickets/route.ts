import { usSupportTicketHandlers } from '@/lib/international/us-support-ticket-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context) { return usSupportTicketHandlers.read(request, (await context.params).organizationId); }
export async function POST(request: Request, context: Context) { return usSupportTicketHandlers.write(request, (await context.params).organizationId); }
