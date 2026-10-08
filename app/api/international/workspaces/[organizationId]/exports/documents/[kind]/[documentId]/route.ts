import { usExportHandlers } from '@/lib/international/export-bindings';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ organizationId: string; kind: string; documentId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  const { organizationId, kind, documentId } = await context.params;
  return usExportHandlers.documents(request, organizationId, kind, documentId);
}
