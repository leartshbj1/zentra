import { getZentraUser } from '@/app/zentra-auth';
import { automationActor } from '@/lib/automation/access';
import { subscriptionJourney,skipJourneyStep } from '@/lib/complete/journey';
import { quotePlanChange,changePlan } from '@/lib/complete/change';
import { accountJsonError,accountNoStoreHeaders,enforceAccountRateLimit } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { PublicError } from '@/lib/stripe';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { database } from '@/lib/runtime';
export const dynamic='force-dynamic';
const failure=(e:unknown)=>accountJsonError(e instanceof PublicError?new AccountPublicError(e.message,e.status):e);
export async function GET(request:Request){try{
  const actor=await automationActor(request,new URL(request.url).searchParams.get('organizationId'));
  return Response.json(await subscriptionJourney(actor),{headers:accountNoStoreHeaders()});
}catch(e){return failure(e)}}
export async function POST(request:Request){try{
  const body=await readJsonObjectWithinLimit(request,4096),actor=await automationActor(request,body.organizationId);
  await enforceAccountRateLimit(request,'subscription-change',actor.userId,12);
  if(body.action==='skip'){
    await skipJourneyStep(actor,body.step,body.skip!==false);
    return Response.json(await subscriptionJourney(actor),{headers:accountNoStoreHeaders()});
  }
  // Purchases stay in the secure browser; a native bearer cannot authorize billing.
  if(actor.device||actor.role!=='owner')throw new AccountPublicError('Ouvrez l’abonnement sur le site avec le compte propriétaire.',403);
  const user=await getZentraUser({refreshSession:true});
  if(!user?.emailConfirmed||user.userId!==actor.userId)throw new AccountPublicError('Confirmez votre adresse e-mail avant de continuer.',403);
  if(body.action==='quote'){
    const {snapshot:_snapshot,...quote}=await quotePlanChange(actor.userId,actor.organizationId,body.plan);
    return Response.json(quote,{headers:accountNoStoreHeaders()});
  }
  if(body.action!=='change'||body.acceptTerms!==true||body.legalVersion!==COMPLETE_TERMS_VERSION)throw new AccountPublicError('Relisez et confirmez la formule et les conditions avant de continuer.');
  await database().prepare('INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),user.userId,COMPLETE_TERMS_VERSION,'complete_change',String(body.plan),new URL(request.url).origin,new Date().toISOString()).run();
  const result=await changePlan(user.userId,actor.organizationId,body.plan,body.fingerprint);
  return Response.json(result,{headers:accountNoStoreHeaders()});
}catch(e){return failure(e)}}
