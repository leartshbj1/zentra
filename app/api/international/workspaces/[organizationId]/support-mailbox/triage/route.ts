import { usSupportTriageHandlers } from '@/lib/international/us-support-triage-bindings';
type Context = { params: Promise<{organizationId:string}> };
export async function GET(request: Request,context: Context) { return usSupportTriageHandlers.read(request,(await context.params).organizationId); }
export async function POST(request: Request,context: Context) { return usSupportTriageHandlers.triage(request,(await context.params).organizationId); }
