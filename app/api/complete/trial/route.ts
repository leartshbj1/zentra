import { getZentraUser } from '@/app/zentra-auth';
import { startAccountTrial } from '@/lib/account-trial';
import { enforceAccountRateLimit } from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { database } from '@/lib/runtime';
import { authJsonError, authNoStoreHeaders, AuthPublicError, requireAuthSameOrigin } from '@/lib/supabase-auth-http';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{
  requireAuthSameOrigin(request,{requireOrigin:true});
  const origin=new URL(request.url).origin;
  const user=await getZentraUser({refreshSession:true});
  if(!user?.emailConfirmed)throw new AuthPublicError('Confirmez votre adresse e-mail et connectez-vous pour commencer.',401);
  const body=await readJsonObjectWithinLimit(request,4096);
  if(body.acceptTerms!==true||body.legalVersion!==COMPLETE_TERMS_VERSION)throw new AuthPublicError('Acceptez les conditions du pack pour commencer votre essai.');
  await enforceAccountRateLimit(request,'complete-trial',user.userId,5);
  const trial=await startAccountTrial(user,typeof body.companyName==='string'?body.companyName:'',true);
  await database().prepare('INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(acceptance_id) DO NOTHING')
    .bind(`complete_trial_${user.userId}`,user.userId,COMPLETE_TERMS_VERSION,'complete_trial','team',origin,new Date().toISOString()).run();
  return Response.json({created:true,organizationId:trial.organization_id,endsAt:trial.ends_at},{headers:authNoStoreHeaders()});
}catch(error){return authJsonError(error)}}
