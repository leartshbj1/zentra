import { getZentraUser } from '@/app/zentra-auth';
import { startAccountTrial } from '@/lib/account-trial';
import { enforceAccountRateLimit } from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { hasCurrentLegalAcceptance, LEGAL_VERSION } from '@/lib/legal';
import { database } from '@/lib/runtime';
import { authJsonError, authNoStoreHeaders, AuthPublicError, requireAuthSameOrigin } from '@/lib/supabase-auth-http';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{
  const origin=requireAuthSameOrigin(request,{requireOrigin:true});
  const user=await getZentraUser({refreshSession:true});
  if(!user||!user.emailConfirmed)throw new AuthPublicError('Confirmez votre adresse e-mail et connectez-vous pour commencer.',401);
  const body=await readJsonObjectWithinLimit(request,4096);
  if(!hasCurrentLegalAcceptance(body))throw new AuthPublicError('Acceptez les conditions pour commencer votre essai.');
  await enforceAccountRateLimit(request,'account-trial',user.userId,5);
  const trial=await startAccountTrial(user,typeof body.companyName==='string'?body.companyName:'');
  await database().prepare('INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING')
    .bind(`trial_${user.userId}`,user.userId,LEGAL_VERSION,'gestion_trial','solo',trial.subscription_id,origin,new Date().toISOString()).run();
  return Response.json({created:true,organizationId:trial.organization_id,endsAt:trial.ends_at},{headers:authNoStoreHeaders()});
}catch(error){return authJsonError(error)}}
