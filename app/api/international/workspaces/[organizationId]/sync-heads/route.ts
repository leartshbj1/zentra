import { usWorkspaceSyncHeadsHandlers } from '@/lib/international/us-workspace-sync-heads-bindings';
export async function GET(request: Request, { params }: { params: Promise<{ organizationId: string }> }) {
  return usWorkspaceSyncHeadsHandlers.GET(request, (await params).organizationId);
}
