import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { encryptSecret } from './crypto';
import { SupportError, type SourceTicket } from './types';

const mocks=vi.hoisted(()=>({db:null as unknown,subscription:vi.fn(),open:vi.fn(),list:vi.fn(),read:vi.fn(),close:vi.fn(),prepare:vi.fn(),capture:vi.fn(),ingest:vi.fn(),process:vi.fn()}));
vi.mock('@/lib/runtime',()=>({database:()=>mocks.db,runtimeValue:(key:string)=>key==='SUPPORT_MAIL_SYNC_TOKEN'?'private-scheduler-token':key==='SUPPORT_ENCRYPTION_KEY'?'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=':''}));
vi.mock('./billing',()=>({requireSupportSubscription:mocks.subscription}));
vi.mock('./service',()=>({ingest:mocks.ingest,processTicket:mocks.process}));
vi.mock('@/lib/automation/execution',()=>({supportAutomationState:async()=>({enabled:true})}));
vi.mock('@/lib/supplier-inbox/capture',()=>({mailboxCaptureNeeded:async()=>true,captureMailboxInvoices:mocks.capture}));
vi.mock('./mail-documents',()=>({prepareMailDocuments:mocks.prepare}));
vi.mock('./infomaniak-imap',()=>({decodeImapCredentials:()=>({password:'private-mail-password',firstUid:1}),encodeImapCredentials:vi.fn(),openImapMailbox:mocks.open}));
import {runMailSync} from './mail-sync';

const TIME=1_800_000_000;
const workspace='private-company-id',connection='private-mailbox-id';
const request=()=>new Request('https://zentraapp.ch/api/support/mail-sync?mailbox=private-mailbox-id',{
  method:'POST',headers:{Authorization:'Bearer private-scheduler-token'},
});
const privateError=()=>new SupportError('private-mail-password private-client@example.test https://private.invalid/token',503);
let sql:DatabaseSync;
let log:ReturnType<typeof vi.spyOn>;
let failureQuery:string|null;
let source:SourceTicket;
let events:string[];
beforeEach(async()=>{
  vi.resetAllMocks();vi.spyOn(Date,'now').mockReturnValue(TIME*1000);
  log=vi.spyOn(console,'error').mockImplementation(()=>{});
  sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())
    sql.exec(readFileSync(new URL('../../drizzle/'+file,import.meta.url),'utf8'));
  failureQuery=null;events=[];
  mocks.db={prepare(query:string){
    let values:SQLInputValue[]=[];
    const execute=()=>{if(failureQuery && query.includes(failureQuery)){failureQuery=null;throw privateError();}};
    const statement={bind(...bound:SQLInputValue[]){values=bound;return statement;},async first(){execute();return sql.prepare(query).get(...values)??null;},async all(){execute();return {results:sql.prepare(query).all(...values)};},async run(){execute();return {success:true,meta:sql.prepare(query).run(...values)};}};
    return statement;
  }};
  sql.prepare('INSERT INTO support_workspaces(id,owner_id,name,mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(workspace,'private-owner','private-enterprise','review',TIME,TIME);
  const secret=await encryptSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=','private-mail-password',`connection:${workspace}:${connection}`);
  sql.prepare('INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(connection,workspace,'infomaniak','private-client@example.test','mail.infomaniak.com','private-client@example.test',secret,'','{}','{}',TIME);
  sql.prepare('INSERT INTO support_mailboxes(connection_id,workspace_id,email,mailbox_id,folder_id,since_at,next_sync_at) VALUES(?,?,?,?,?,?,?)').run(connection,workspace,'private-client@example.test','private-remote-mailbox','private-folder',TIME-100,TIME-1);
  source={externalId:'private-external-id',subject:'private-invoice-subject',body:'private-invoice-body',version:'1',groupId:null,agentId:null,closed:false,mail:{sender:'private-supplier@example.test',uid:'7',attachments:[]}};
  mocks.subscription.mockImplementation(async()=>{events.push('subscription');});
  mocks.open.mockImplementation(async()=>{events.push('open');return {list:mocks.list,read:mocks.read,close:mocks.close,attachment:async()=>new Uint8Array()};});
  mocks.list.mockImplementation(async()=>{events.push('list');return {messages:[{uid:'7',date:TIME}],count:1};});
  mocks.read.mockImplementation(async()=>{events.push('read');return source;});
  mocks.prepare.mockImplementation(async()=>{events.push('prepare');return {source,documents:[]};});
  mocks.capture.mockImplementation(async()=>{events.push('capture');});
  mocks.ingest.mockImplementation(async()=>{
    events.push('ingest');
    sql.prepare('INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('private-ticket',workspace,connection,source.externalId,source.subject,source.body,'{}','private-fingerprint',TIME,TIME);
  });
  mocks.process.mockImplementation(async()=>{events.push('classify');});
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('Unexpected external call');}));
});
afterEach(()=>{sql.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
const state=()=>sql.prepare('SELECT lease,lease_until,next_sync_at,last_sync_at,scan_offset FROM support_mailboxes WHERE connection_id=?').get(connection);
const incident=()=>log.mock.calls.find((call:unknown[])=>call[0]==='zentra_service_failure')?.[1] as Record<string,unknown>|undefined;
function privacy(){expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-|private@|example\.test|zentraapp\.ch|https:|Bearer|password|token|invoice-body/);expect(fetch).not.toHaveBeenCalled();}

it('completes the existing source pipeline with no failure telemetry or altered lease/result',async()=>{
  expect(await runMailSync(request())).toEqual({idle:false,imported:1,processed:1,more:false,incomplete:false});
  expect(events).toEqual(['subscription','open','list','read','prepare','capture','ingest','classify']);
  expect(state()).toMatchObject({lease:null,lease_until:0,next_sync_at:TIME+300,last_sync_at:TIME,scan_offset:0});
  expect(mocks.close).toHaveBeenCalledOnce();expect(log).not.toHaveBeenCalled();privacy();
});

it.each(['subscription','decrypt','open','list','read','prepare','ingest','classify','lease','lookup','progress','finalize'] as const)(
  'reports the actual %s failure boundary without source data and retains the existing five-minute backoff',async stage=>{
    if(stage==='decrypt')sql.prepare('UPDATE support_connections SET secret=? WHERE id=?').run('invalid-private-secret',connection);
    else if(stage==='lease')failureQuery='UPDATE support_mailboxes SET lease_until=?';
    else if(stage==='lookup')failureQuery='SELECT * FROM support_connections';
    else if(stage==='progress')failureQuery='UPDATE support_mailboxes SET scan_offset=?';
    else if(stage==='finalize')failureQuery='UPDATE support_mailboxes SET next_sync_at=?,last_error=?';
    else mocks[stage==='classify'?'process':stage].mockRejectedValueOnce(privateError());
    const result=await runMailSync(request());
    expect(result).toMatchObject({idle:false,failed:true,reference:expect.stringMatching(/^[a-f0-9-]{36}$/)});
    expect(log).toHaveBeenCalledOnce();
    expect(incident()).toMatchObject({operation:'support.mailbox.sync',mailStage:stage,supportStatus:503,kind:'internal',durationMs:0});
    expect(state()).toMatchObject({lease:null,lease_until:0,next_sync_at:TIME+300});
    privacy();
  },
);
it('reports capture failures at capture while keeping ingestion and classification progressing',async()=>{
  mocks.capture.mockRejectedValueOnce(privateError());
  expect(await runMailSync(request())).toMatchObject({idle:false,imported:1,processed:1,incomplete:true});
  expect(incident()).toMatchObject({operation:'support.mailbox.capture',mailStage:'capture',supportStatus:503});
  expect(log).toHaveBeenCalledOnce();expect(mocks.ingest).toHaveBeenCalledOnce();expect(mocks.process).toHaveBeenCalledOnce();
  expect(state()).toMatchObject({lease:null,lease_until:0,next_sync_at:TIME+300,last_sync_at:TIME});privacy();
});
it('retains a generic error stage through the public 503 wrapper without inventing a SupportError status',async()=>{
  mocks.read.mockRejectedValueOnce(new Error('private-mail-password private-client@example.test'));
  expect(await runMailSync(request())).toMatchObject({idle:false,failed:true});
  expect(incident()).toMatchObject({mailStage:'read',kind:'internal'});expect(incident()?.supportStatus).toBeUndefined();privacy();
});
it('keeps expected IMAP 422 document failures non-incident and continues to the unchanged finalization',async()=>{
  mocks.read.mockRejectedValueOnce(new SupportError('private-client@example.test document too large',422));
  expect(await runMailSync(request())).toMatchObject({idle:false,imported:0,processed:0,incomplete:true});
  expect(mocks.ingest).not.toHaveBeenCalled();expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();expect(log).not.toHaveBeenCalled();privacy();
});
