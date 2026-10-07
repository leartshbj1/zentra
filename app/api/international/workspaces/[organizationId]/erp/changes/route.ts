import { erpSyncHandlers } from '@/lib/international/runtime-bindings';
export async function GET(request:Request,{params}:{params:Promise<{organizationId:string}>}){
  return erpSyncHandlers.changes(request,(await params).organizationId);
}
