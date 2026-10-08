import { usExportHandlers } from '@/lib/international/export-bindings';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ organizationId: string; kind: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  const { organizationId, kind } = await context.params;
  return usExportHandlers.reports(request, organizationId, kind);
}
