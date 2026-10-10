import { usSupplierDocumentHandlers } from '@/lib/international/us-supplier-document-bindings';
type Context = { params: Promise<{ organizationId: string; id: string }> };
export async function POST(request: Request, context: Context): Promise<Response> { const { organizationId, id } = await context.params; return usSupplierDocumentHandlers.ANALYZE(request, organizationId, id); }
