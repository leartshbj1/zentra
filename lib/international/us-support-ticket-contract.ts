import { ACCOUNT_ROLES, type AccountRole } from '../account-security';
import { CATEGORIES, PRIORITIES, type Category, type Priority } from '../support/types';
import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { sha256Hex } from './canonical-hash';
import { validateUsSupportTriageDecision, type UsSupportTriageDecision } from './us-support-triage-contract';
import { isUsSupportWorkerContext, type UsSupportExecutionContext } from './us-support-execution-contract';

export const US_SUPPORT_TICKETS_PAGE_SIZE = 25;
export const US_SUPPORT_TICKET_AUDIT_LIMIT = 100;
export const US_SUPPORT_TICKET_AUDIT_PAGE_SIZE = 20;
/** Local pilot storage limit, independent of any commercial allowance. */
export const US_SUPPORT_TICKET_COMMAND_LIMIT = 52_000;
export type UsSupportTicketContext = UsSupportExecutionContext;
export type UsSupportTicketStatus = 'open' | 'in_progress' | 'resolved';
export type UsSupportTicketLanguage = UsSupportTriageDecision['language'];
export type UsSupportTicketAction = 'create' | 'correct' | 'assign' | 'set_status';
export class UsSupportTicketError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'UsSupportTicketError'; }
}
interface RequestBase { readonly schemaVersion: 1; readonly requestId: string }
interface ExistingRequest extends RequestBase { readonly ticketId: string; readonly expectedRevision: number }
export type UsSupportTicketRequest =
  | (RequestBase & Readonly<{action:'create';jobId:string}>)
  | (ExistingRequest & Readonly<{action:'correct';category:Category;priority:Priority;language:UsSupportTicketLanguage}>)
  | (ExistingRequest & Readonly<{action:'assign';assigneeMembershipId:string|null}>)
  | (ExistingRequest & Readonly<{action:'set_status';status:UsSupportTicketStatus}>);
export interface UsSupportRoute { readonly category: Category; readonly membershipId: string }
export interface UsSupportRoutingRequest extends RequestBase {
  readonly expectedRevision: number; readonly enabled: boolean; readonly threshold: number; readonly routes: readonly UsSupportRoute[];
}
export interface UsSupportRouting {
  readonly schemaVersion: 1; readonly revision: number; readonly enabled: boolean; readonly threshold: number; readonly routes: readonly UsSupportRoute[];
}
export interface UsSupportTicketAssignee {
  readonly membershipId: string; readonly userId: string; readonly role: 'owner'|'admin'|'member'; readonly displayName: string|null;
}
export interface UsSupportTicketAudit {
  readonly revision: number; readonly ticketRevision: number; readonly action: UsSupportTicketAction; readonly actorUserId: string; readonly createdAt: number;
  readonly actorKind?:'worker'; readonly delegationId?:string; readonly delegationRevision?:number; readonly runId?:string;
  readonly category: Category; readonly priority: Priority; readonly language: UsSupportTicketLanguage;
  readonly assigneeMembershipId: string|null; readonly status: UsSupportTicketStatus; readonly humanCorrection: boolean;
}
/** Sanitized company-shared workflow. Provider locators, source hashes, body,
 * credentials and private H1 contexts never enter this projection. */
export interface UsSupportTicket {
  readonly schemaVersion: 1; readonly id: string; readonly organizationId: string; readonly workspaceId: string; readonly originJobId: string; readonly uid: string;
  readonly createdAt: number; readonly revision: number; readonly category: Category; readonly priority: Priority; readonly language: UsSupportTicketLanguage;
  readonly originalDecision: UsSupportTriageDecision; readonly reviewReasons: UsSupportTriageDecision['reviewReasons']; readonly needsReview: boolean;
  readonly humanCorrection: boolean; readonly correctedBy: string|null; readonly assigneeMembershipId: string|null; readonly assigneeActive: boolean;
  readonly status: UsSupportTicketStatus; readonly updatedAt: number;
  readonly audit: Readonly<{total:number;events:readonly UsSupportTicketAudit[]}>;
}
export interface UsSupportTicketsHead {
  readonly schemaVersion: 1; readonly organizationId: string; readonly userId: string; readonly role: AccountRole; readonly workspaceId: string;
  readonly revision: number; readonly teamRevision: number;
}
export interface UsSupportTicketsProjection {
  readonly schemaVersion: 1; readonly organizationId: string; readonly userId: string; readonly role: AccountRole; readonly workspaceId: string;
  readonly offset: number; readonly nextOffset: number|null; readonly tickets: readonly UsSupportTicket[]; readonly routing: UsSupportRouting;
  readonly assignees: readonly UsSupportTicketAssignee[]; readonly head: Readonly<{revision:number;teamRevision:number}>;
}
export interface UsSupportTicketReceipt {
  readonly schemaVersion: 1; readonly organizationId: string; readonly workspaceId: string; readonly requestId: string; readonly actorUserId: string;
  readonly action: UsSupportTicketAction|'save_routing'; readonly entityId: string; readonly revision: number; readonly headRevision: number; readonly createdAt: number;
}
export interface UsSupportTicketMutationResult { readonly ticket: UsSupportTicket; readonly receipt: UsSupportTicketReceipt; readonly replayed: boolean }
export interface UsSupportRoutingMutationResult { readonly routing: UsSupportRouting; readonly receipt: UsSupportTicketReceipt; readonly replayed: boolean }
export type UsSupportTicketStoredResult = (UsSupportTicketMutationResult & Readonly<{kind:'ticket'}>) | (UsSupportRoutingMutationResult & Readonly<{kind:'routing'}>);
type Revalidate = () => Promise<UsSupportTicketContext>;
export interface UsSupportTicketStore {
  read(this:void,context:UsSupportTicketContext,offset?:number):Promise<UsSupportTicketsProjection>;
  head(this:void,context:UsSupportTicketContext):Promise<UsSupportTicketsHead>;
  find(this:void,context:UsSupportTicketContext,requestId:string,requestHash:string):Promise<UsSupportTicketStoredResult|null>;
  commit(this:void,context:UsSupportTicketContext,request:UsSupportTicketRequest,revalidate:Revalidate):Promise<UsSupportTicketMutationResult>;
  saveRouting(this:void,context:UsSupportTicketContext,request:UsSupportRoutingRequest,revalidate:Revalidate):Promise<UsSupportRoutingMutationResult>;
}
const fail=(code='invalid_ticket_request',status=422):never=>{throw new UsSupportTicketError(code,status);};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER-1):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const second=(v:unknown):v is number=>integer(v,1,253_402_300_799);
const unit=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
const category=(v:unknown):v is Category=>typeof v==='string'&&Object.hasOwn(CATEGORIES,v);
const priority=(v:unknown):v is Priority=>typeof v==='string'&&Object.hasOwn(PRIORITIES,v);
const language=(v:unknown):v is UsSupportTicketLanguage=>typeof v==='string'&&['fr','de','it','en','other'].includes(v);
const status=(v:unknown):v is UsSupportTicketStatus=>typeof v==='string'&&['open','in_progress','resolved'].includes(v);
function exact(input:unknown,keys:readonly string[]):Record<string,unknown>{const v=snapshotPrivateJson(input);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))return fail();return v as Record<string,unknown>;}
function privateValue<T>(read:()=>T):T{try{return read();}catch{return fail('invalid_ticket_record',503);}}
export function validateUsSupportTicketRequest(input:unknown):UsSupportTicketRequest{
  try{
    const raw=snapshotPrivateJson(input) as Record<string,unknown>,action=raw?.action;
    const common=action==='create'?['schemaVersion','requestId','action','jobId']:['schemaVersion','requestId','action','ticketId','expectedRevision'];
    const fields=action==='correct'?['category','priority','language']:action==='assign'?['assigneeMembershipId']:action==='set_status'?['status']:[];
    const v=exact(raw,[...common,...fields]);
    if(v.schemaVersion!==1||!id(v.requestId)||!['create','correct','assign','set_status'].includes(String(action)))return fail();
    if(action==='create'){if(!id(v.jobId))return fail();}
    else if(!id(v.ticketId)||!integer(v.expectedRevision,1))return fail();
    if(action==='correct'&&(!category(v.category)||!priority(v.priority)||!language(v.language))||action==='assign'&&v.assigneeMembershipId!==null&&!id(v.assigneeMembershipId)||action==='set_status'&&!status(v.status))return fail();
    return v as unknown as UsSupportTicketRequest;
  }catch{return fail();}
}
function routes(input:unknown):readonly UsSupportRoute[]{
  if(!Array.isArray(input)||input.length>Object.keys(CATEGORIES).length)return fail();
  const seen=new Set<string>();return input.map(raw=>{const v=exact(raw,['category','membershipId']);if(!category(v.category)||!id(v.membershipId)||seen.has(v.category))return fail();seen.add(v.category);return v as unknown as UsSupportRoute;});
}
export function validateUsSupportRoutingRequest(input:unknown):UsSupportRoutingRequest{
  try{const v=exact(input,['schemaVersion','requestId','expectedRevision','enabled','threshold','routes']);if(v.schemaVersion!==1||!id(v.requestId)||!integer(v.expectedRevision)||typeof v.enabled!=='boolean'||!unit(v.threshold))return fail();return {...v,routes:routes(v.routes)} as unknown as UsSupportRoutingRequest;}catch{return fail();}
}
export function validateUsSupportRouting(input:unknown):UsSupportRouting{return privateValue(()=>{const v=exact(input,['schemaVersion','revision','enabled','threshold','routes']);if(v.schemaVersion!==1||!integer(v.revision)||typeof v.enabled!=='boolean'||!unit(v.threshold))return fail();return {...v,routes:routes(v.routes)} as unknown as UsSupportRouting;});}
export function validateUsSupportTicketAudit(input:unknown):UsSupportTicketAudit{return privateValue(()=>{const copied=snapshotPrivateJson(input) as Record<string,unknown>,worker=copied&&Object.hasOwn(copied,'actorKind'),v=exact(copied,['revision','ticketRevision','action','actorUserId','createdAt','category','priority','language','assigneeMembershipId','status','humanCorrection',...(worker?['actorKind','delegationId','delegationRevision','runId']:[])]);if(!integer(v.revision,1)||!integer(v.ticketRevision,1)||!['create','correct','assign','set_status'].includes(String(v.action))||!id(v.actorUserId)||!second(v.createdAt)||!category(v.category)||!priority(v.priority)||!language(v.language)||v.assigneeMembershipId!==null&&!id(v.assigneeMembershipId)||!status(v.status)||typeof v.humanCorrection!=='boolean'||worker&&(v.actorKind!=='worker'||v.action!=='create'||!id(v.delegationId)||!integer(v.delegationRevision,1)||!id(v.runId)))return fail();return v as unknown as UsSupportTicketAudit;});}
export function validateUsSupportTicket(input:unknown,organizationId?:string,workspaceId?:string):UsSupportTicket{return privateValue(()=>{
  const v=exact(input,['schemaVersion','id','organizationId','workspaceId','originJobId','uid','createdAt','revision','category','priority','language','originalDecision','reviewReasons','needsReview','humanCorrection','correctedBy','assigneeMembershipId','assigneeActive','status','updatedAt','audit']);
  if(v.schemaVersion!==1||![v.id,v.organizationId,v.workspaceId,v.originJobId].every(id)||organizationId!==undefined&&v.organizationId!==organizationId||workspaceId!==undefined&&v.workspaceId!==workspaceId||typeof v.uid!=='string'||!/^\d{1,20}$/.test(v.uid)||!second(v.createdAt)||!integer(v.revision,1)||!category(v.category)||!priority(v.priority)||!language(v.language)||typeof v.humanCorrection!=='boolean'||(v.humanCorrection?!id(v.correctedBy):v.correctedBy!==null))return fail();
  const decision=validateUsSupportTriageDecision(v.originalDecision);
  if(v.assigneeMembershipId!==null&&!id(v.assigneeMembershipId)||typeof v.assigneeActive!=='boolean'||v.assigneeMembershipId===null&&v.assigneeActive||!status(v.status)||!second(v.updatedAt)||v.updatedAt<v.createdAt||v.needsReview!==decision.needsReview||canonicalErpJson(v.reviewReasons)!==canonicalErpJson(decision.reviewReasons)||!v.humanCorrection&&(v.category!==decision.category||v.priority!==decision.priority||v.language!==decision.language))return fail();
  const a=exact(v.audit,['total','events']);if(!integer(a.total,1,US_SUPPORT_TICKET_AUDIT_LIMIT)||a.total!==v.revision||!Array.isArray(a.events)||a.events.length!==Math.min(a.total,US_SUPPORT_TICKET_AUDIT_PAGE_SIZE))return fail();
  const events=a.events.map(validateUsSupportTicketAudit);if(events.some((e,i)=>e.ticketRevision!==(v.revision as number)-i||e.createdAt<(v.createdAt as number)||i>0&&(e.revision>=events[i-1].revision||e.createdAt>events[i-1].createdAt)))return fail();
  const latest=events[0];if(!latest||latest.createdAt!==v.updatedAt||['category','priority','language','assigneeMembershipId','status','humanCorrection'].some(k=>(latest as unknown as Record<string,unknown>)[k]!==v[k])||a.total<=US_SUPPORT_TICKET_AUDIT_PAGE_SIZE&&(events.at(-1)!.action!=='create'||events.at(-1)!.createdAt!==v.createdAt))return fail();
  return {...v,originalDecision:decision,audit:{total:a.total,events}} as unknown as UsSupportTicket;
});}
function identity(v:Record<string,unknown>,organizationId?:string,workspaceId?:string){if(v.schemaVersion!==1||![v.organizationId,v.userId,v.workspaceId].every(id)||organizationId!==undefined&&v.organizationId!==organizationId||workspaceId!==undefined&&v.workspaceId!==workspaceId||!(ACCOUNT_ROLES as readonly unknown[]).includes(v.role))return fail();}
export function validateUsSupportTicketsHead(input:unknown,organizationId?:string,workspaceId?:string):UsSupportTicketsHead{return privateValue(()=>{const v=exact(input,['schemaVersion','organizationId','userId','role','workspaceId','revision','teamRevision']);identity(v,organizationId,workspaceId);if(!integer(v.revision)||!integer(v.teamRevision))return fail();return v as unknown as UsSupportTicketsHead;});}
export function validateUsSupportTicketsProjection(input:unknown,organizationId?:string,workspaceId?:string):UsSupportTicketsProjection{return privateValue(()=>{
  const v=exact(input,['schemaVersion','organizationId','userId','role','workspaceId','offset','nextOffset','tickets','routing','assignees','head']);identity(v,organizationId,workspaceId);
  if(!integer(v.offset,0,500)||v.nextOffset!==null&&!integer(v.nextOffset,1,500)||!Array.isArray(v.tickets)||v.tickets.length>US_SUPPORT_TICKETS_PAGE_SIZE||v.nextOffset!==null&&(v.tickets.length!==US_SUPPORT_TICKETS_PAGE_SIZE||v.nextOffset!==v.offset+v.tickets.length)||!Array.isArray(v.assignees)||v.assignees.length>1000)return fail();
  const tickets=v.tickets.map(t=>validateUsSupportTicket(t,v.organizationId as string,v.workspaceId as string));if(new Set(tickets.map(t=>t.id)).size!==tickets.length)return fail();
  const assignees=v.assignees.map(raw=>{const a=exact(raw,['membershipId','userId','role','displayName']);if(!id(a.membershipId)||!id(a.userId)||!['owner','admin','member'].includes(String(a.role))||a.displayName!==null&&(typeof a.displayName!=='string'||a.displayName.length>160||/[\p{Cc}\p{Cf}]/u.test(a.displayName)))return fail();return a as unknown as UsSupportTicketAssignee;});
  if(new Set(assignees.map(a=>a.membershipId)).size!==assignees.length)return fail();const head=exact(v.head,['revision','teamRevision']);if(!integer(head.revision)||!integer(head.teamRevision))return fail();
  return {...v,tickets,assignees,routing:validateUsSupportRouting(v.routing),head} as unknown as UsSupportTicketsProjection;
});}
export function validateUsSupportTicketReceipt(input:unknown,organizationId?:string,workspaceId?:string):UsSupportTicketReceipt{return privateValue(()=>{const v=exact(input,['schemaVersion','organizationId','workspaceId','requestId','actorUserId','action','entityId','revision','headRevision','createdAt']);if(v.schemaVersion!==1||![v.organizationId,v.workspaceId,v.requestId,v.actorUserId,v.entityId].every(id)||organizationId!==undefined&&v.organizationId!==organizationId||workspaceId!==undefined&&v.workspaceId!==workspaceId||!['create','correct','assign','set_status','save_routing'].includes(String(v.action))||!integer(v.revision,1)||!integer(v.headRevision,1)||!second(v.createdAt))return fail();return v as unknown as UsSupportTicketReceipt;});}
export function validateUsSupportTicketMutationResult(input:unknown,organizationId?:string,workspaceId?:string):UsSupportTicketMutationResult{return privateValue(()=>{const v=exact(input,['ticket','receipt','replayed']),ticket=validateUsSupportTicket(v.ticket,organizationId,workspaceId),receipt=validateUsSupportTicketReceipt(v.receipt,ticket.organizationId,ticket.workspaceId);if(typeof v.replayed!=='boolean'||receipt.action==='save_routing'||receipt.entityId!==ticket.id||receipt.revision>ticket.revision)return fail();return {ticket,receipt,replayed:v.replayed};});}
export function validateUsSupportRoutingMutationResult(input:unknown,organizationId?:string,workspaceId?:string):UsSupportRoutingMutationResult{return privateValue(()=>{const v=exact(input,['routing','receipt','replayed']),routing=validateUsSupportRouting(v.routing),receipt=validateUsSupportTicketReceipt(v.receipt,organizationId,workspaceId);if(typeof v.replayed!=='boolean'||receipt.action!=='save_routing'||receipt.entityId!==receipt.workspaceId||receipt.revision>routing.revision)return fail();return {routing,receipt,replayed:v.replayed};});}
async function hash(organizationId:string,workspaceId:string,userId:string,kind:string,request:unknown){if(![organizationId,workspaceId,userId].every(id))return fail();return sha256Hex(canonicalErpJson({domain:'zentra:us-support-ticket:v1',organizationId,workspaceId,userId,kind,request}));}
export function hashUsSupportTicketRequest(org:string,ws:string,user:string,input:UsSupportTicketRequest):Promise<string>{return hash(org,ws,user,'ticket',validateUsSupportTicketRequest(input));}
export function hashUsSupportRoutingRequest(org:string,ws:string,user:string,input:UsSupportRoutingRequest):Promise<string>{return hash(org,ws,user,'routing',validateUsSupportRoutingRequest(input));}
export function hashUsSupportTicketExecutionRequest(c:UsSupportExecutionContext,input:UsSupportTicketRequest):Promise<string>{return isUsSupportWorkerContext(c)?hash(c.authority.organizationId,c.workspaceId,c.authority.userId,'worker-ticket:'+c.authority.credential.workerId,validateUsSupportTicketRequest(input)):hashUsSupportTicketRequest(c.authority.organizationId,c.workspaceId,c.authority.userId,input);}
