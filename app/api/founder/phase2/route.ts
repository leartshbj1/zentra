import { authenticateFounderCommand } from '@/lib/founder-admin';
import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { parsePhase2Action, PHASE2_DOMAIN, PHASE2_PATH, phase2Read } from '@/lib/phase2-admin';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{
  const action=await authenticateFounderCommand(await readJsonObjectWithinLimit(request,20000),request,PHASE2_PATH,PHASE2_DOMAIN,parsePhase2Action);
  const result=await phase2Read(action);
  return result instanceof Response?result:Response.json(result,{headers:accountNoStoreHeaders()});
}catch(error){return accountJsonError(error)}}
