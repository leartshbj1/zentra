import { usAnalysisSettingsHandlers } from '@/lib/international/us-supplier-analysis-bindings';
type Context = {params:Promise<{organizationId:string}>};
export async function GET(request:Request,context:Context):Promise<Response>{return usAnalysisSettingsHandlers.GET(request,(await context.params).organizationId);}
export async function POST(request:Request,context:Context):Promise<Response>{return usAnalysisSettingsHandlers.POST(request,(await context.params).organizationId);}
