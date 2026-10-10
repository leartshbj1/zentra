import { usSupplierDocumentHandlers } from '@/lib/international/us-supplier-document-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> { return usSupplierDocumentHandlers.GET(request, (await context.params).organizationId); }
