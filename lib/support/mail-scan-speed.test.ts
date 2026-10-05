import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { encryptSecret } from './crypto';
import { mailDate, mailExternalId, type MailReference } from './infomaniak';
import { mailReceiptId } from '@/lib/supplier-inbox/service';
import { SupportError, type SourceTicket } from './types';

const m = vi.hoisted(() => ({db:null as unknown, subscription:vi.fn(), list:vi.fn(), read:vi.fn(), close:vi.fn(),
  prepare:vi.fn(), capture:vi.fn(), ingest:vi.fn(), classify:vi.fn(), automation:vi.fn(), firstUid:1}));
vi.mock('@/lib/runtime', () => ({database:()=>m.db, runtimeValue:(key:string)=>
  key==='SUPPORT_MAIL_SYNC_TOKEN'?'closed-token':key==='SUPPORT_ENCRYPTION_KEY'?'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=':''}));
vi.mock('@/app/zentra-auth',()=>({getZentraUser:()=>{throw new Error('No browser auth in the closed scan witness');}}));
vi.mock('./billing', () => ({requireSupportSubscription:m.subscription}));
vi.mock('./service', () => ({ingest:m.ingest,processTicket:m.classify}));
vi.mock('@/lib/automation/execution', () => ({supportAutomationState:m.automation}));
vi.mock('@/lib/supplier-inbox/capture', async original => ({
  ...await original<typeof import('@/lib/supplier-inbox/capture')>(),captureMailboxInvoices:m.capture,
}));
vi.mock('./mail-documents', () => ({prepareMailDocuments:m.prepare}));
vi.mock('./infomaniak-imap', () => ({decodeImapCredentials:()=>({password:'closed-password',firstUid:m.firstUid}),
  encodeImapCredentials:vi.fn(),openImapMailbox:async()=>({list:m.list,read:m.read,attachment:async()=>new Uint8Array(),close:m.close})}));
import {runMailSync} from './mail-sync';

const TIME=1_800_000_000, workspace='closed-workspace', connection='closed-connection';
let sql:DatabaseSync, time:number, latency:number, enabled:boolean;
let queryCount:number, lookupCount:number, leaseCount:number;
let beforeQuery:((query:string)=>void|Promise<void>)|null;
let pages:Map<number,{messages:MailReference[];count:number}>;
const request=()=>new Request('https://zentraapp.ch/api/support/mail-sync',{method:'POST',headers:{Authorization:'Bearer closed-token'}});
const refs=(uids:string[])=>uids.map(uid=>({uid,date:TIME}));
const mailbox=()=>sql.prepare('SELECT * FROM support_mailboxes WHERE connection_id=?').get(connection)!;
const deadline=()=>({deadline:time+20_000});
const resume=()=>{time=Math.max(time,Number(mailbox().next_sync_at)*1000);};
async function source(uid:string):Promise<SourceTicket>{return {externalId:await mailExternalId('remote','inbox',uid),
  subject:'Synthetic fixture',body:'Synthetic fixture',version:'1',groupId:null,agentId:null,closed:false,
  mail:{uid,sender:'fixture@example.test',attachments:[]}};}
async function ticket(uid:string,receipt=false){
  const item=await source(uid);
  sql.prepare(`INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('ticket-'+uid,workspace,connection,item.externalId,item.subject,item.body,JSON.stringify(item),'fingerprint-'+uid,'review',TIME,TIME);
  if(receipt)sql.prepare('INSERT INTO supplier_mail_receipts(id,workspace_id,created_at) VALUES(?,?,?)')
    .run(await mailReceiptId('org',connection,item.externalId),workspace,TIME);
}
beforeEach(async()=>{
  vi.resetAllMocks();time=TIME*1000;latency=0;enabled=true;beforeQuery=null;m.firstUid=1;
  queryCount=lookupCount=leaseCount=0;
  vi.spyOn(Date,'now').mockImplementation(()=>time);
  vi.spyOn(console,'info').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});
  sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())
    sql.exec(readFileSync(new URL('../../drizzle/'+file,import.meta.url),'utf8'));
  // The same counterfactual suite can run against the frozen baseline. It gets
  // only an inert nullable fixture column; no baseline production code changes.
  if(!sql.prepare('PRAGMA table_info(support_mailboxes)').all().some(row=>row.name==='scan_resume_json'))
    sql.exec('ALTER TABLE support_mailboxes ADD scan_resume_json TEXT');
  sql.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,1,1);
    INSERT INTO organizations VALUES('org','Synthetic','sub','owner',1,1);
    INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) VALUES('${workspace}','owner','Synthetic','review',${TIME},${TIME});
    INSERT INTO support_gestion_links VALUES('${workspace}','org',1,0,'owner',1);`);
  const secret=await encryptSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=','closed-password',`connection:${workspace}:${connection}`);
  sql.prepare('INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(connection,workspace,'infomaniak','Synthetic','mail.infomaniak.com','fixture@example.test',secret,'','{}','{}',TIME);
  sql.prepare('INSERT INTO support_mailboxes(connection_id,workspace_id,email,mailbox_id,folder_id,since_at,next_sync_at) VALUES(?,?,?,?,?,?,?)')
    .run(connection,workspace,'fixture@example.test','remote','inbox',TIME-100,TIME-1);
  m.db={prepare(query:string){let values:SQLInputValue[]=[];
    const execute=async()=>{queryCount++;if(query.includes('FROM support_tickets')&&!query.includes('state='))lookupCount++;
      if(query.startsWith('UPDATE support_mailboxes SET lease_until='))leaseCount++;
      time+=latency;await beforeQuery?.(query);};
    const statement={bind(...bound:SQLInputValue[]){values=bound;return statement;},
      async first(){await execute();return sql.prepare(query).get(...values)??null;},
      async all(){await execute();return {results:sql.prepare(query).all(...values)};},
      async run(){await execute();return {meta:sql.prepare(query).run(...values)};}};return statement;}};
  pages=new Map([[0,{messages:refs(['3','2','1']),count:3}]]);
  m.subscription.mockResolvedValue(undefined);
  m.automation.mockImplementation(async()=>({enabled}));
  m.list.mockImplementation(async(offset:number)=>pages.get(offset)??{messages:[],count:0});
  m.read.mockImplementation(async(ref:MailReference)=>source(ref.uid));
  m.prepare.mockImplementation(async(item:SourceTicket)=>({source:item,documents:new Map()}));
  m.capture.mockImplementation(async(input:{source:SourceTicket})=>{
    // A fresh refusal never writes a synthetic receipt or performs an effect.
    if(!enabled)return;
    sql.prepare('INSERT INTO supplier_mail_receipts(id,workspace_id,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(await mailReceiptId('org',connection,input.source.externalId),workspace,Math.floor(time/1000));
  });
  m.ingest.mockImplementation(async(_connection:unknown,item:SourceTicket)=>{await ticket(item.mail!.uid!);
    sql.prepare("UPDATE support_tickets SET state='pending' WHERE id=?").run('ticket-'+item.mail!.uid!);});
  m.classify.mockImplementation(async(id:string)=>{sql.prepare("UPDATE support_tickets SET state='review' WHERE id=?").run(id);});
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('No external calls are allowed');}));
});
afterEach(()=>{sql.close();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('resumes a partial page with the exact fractional dates returned by the real provider parser',async()=>{
  const uids=Array.from({length:120},(_,i)=>String(121-i));
  const date=mailDate(new Date(TIME*1000+123).toISOString());
  expect(date).toBe(TIME+0.123);
  pages.set(0,{messages:refs([...uids,'1']).map(ref=>({...ref,date})),count:19});
  for(const uid of uids)await ticket(uid,true);
  latency=2_000;
  const first=await runMailSync(request(),deadline());
  expect(first).not.toHaveProperty('failed',true);
  expect(first).toMatchObject({incomplete:true,budgetExhausted:true});
  const saved=JSON.parse(String(mailbox().scan_resume_json));
  const original=refs([...uids,'1']).map(ref=>({...ref,date}));
  expect(saved.messages.length).toBeGreaterThan(0);expect(saved.messages.length).toBeLessThan(original.length);
  expect(saved.messages).toEqual(original.slice(-saved.messages.length));
  expect(saved.messages.at(-1)).toEqual({uid:'1',date});
  expect(m.read).not.toHaveBeenCalled();
  let remaining=saved.messages.length,cycles=0;
  for(;cycles<10&&m.read.mock.calls.length===0;cycles++){
    resume();expect(await runMailSync(request(),deadline())).not.toHaveProperty('failed',true);
    if(m.read.mock.calls.length===0){
      const next=JSON.parse(String(mailbox().scan_resume_json));
      expect(next.messages.length).toBeLessThan(remaining);
      expect(next.messages).toEqual(original.slice(-next.messages.length));
      expect(next.messages.at(-1)).toEqual({uid:'1',date});remaining=next.messages.length;
    }
  }
  expect(cycles).toBeLessThan(10);
  expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['1']);
  expect(m.read.mock.calls[0][0].date).toBe(date);
  expect(m.ingest).toHaveBeenCalledOnce();expect(m.classify).toHaveBeenCalledOnce();
  expect(mailbox()).toMatchObject({scan_offset:0,scan_resume_json:null,lease:null});
});

it('batches 300 completed duplicate tickets and receipts without repeating Automation or lease checks per UID',async()=>{
  const uids=Array.from({length:300},(_,i)=>String(301-i));
  pages.set(0,{messages:refs([...uids,'1']),count:19});
  for(const uid of uids)await ticket(uid,true);
  latency=100;const started=time;
  const result=await runMailSync(request(),deadline());
  console.log('CLOSED_SCAN_COST',JSON.stringify({queries:queryCount,duplicateLookups:lookupCount,leaseCheckpoints:leaseCount,
    automationChecks:m.automation.mock.calls.length,simulatedQueryCostMs:time-started,imported:result.imported,processed:result.processed}));
  expect(result).toMatchObject({imported:1,processed:1,incomplete:false});
  expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['1']);
  expect(lookupCount).toBeLessThanOrEqual(8);expect(leaseCount).toBeLessThan(20);
  expect(m.automation.mock.calls.length).toBeLessThan(5);expect(time-started).toBeLessThan(20_000);
  expect(mailbox()).toMatchObject({scan_offset:0,scan_resume_json:null,lease:null});
  expect(fetch).not.toHaveBeenCalled();
});

it('bounds slow completed-duplicate chunks and eventually reaches useful work without replaying their consumed prefix',async()=>{
  const uids=Array.from({length:300},(_,i)=>String(301-i));
  pages.set(0,{messages:refs([...uids,'1']),count:19});for(const uid of uids)await ticket(uid,true);
  latency=2_000;let cycles=0;const costs:number[]=[];
  for(;cycles<15&&m.read.mock.calls.length===0;cycles++){
    const before=queryCount;expect(await runMailSync(request(),deadline())).not.toHaveProperty('failed',true);
    costs.push(queryCount-before);resume();
  }
  expect(cycles).toBeLessThan(15);expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['1']);
  expect(Math.max(...costs)).toBeLessThan(40);
  expect(m.ingest).toHaveBeenCalledOnce();expect(m.classify).toHaveBeenCalledOnce();
  expect(mailbox()).toMatchObject({scan_offset:0,scan_resume_json:null,lease:null});
});

it('persists a checked duplicate prefix when capture is disabled and resumes every remaining UID without starvation',async()=>{
  const uids=Array.from({length:300},(_,i)=>String(301-i));
  pages.set(0,{messages:refs([...uids,'1']),count:19});for(const uid of uids)await ticket(uid);
  enabled=false;latency=1_000;let cycles=0;const costs:number[]=[];
  const partials:Array<{size:number;hasTail:boolean;offset:unknown}>=[];
  for(;cycles<100&&m.read.mock.calls.length===0;cycles++){
    const before=queryCount;expect(await runMailSync(request(),deadline())).not.toHaveProperty('failed',true);
    costs.push(queryCount-before);
    if(m.read.mock.calls.length===0){const state=JSON.parse(String(mailbox().scan_resume_json));
      partials.push({size:state?.messages.length??301,hasTail:state?.messages.some((ref:MailReference)=>ref.uid==='1')??false,offset:mailbox().scan_offset});}
    resume();
  }
  expect(cycles).toBeLessThan(100);expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['1']);
  expect(Math.max(...costs)).toBeLessThan(50);expect(partials.length).toBeGreaterThan(0);
  expect(partials.every(page=>page.size<301&&page.hasTail&&page.offset===0)).toBe(true);
  expect(m.ingest).toHaveBeenCalledOnce();expect(m.capture).not.toHaveBeenCalled();
});

it('walks fifteen complete provider pages of 300 duplicates before the useful tail without interpreting message count as provider offset',async()=>{
  const uids=Array.from({length:300},(_,i)=>String(301-i));
  for(const uid of uids)await ticket(uid,true);
  for(let offset=0;offset<300;offset+=20)pages.set(offset,{messages:refs(uids.slice(offset,offset+20)),count:20});
  pages.set(300,{messages:refs(['1']),count:1});latency=100;
  const offsets:number[]=[];
  for(let cycle=0;cycle<16;cycle++){
    offsets.push(Number(mailbox().scan_offset));
    const result=await runMailSync(request(),deadline());
    expect(result).not.toHaveProperty('failed',true);
    expect(result.imported).toBe(cycle===15?1:0);resume();
  }
  expect(offsets).toEqual(Array.from({length:16},(_,i)=>i*20));
  expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['1']);
  expect(m.ingest).toHaveBeenCalledOnce();expect(m.classify).toHaveBeenCalledOnce();
  expect(lookupCount).toBeLessThanOrEqual(17);
  expect(mailbox()).toMatchObject({scan_offset:0,scan_resume_json:null,lease:null});
});

it('keeps provider thread counts intact across partial historical pages and new arrivals',async()=>{
  for(const uid of ['100','99'])await ticket(uid,true);
  pages.set(0,{messages:refs(['100','99']),count:2});pages.set(20,{messages:refs(['80','79','78']),count:20});
  sql.prepare('UPDATE support_mailboxes SET scan_offset=20').run();
  m.read.mockImplementation(async(ref:MailReference)=>{time+=25_000;return source(ref.uid);});
  expect(await runMailSync(request(),deadline())).toMatchObject({imported:1,more:true});
  expect(mailbox().scan_offset).toBe(20);expect(JSON.parse(String(mailbox().scan_resume_json)).messages.map((ref:MailReference)=>ref.uid)).toEqual(['79','78']);
  resume();pages.set(0,{messages:refs(['101','100','99']),count:3});
  expect(await runMailSync(request(),deadline())).toMatchObject({imported:1,more:true});expect(mailbox().scan_offset).toBe(20);
  for(let cycle=0;cycle<2;cycle++){resume();await runMailSync(request(),deadline());}
  expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['80','101','79','78']);
  expect(mailbox()).toMatchObject({scan_offset:40,scan_resume_json:null});
});

it('drains old pending classification while the duplicate scan remains partial',async()=>{
  const uids=Array.from({length:100},(_,i)=>String(101-i));
  pages.set(0,{messages:refs(uids),count:20});for(const uid of uids)await ticket(uid,true);
  await ticket('200',true);sql.prepare("UPDATE support_tickets SET state='pending',created_at=? WHERE id='ticket-200'").run(TIME-500);
  latency=3_000;expect(await runMailSync(request(),deadline())).toMatchObject({processed:1,more:true,incomplete:true});
  expect(m.classify).toHaveBeenCalledWith('ticket-200',expect.anything(),expect.anything(),'Synchronisation mail');
  expect(mailbox().scan_resume_json).not.toBeNull();
});

it('does not reuse historical remaining UIDs after the highest recent UID has been reset',async()=>{
  pages.set(0,{messages:refs(['100']),count:1});pages.set(20,{messages:refs(['80','79']),count:20});await ticket('100',true);
  sql.prepare('UPDATE support_mailboxes SET scan_offset=20').run();
  m.read.mockImplementation(async(ref:MailReference)=>{time+=25_000;return source(ref.uid);});
  await runMailSync(request(),deadline());expect(mailbox().scan_resume_json).not.toBeNull();resume();
  pages.set(0,{messages:refs(['2','1']),count:2});
  expect(await runMailSync(request(),deadline())).toMatchObject({imported:1});
  expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['80','2']);expect(mailbox().scan_offset).toBe(0);
});

it('invalidates a durable historical resume when the IMAP first-UID filter changes',async()=>{
  pages.set(0,{messages:refs(['100']),count:1});pages.set(20,{messages:refs(['80','79']),count:20});await ticket('100',true);
  sql.prepare('UPDATE support_mailboxes SET scan_offset=20').run();
  m.read.mockImplementation(async(ref:MailReference)=>{time+=25_000;return source(ref.uid);});
  await runMailSync(request(),deadline());expect(mailbox().scan_resume_json).not.toBeNull();resume();m.firstUid=21;
  expect(await runMailSync(request(),deadline())).toMatchObject({imported:0});
  expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['80']);
  expect(mailbox()).toMatchObject({scan_offset:0,scan_resume_json:null});
});

it.each(['read-link','write-cursor'])('never acknowledges a cached receipt under a link changed at %s',async(stage)=>{
  pages.set(0,{messages:refs(['3']),count:20});await ticket('3',true);
  let linkReads=0;
  beforeQuery=query=>{
    if(query==='SELECT * FROM support_gestion_links WHERE workspace_id=?')linkReads++;
    if((stage==='read-link'&&linkReads===2&&query==='SELECT * FROM support_gestion_links WHERE workspace_id=?')||
      (stage==='write-cursor'&&query.startsWith('UPDATE support_mailboxes SET scan_offset='))){
      sql.prepare('UPDATE support_gestion_links SET connected_by=? WHERE workspace_id=?').run('different-member',workspace);beforeQuery=null;
    }
  };
  const result=await runMailSync(request(),deadline());expect(result).toMatchObject({incomplete:true});
  expect(mailbox().scan_offset).toBe(0);expect(mailbox().last_sync_at).toBeNull();
  expect(m.capture).not.toHaveBeenCalled();expect(m.ingest).not.toHaveBeenCalled();expect(m.read).not.toHaveBeenCalled();
});

it.each(['folder_id','since_at','mailbox_id'])('fences provider identity %s changed just before writing the cursor',async(field)=>{
  pages.set(0,{messages:refs(['3']),count:20});await ticket('3',true);
  beforeQuery=query=>{if(query.startsWith('UPDATE support_mailboxes SET scan_offset=')){
    sql.prepare(`UPDATE support_mailboxes SET ${field}=?`).run(field==='since_at'?TIME-200:'different-provider-identity');beforeQuery=null;
  }};
  expect(await runMailSync(request(),deadline())).toMatchObject({incomplete:true});
  expect(mailbox().scan_offset).toBe(0);expect(mailbox().last_sync_at).toBeNull();
});

it('retains a replaced lease without writing a cursor, receipt or business effect',async()=>{
  pages.set(0,{messages:refs(['3']),count:20});await ticket('3',true);
  beforeQuery=query=>{if(query.includes('FROM support_tickets')&&!query.includes('state=')){
    sql.prepare('UPDATE support_mailboxes SET lease=?,lease_until=?,scan_offset=?,last_sync_at=?')
      .run('successor',TIME+900,80,TIME-10);beforeQuery=null;
  }};
  expect(await runMailSync(request(),deadline())).toMatchObject({syncing:true,incomplete:true});
  expect(mailbox()).toMatchObject({lease:'successor',lease_until:TIME+900,scan_offset:80,last_sync_at:TIME-10,scan_resume_json:null});
  expect(m.read).not.toHaveBeenCalled();expect(m.capture).not.toHaveBeenCalled();expect(m.ingest).not.toHaveBeenCalled();
});

it('does not renew an expired lease or publish progress after a structural read',async()=>{
  pages.set(0,{messages:refs(['3']),count:20});await ticket('3',true);
  beforeQuery=query=>{if(query.includes('FROM support_tickets')&&!query.includes('state=')){
    sql.prepare('UPDATE support_mailboxes SET lease_until=?').run(Math.floor(time/1000));beforeQuery=null;
  }};
  expect(await runMailSync(request(),deadline())).toMatchObject({syncing:true,incomplete:true});
  expect(mailbox()).toMatchObject({scan_offset:0,last_sync_at:null,scan_resume_json:null});
  expect(Number(mailbox().lease_until)).toBeLessThanOrEqual(Math.floor(time/1000));
  expect(m.read).not.toHaveBeenCalled();expect(m.capture).not.toHaveBeenCalled();expect(m.ingest).not.toHaveBeenCalled();
});

it('refuses a partial page above 1024 remaining UIDs with status 502, without truncation or falsely finishing its tail',async()=>{
  pages.set(0,{messages:refs(Array.from({length:1026},(_,i)=>String(1026-i))),count:20});
  m.read.mockImplementation(async(ref:MailReference)=>{time+=25_000;return source(ref.uid);});
  expect(await runMailSync(request(),deadline())).toMatchObject({failed:true});
  expect(mailbox()).toMatchObject({scan_offset:0,last_sync_at:null,scan_resume_json:null,lease:null});
  expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['1026']);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM support_tickets').get()).toMatchObject({n:1});
  expect(sql.prepare('SELECT COUNT(*) AS n FROM supplier_mail_receipts').get()).toMatchObject({n:1});
  expect(sql.prepare("SELECT state FROM support_tickets WHERE id='ticket-1026'").get()).toMatchObject({state:'pending'});
  expect(vi.mocked(console.error).mock.calls).toContainEqual(['zentra_service_failure',expect.objectContaining({supportStatus:502})]);
  expect(m.classify).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});

it.each(['ticket','receipt'])('preserves lookup failure ordering for a structural %s query before reads or effects',async(kind)=>{
  pages.set(0,{messages:refs(['3']),count:1});await ticket('3',true);
  beforeQuery=query=>{if((kind==='ticket'&&query.includes('FROM support_tickets')&&!query.includes('state='))||
    (kind==='receipt'&&query.includes('FROM supplier_mail_receipts'))){throw new SupportError('Closed structural refusal',503);}};
  expect(await runMailSync(request(),deadline())).toMatchObject({failed:true});
  expect(mailbox()).toMatchObject({scan_offset:0,scan_resume_json:null,last_sync_at:null});
  expect(m.read).not.toHaveBeenCalled();expect(m.capture).not.toHaveBeenCalled();expect(m.ingest).not.toHaveBeenCalled();
});

it('drains concurrent structural reads and retains the original ticket-lookup refusal when the receipt fails faster',async()=>{
  pages.set(0,{messages:refs(['3']),count:1});await ticket('3',true);
  let release!:()=>void;let reached=false;let receiptFinished=false;
  beforeQuery=async query=>{
    if(query.includes('FROM support_tickets')&&!query.includes('state=')){
      reached=true;await new Promise<void>(resolve=>{release=resolve;});throw new SupportError('Primary ticket refusal',503);
    }
    if(query.includes('FROM supplier_mail_receipts')){receiptFinished=true;throw new SupportError('Secondary receipt refusal',503);}
  };
  const operation=runMailSync(request(),deadline());await vi.waitFor(()=>expect(reached).toBe(true));
  await Promise.resolve();release();expect(await operation).toMatchObject({failed:true});
  expect(mailbox().last_error).toBe('Primary ticket refusal');
  expect(m.read).not.toHaveBeenCalled();expect(m.capture).not.toHaveBeenCalled();
  // On the baseline the dependent receipt read is never started; on the batch
  // candidate it settles before the primary error is propagated.
  if(receiptFinished)expect(mailbox().lease).toBeNull();
});

it('does not treat a ticket without a capture receipt as completed when its quota outcome is uncertain',async()=>{
  pages.set(0,{messages:refs(['3']),count:1});await ticket('3');
  m.capture.mockRejectedValue(new SupportError('Closed uncertain quota admission',409));
  expect(await runMailSync(request(),deadline())).toMatchObject({incomplete:true});
  expect(m.read).toHaveBeenCalledOnce();expect(m.capture).toHaveBeenCalledOnce();
  expect(sql.prepare('SELECT COUNT(*) AS n FROM supplier_mail_receipts').get()).toMatchObject({n:0});
  expect(mailbox().last_error).toBe('Closed uncertain quota admission');
});

it('checks revocation again after preparation instead of using the structural scan as an effect authorization',async()=>{
  pages.set(0,{messages:refs(['3']),count:1});
  m.prepare.mockImplementation(async(item:SourceTicket)=>{enabled=false;return {source:item,documents:new Map()};});
  expect(await runMailSync(request(),deadline())).toMatchObject({imported:1});
  expect(m.capture).toHaveBeenCalledOnce();expect(sql.prepare('SELECT COUNT(*) AS n FROM supplier_mail_receipts').get()).toMatchObject({n:0});
});

it.each(['corrupt','oversized','unknown','future','expired','identity','link','offset'])(
  'restarts safely from the provider start when the saved resume is %s',async(kind)=>{
    pages.set(0,{messages:refs(['3','2','1']),count:3});m.read.mockImplementation(async(ref:MailReference)=>{time+=25_000;return source(ref.uid);});
    await runMailSync(request(),deadline());const original=String(mailbox().scan_resume_json);expect(original).not.toBe('null');
    const value=JSON.parse(original);
    const raw=kind==='corrupt'?'{':kind==='oversized'?'x'.repeat(64_001):JSON.stringify({...value,
      ...(kind==='unknown'?{extra:'private-field'}:kind==='future'?{createdAt:Math.floor(time/1000)+120}:kind==='expired'?{createdAt:Math.floor(time/1000)-3_601}:
        kind==='identity'?{identity:'0'.repeat(64)}:kind==='link'?{link:'0'.repeat(64)}:kind==='offset'?{offset:40}:{})});
    sql.prepare('UPDATE support_mailboxes SET scan_offset=20,scan_resume_json=?').run(raw);resume();
    expect(await runMailSync(request(),deadline())).toMatchObject({imported:1});
    expect(m.read.mock.calls.map(([ref])=>ref.uid)).toEqual(['3','2']);expect(mailbox().scan_offset).toBe(0);
    expect(mailbox().scan_resume_json).not.toBeNull();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/private-field|closed-token|closed-password|fixture@example/);
  },
);
