import { usTeamHandlers } from '@/lib/international/us-team-bindings';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{organizationId:string}>}){return usTeamHandlers.read(request,(await params).organizationId);}
export async function POST(request:Request,{params}:{params:Promise<{organizationId:string}>}){return usTeamHandlers.write(request,(await params).organizationId);}
