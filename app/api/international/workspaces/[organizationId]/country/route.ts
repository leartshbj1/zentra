import { workspaceCountryHandlers } from '@/lib/international/workspace-server';

type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return workspaceCountryHandlers.GET(request, (await context.params).organizationId);
}
export async function PUT(request: Request, context: Context): Promise<Response> {
  return workspaceCountryHandlers.PUT(request, (await context.params).organizationId);
}
