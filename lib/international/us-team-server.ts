import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { canonicalErpJson } from './erp-contract';
import { creationUuid } from './workspace-creation';
import { US_TEAM_INVITATION_TTL_SECONDS, UsTeamError, type UsTeamContext, type UsTeamInvitation, type UsTeamPrivateCommand, type UsTeamStore, type UsTeamUser } from './us-team-contract';
import { hashUsTeamCommand, hashUsTeamToken, newUsTeamToken, normalizeUsTeamEmail, usTeamCanManageRole, validateUsTeamAcceptRequest, validateUsTeamAcceptResponse, validateUsTeamCommitResult, validateUsTeamContext, validateUsTeamInvitation, validateUsTeamMutationResponse, validateUsTeamProjection, validateUsTeamRequest, validateUsTeamResolution, validateUsTeamResolveRequest, validateUsTeamStoredReceipt, validateUsTeamUser } from './us-team-validation';

export interface UsTeamDependencies {
  enabled():Promise<boolean>;
  member(request:Request,organizationId:string):Promise<UsTeamContext>;
  recipientUser(request:Request):Promise<UsTeamUser>;
  recipient(request:Request,invitation:UsTeamInvitation):Promise<{context:UsTeamContext;organizationName:string}>;
  store():Promise<UsTeamStore> | UsTeamStore;
  now():number;
  newId():string;
  rateLimit?(request:Request,operation:string,key:string):Promise<void>;
  diagnostic?(event:{operation:string;code:string;status:number}):void;
}
const headers={'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'};
const codes:Readonly<Record<string,number>>={
  invalid_team_request:422,invalid_team_record:503,invalid_team_context:503,service_unavailable:503,
  unauthorized:401,session_changed:401,forbidden:403,tenant_mismatch:403,subscription_required:402,
  feature_unavailable:404,configuration_changed:409,team_management_required:403,
  team_revision_conflict:409,team_idempotency_conflict:409,team_seat_limit_reached:409,
  team_owner_protected:409,team_member_protected:409,team_invitation_unavailable:409,
  invitation_unavailable:409,invitation_recipient_mismatch:403,email_confirmation_required:403,rate_limited:429,
};
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers});
function safeError(error:unknown){
  if(error instanceof UsTeamError && Object.hasOwn(codes,error.code) && codes[error.code]===error.status)return {code:error.code,status:error.status};
  if(error instanceof RequestBodyError)return {code:'invalid_team_request',status:error.status};
  if(error instanceof AccountPublicError && [401,402,403,429].includes(error.status))return {code:error.status===401?'unauthorized':error.status===402?'subscription_required':error.status===429?'rate_limited':'forbidden',status:error.status};
  return {code:'service_unavailable',status:503};
}
function expectedUser(request:Request,context:UsTeamContext){
  const expected=request.headers.get('X-Zentra-Expected-User');
  if(expected!==null && expected!==context.user.userId)throw new UsTeamError('session_changed',401);
}
function sameContext(before:UsTeamContext,after:UsTeamContext){
  if(before.user.userId!==after.user.userId || before.mode!==after.mode || canonicalErpJson(before.credential??null)!==canonicalErpJson(after.credential??null))throw new UsTeamError('session_changed',401);
  if(before.organizationId!==after.organizationId)throw new UsTeamError('tenant_mismatch',403);
  if(before.role!==after.role)throw new UsTeamError('forbidden',403);
  if(before.subscriptionId!==after.subscriptionId)throw new UsTeamError('subscription_required',402);
  const stable=(c:UsTeamContext)=>({ ...c,checkedAt:0 });
  if(canonicalErpJson(stable(before))!==canonicalErpJson(stable(after)))throw new UsTeamError('configuration_changed',409);
}
/** Independent team head: no ledger, ERP initialization, provider or e-mail
 * send. A commit can outlive a lost HTTP response; retry the same requestId. */
export function createUsTeamHandlers(dependencies:UsTeamDependencies){
  const clock=()=>{const now=dependencies.now();if(!Number.isSafeInteger(now)||now<=0)throw new UsTeamError('service_unavailable',503);return now;};
  async function run(operation:'read'|'write'|'resolve'|'accept',request:Request,organizationId?:string){
    let admitted:UsTeamContext|undefined;
    let recipientIdentity:UsTeamUser|undefined;
    let originalInvitation:UsTeamInvitation|undefined;
    let organizationName='';
    async function current(){
      if(!admitted)throw new UsTeamError('unauthorized',401);
      let next:UsTeamContext;
      if(admitted.mode==='member')next=await dependencies.member(request,admitted.organizationId);
      else {
        if(!originalInvitation)throw new UsTeamError('invitation_unavailable',409);
        const recipient=await dependencies.recipient(request,originalInvitation);
        if(recipient.organizationName!==organizationName)throw new UsTeamError('configuration_changed',409);
        next=recipient.context;
      }
      const captured=validateUsTeamContext(next,admitted.organizationId,clock());
      expectedUser(request,captured);sameContext(admitted,captured);
      if(!await dependencies.enabled())throw new UsTeamError('feature_unavailable',404);
      return captured;
    }
    try {
      if(new URL(request.url).search || request.method!==(operation==='read'?'GET':'POST'))throw new UsTeamError('invalid_team_request',422);
      if(!await dependencies.enabled())throw new UsTeamError('feature_unavailable',404);
      const isRecipient=operation==='resolve'||operation==='accept';
      // Recipient links always use verified browser identity, never a device or
      // an attacker supplied e-mail as a substitute for Auth.
      if(isRecipient){if(request.headers.has('Authorization'))throw new UsTeamError('unauthorized',401);requireAccountSameOrigin(request);}
      const store=await dependencies.store();
      if(!isRecipient){
        try{creationUuid(organizationId);}catch{throw new UsTeamError('invalid_team_request',422);}
        admitted=validateUsTeamContext(await dependencies.member(request,organizationId!),organizationId,clock());
        if(admitted.mode!=='member')throw new UsTeamError('invalid_team_context',503);
        expectedUser(request,admitted);
        if(operation==='write' && !request.headers.has('Authorization'))requireAccountSameOrigin(request);
        if(operation==='write' && !['owner','admin'].includes(admitted.role))throw new UsTeamError('team_management_required',403);
      }
      if(operation==='read'){
        await dependencies.rateLimit?.(request,operation,admitted!.organizationId+':'+admitted!.user.userId);
        const before=await current(),team=validateUsTeamProjection(await store.read(before),before.organizationId);
        if(team.role!==before.role)throw new UsTeamError('invalid_team_record',503);
        await current();return reply(team);
      }
      const body=await readJsonObjectWithinLimit(request,8192);
      if(isRecipient){
        const identity=validateUsTeamUser(await dependencies.recipientUser(request));
        recipientIdentity=identity;
        if(!identity.emailConfirmed||identity.email===null)throw new UsTeamError('email_confirmation_required',403);
        const expected=request.headers.get('X-Zentra-Expected-User');
        if(expected!==null&&expected!==identity.userId)throw new UsTeamError('session_changed',401);
        await dependencies.rateLimit?.(request,operation,identity.userId);
        const input=operation==='resolve'?validateUsTeamResolveRequest(body):validateUsTeamAcceptRequest(body);
        const found=await store.find(await hashUsTeamToken(input.token));
        if(!found)throw new UsTeamError('invitation_unavailable',409);
        originalInvitation=validateUsTeamInvitation(found);
        const recipient=await dependencies.recipient(request,originalInvitation);
        organizationName=recipient.organizationName;
        admitted=validateUsTeamContext(recipient.context,originalInvitation.organizationId,clock());
        if(admitted.user.userId!==identity.userId)throw new UsTeamError('session_changed',401);
        if(admitted.mode!=='recipient')throw new UsTeamError('invalid_team_context',503);
        expectedUser(request,admitted);
        if(!admitted.user.emailConfirmed || admitted.user.email===null)throw new UsTeamError('email_confirmation_required',403);
        if(normalizeUsTeamEmail(admitted.user.email)!==originalInvitation.email)throw new UsTeamError('invitation_recipient_mismatch',403);
        if(admitted.role!==originalInvitation.role)throw new UsTeamError('invalid_team_context',503);
        const before=await current();
        if(operation==='resolve'){
          if(originalInvitation.status!=='pending'||originalInvitation.expiresAt<=clock())throw new UsTeamError('invitation_unavailable',409);
          const revision=await store.revision(before);
          await current();
          const fresh=await store.find(originalInvitation.tokenHash);
          if(!fresh || canonicalErpJson(validateUsTeamInvitation(fresh))!==canonicalErpJson(originalInvitation))throw new UsTeamError('invitation_unavailable',409);
          await current();
          return reply(validateUsTeamResolution({schemaVersion:1,organizationId:before.organizationId,organizationName,invitationId:originalInvitation.invitationId,role:originalInvitation.role,expiresAt:originalInvitation.expiresAt,teamRevision:revision}));
        }
        const accepted=validateUsTeamAcceptRequest(body);
        const command:UsTeamPrivateCommand={schemaVersion:1,requestId:accepted.requestId,expectedTeamRevision:accepted.expectedTeamRevision,action:'accept_invitation',invitationId:originalInvitation.invitationId,tokenHash:originalInvitation.tokenHash,membershipId:creationUuid(dependencies.newId()),firstName:accepted.firstName,lastName:accepted.lastName,displayName:accepted.firstName+' '+accepted.lastName};
        const requestHash=await hashUsTeamCommand(before.organizationId,before.user.userId,command);
        const historical=await store.receipt(before,command.requestId);
        if(historical){
          const saved=validateUsTeamStoredReceipt(historical,before.organizationId);
          if(saved.actorUserId!==before.user.userId||saved.requestHash!==requestHash)throw new UsTeamError('team_idempotency_conflict',409);
          await current();return reply(validateUsTeamAcceptResponse({receipt:saved.receipt,replayed:true},before.organizationId));
        }
        if(originalInvitation.status!=='pending'||originalInvitation.expiresAt<=clock())throw new UsTeamError('invitation_unavailable',409);
        const result=validateUsTeamCommitResult(await store.commit({context:await current(),command,requestHash}),before.organizationId);
        if(result.receipt.requestId!==command.requestId||result.receipt.action!=='accept_invitation'||result.receipt.revision!==command.expectedTeamRevision+1||result.firstApplied&&result.receipt.entityId!==command.membershipId)throw new UsTeamError('invalid_team_record',503);
        await current();return reply(validateUsTeamAcceptResponse({receipt:result.receipt,replayed:result.replayed},before.organizationId));
      }
      const input=validateUsTeamRequest(body),before=await current();
      await dependencies.rateLimit?.(request,operation,before.organizationId+':'+before.user.userId);
      if(input.action==='create_invitation'&&!usTeamCanManageRole(before.role,input.role))throw new UsTeamError('team_management_required',403);
      let token:string|undefined,command:UsTeamPrivateCommand;
      if(input.action==='create_invitation'||input.action==='regenerate_invitation'){
        token=newUsTeamToken();
        const artifact={tokenHash:await hashUsTeamToken(token),expiresAt:before.checkedAt+US_TEAM_INVITATION_TTL_SECONDS};
        command=input.action==='create_invitation'?{...input,...artifact,invitationId:creationUuid(dependencies.newId())}:{...input,...artifact,newInvitationId:creationUuid(dependencies.newId())};
      } else if(input.action==='revoke_invitation')command={...input,action:'revoke_invitation'};
      else if(input.action==='revoke_member')command=input;
      else throw new UsTeamError('invalid_team_request',422);
      const requestHash=await hashUsTeamCommand(before.organizationId,before.user.userId,command);
      const result=validateUsTeamCommitResult(await store.commit({context:await current(),command,requestHash}),before.organizationId);
      if(result.receipt.requestId!==command.requestId||result.receipt.action!==command.action||result.receipt.revision!==command.expectedTeamRevision+1)throw new UsTeamError('invalid_team_record',503);
      const after=await current(),team=validateUsTeamProjection(await store.read(after),after.organizationId);
      if(team.role!==after.role||team.revision<result.receipt.revision)throw new UsTeamError('invalid_team_record',503);
      let invitationLink:string|undefined;
      if(result.firstApplied && token && (command.action==='create_invitation'||command.action==='regenerate_invitation')){
        const id=command.action==='create_invitation'?command.invitationId:command.newInvitationId;
        if(result.receipt.entityId!==id)throw new UsTeamError('invalid_team_record',503);
        const saved=await store.invitation(after,id);
        if(saved){const invitation=validateUsTeamInvitation(saved,after.organizationId);if(invitation.status==='pending'&&invitation.expiresAt>clock()&&invitation.tokenHash===command.tokenHash)invitationLink='/invitation/us#token='+token;}
      }
      await current();return reply(validateUsTeamMutationResponse({team,receipt:result.receipt,replayed:result.replayed,...(invitationLink?{invitationLink}:{})},after.organizationId));
    } catch(error){
      let safe=safeError(error);
      if(admitted){try{await current();}catch(delayed){const fresh=safeError(delayed);if([401,402,403,404].includes(fresh.status))safe=fresh;}}
      else if(recipientIdentity){try{const fresh=validateUsTeamUser(await dependencies.recipientUser(request));if(fresh.userId!==recipientIdentity.userId)safe={code:'session_changed',status:401};else if(fresh.email!==recipientIdentity.email||!fresh.emailConfirmed)safe={code:'email_confirmation_required',status:403};}catch(delayed){const fresh=safeError(delayed);if([401,402,403,404].includes(fresh.status))safe=fresh;}}
      // Only a closed code vocabulary; never raw exceptions, recipient names,
      // e-mail addresses, URLs, request bodies or invitation secrets.
      try{dependencies.diagnostic?.({operation,code:safe.code,status:safe.status});}catch{ /* Diagnostics cannot alter public failure. */ }
      return reply({error:safe.code},safe.status);
    }
  }
  return {read:(request:Request,org:string)=>run('read',request,org),write:(request:Request,org:string)=>run('write',request,org),resolve:(request:Request)=>run('resolve',request),accept:(request:Request)=>run('accept',request)};
}
