import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { US_SUPPORT_TRIAGE_MODEL,US_SUPPORT_TRIAGE_RECIPE_VERSION,type UsSupportTriageDecision } from './us-support-triage-contract';
import { hashUsSupportTicketRequest,hashUsSupportRoutingRequest,validateUsSupportTicketRequest,validateUsSupportRoutingRequest,validateUsSupportTicket,
  validateUsSupportTicketsHead,validateUsSupportTicketsProjection,validateUsSupportTicketMutationResult,validateUsSupportRoutingMutationResult,
  type UsSupportTicket,type UsSupportTicketRequest } from './us-support-ticket-contract';

const org=randomUUID(),ws=randomUUID(),user=randomUUID(),id=randomUUID(),job=randomUUID(),now=1_790_000_000;
const decision:UsSupportTriageDecision={schemaVersion:1,category:'billing',priority:'normal',categoryConfidence:0.95,priorityConfidence:0.95,confidence:0.95,language:'en',languageConfidence:0.95,humanRequested:0,reviewReasons:[],needsReview:false,model:US_SUPPORT_TRIAGE_MODEL,recipeVersion:US_SUPPORT_TRIAGE_RECIPE_VERSION};
const create:UsSupportTicketRequest={schemaVersion:1,requestId:randomUUID(),action:'create',jobId:job};
const routing={schemaVersion:1 as const,requestId:randomUUID(),expectedRevision:0,enabled:false,threshold:0.9,routes:[]};
const settings={schemaVersion:1 as const,revision:0,enabled:false,threshold:1,routes:[]};
const head={schemaVersion:1,organizationId:org,userId:user,role:'owner',workspaceId:ws,revision:1,teamRevision:0};
const audit={revision:1,ticketRevision:1,action:'create' as const,actorUserId:user,createdAt:now,category:'billing' as const,priority:'normal' as const,language:'en' as const,assigneeMembershipId:null,status:'open' as const,humanCorrection:false};
const ticket:UsSupportTicket={schemaVersion:1,id,organizationId:org,workspaceId:ws,originJobId:job,uid:'123',createdAt:now,revision:1,category:'billing',priority:'normal',language:'en',originalDecision:decision,reviewReasons:[],needsReview:false,humanCorrection:false,correctedBy:null,assigneeMembershipId:null,assigneeActive:false,status:'open',updatedAt:now,audit:{total:1,events:[audit]}};
const projection={...head,offset:0,nextOffset:null,tickets:[ticket],routing:settings,assignees:[],head:{revision:1,teamRevision:0}};
const list=()=>{const {revision:_r,teamRevision:_t,...p}=projection;return p;};
const receipt={schemaVersion:1,organizationId:org,workspaceId:ws,requestId:create.requestId,actorUserId:user,action:'create',entityId:id,revision:1,headRevision:1,createdAt:now};

describe('strict US Support ticket contracts',()=>{
  it('accepts exact ticket/routing requests and sanitized projections',()=>{expect(validateUsSupportTicketRequest(create)).toEqual(create);expect(validateUsSupportRoutingRequest(routing)).toEqual(routing);expect(validateUsSupportTicket(ticket)).toEqual(ticket);expect(validateUsSupportTicketsHead(head)).toEqual(head);expect(validateUsSupportTicketsProjection(list())).toEqual(list());});
  it.each([{body:'private'},{category:'billing'},{jobId:'bad'},{schemaVersion:2},{action:'send'},{requestId:'bad'}])('rejects create shape %j',patch=>{expect(()=>validateUsSupportTicketRequest({...create,...patch})).toThrow();});
  it.each([{expectedRevision:-1},{enabled:1},{threshold:101},{threshold:NaN},{routes:[{category:'billing',membershipId:'bad'}]},{routes:[{category:'billing',membershipId:user},{category:'billing',membershipId:user}]},{effect:'mail'}])('rejects routing shape %j',patch=>{expect(()=>validateUsSupportRoutingRequest({...routing,...patch})).toThrow();});
  it('accepts closed correction, assignment and status enums only',()=>{
    const base={schemaVersion:1,requestId:randomUUID(),ticketId:id,expectedRevision:1};for(const patch of [{action:'correct',category:'bug',priority:'urgent',language:'fr'},{action:'assign',assigneeMembershipId:null},{action:'assign',assigneeMembershipId:user},{action:'set_status',status:'resolved'}])expect(validateUsSupportTicketRequest({...base,...patch})).toMatchObject(patch);
    for(const patch of [{action:'correct',category:'other',priority:'critical',language:'en'},{action:'set_status',status:'deleted'},{action:'assign',assigneeMembershipId:user,body:'secret'}])expect(()=>validateUsSupportTicketRequest({...base,...patch})).toThrow();
  });
  it.each([{id:'invalid',correctedBy:user,humanCorrection:true},{createdAt:-1,correctedBy:user,humanCorrection:true},{role:'owner'},{humanCorrection:true,correctedBy:null},{humanCorrection:false,correctedBy:user},{category:'bug'},{assigneeActive:true},{originalDecision:{...decision,model:'jev-latest'}},{reviewReasons:['unread_attachments']},{needsReview:true}])('rejects malformed ticket state %j',patch=>{expect(()=>validateUsSupportTicket({...ticket,...patch})).toThrow();});
  it.each([{total:2,events:[audit]},{total:1,events:[{...audit,ticketRevision:2}]},{total:1,events:[{...audit,category:'bug'}]},{total:1,events:[{...audit,createdAt:now+1}]},{total:1,events:[{...audit,action:'correct'}]},{total:1,events:[{...audit,body:'secret'}]}])('rejects inconsistent visible audit %j',audit=>{expect(()=>validateUsSupportTicket({...ticket,audit})).toThrow();});
  it('checks contiguous recent audit and the current snapshot after correction',()=>{
    const corrected={...audit,revision:3,ticketRevision:2,action:'correct',category:'bug',humanCorrection:true,createdAt:now+1};const t={...ticket,revision:2,category:'bug',humanCorrection:true,correctedBy:user,updatedAt:now+1,audit:{total:2,events:[corrected,audit]}};
    expect(validateUsSupportTicket(t).revision).toBe(2);expect(()=>validateUsSupportTicket({...t,audit:{total:2,events:[corrected,{...audit,revision:4}]}})).toThrow();expect(()=>validateUsSupportTicket({...t,audit:{total:2,events:[corrected,{...audit,createdAt:now+2}]}})).toThrow();
  });
  it('keeps original receipt revision separate from current projection',()=>{expect(validateUsSupportTicketMutationResult({ticket,receipt,replayed:true}).receipt.revision).toBe(1);expect(()=>validateUsSupportTicketMutationResult({ticket,receipt:{...receipt,entityId:job},replayed:true})).toThrow();expect(()=>validateUsSupportRoutingMutationResult({routing:settings,receipt,replayed:true})).toThrow();});
  it('rejects tenant mismatch and private projection fields',()=>{expect(()=>validateUsSupportTicket(ticket,randomUUID())).toThrow();expect(()=>validateUsSupportTicketsProjection({...list(),source_json:'secret'})).toThrow();expect(()=>validateUsSupportTicketsHead({...head,credential:{kind:'browser'}})).toThrow();});
  it('hashes full exact requests in actor/tenant/kind domains',async()=>{const hash=await hashUsSupportTicketRequest(org,ws,user,create);expect(await hashUsSupportTicketRequest(org,ws,user,{...create})).toBe(hash);expect(await hashUsSupportTicketRequest(org,ws,randomUUID(),create)).not.toBe(hash);expect(await hashUsSupportTicketRequest(randomUUID(),ws,user,create)).not.toBe(hash);expect(await hashUsSupportRoutingRequest(org,ws,user,{...routing,requestId:create.requestId})).not.toBe(hash);});
});
