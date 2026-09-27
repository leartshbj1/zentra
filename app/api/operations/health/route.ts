import { operationsHealth, requireOperationsMonitor } from '@/lib/operations-health';
import { SupportError } from '@/lib/support/types';
import { reportServiceFailure } from '@/lib/service-diagnostics';
export const dynamic = 'force-dynamic';
const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex'};

export async function GET(request: Request) {
  try {
    await requireOperationsMonitor(request);
    const health = await operationsHealth();
    return Response.json(health,{status:health.state==='healthy'?200:503,headers});
  } catch(error) {
    if(error instanceof SupportError && error.status===401) return Response.json({error:'Accès refusé.'},{status:401,headers});
    const reference=reportServiceFailure(error,{operation:'operations.health',request});
    return Response.json({state:'unavailable',...(reference?{reference}:{})},{status:503,headers});
  }
}
