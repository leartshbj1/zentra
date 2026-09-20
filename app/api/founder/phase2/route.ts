import { authenticateFounderCommand } from '@/lib/founder-admin';
import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { parsePhase2Action, PHASE2_DOMAIN, PHASE2_PATH, phase2Read } from '@/lib/phase2-admin';
import { AccountPublicError } from '@/lib/account-security';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{
  const action=await authenticateFounderCommand(await readJsonObjectWithinLimit(request,20000),request,PHASE2_PATH,PHASE2_DOMAIN,parsePhase2Action);
  let result;
  try{result=await phase2Read(action);}catch(error){
    if(error instanceof AccountPublicError)throw error;
    const message=error instanceof Error?error.message:'Erreur de lecture';
    throw new AccountPublicError(`Diagnostic administrateur (${action.operation}): ${message.replace(/sb_secret_[A-Za-z0-9_-]+/g,'[secret]').slice(0,500)}`,502);
  }
  return result instanceof Response?result:Response.json(result,{headers:accountNoStoreHeaders()});
}catch(error){return accountJsonError(error)}}
