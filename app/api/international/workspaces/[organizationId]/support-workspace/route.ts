import { usSupportWorkspaceHandlers } from '@/lib/international/us-support-workspace-bindings';

type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context) {
  return usSupportWorkspaceHandlers.read(request, (await context.params).organizationId);
}
export async function POST(request: Request, context: Context) {
  return usSupportWorkspaceHandlers.create(request, (await context.params).organizationId);
}
