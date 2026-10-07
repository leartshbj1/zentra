import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';

// No URL, key, CLI session or persistent data directory. Synthetic local SQL only.
const packageDirectory = process.env.PGLITE_MODULE_DIR;
if (!packageDirectory || !isAbsolute(packageDirectory)) throw new Error('Supply an absolute PGLITE_MODULE_DIR pointing to separately installed @electric-sql/pglite.');
const pkg = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
if (pkg.name !== '@electric-sql/pglite') throw new Error('Unexpected PostgreSQL fixture package.');
const { PGlite } = createRequire(import.meta.url)(join(packageDirectory, 'dist/index.cjs'));
const countryName = '20261007194528_international_workspace_country_config.sql';
const migrationName = '20261007222349_international_us_erp_persistence.sql';
const countrySql = await readFile(new URL('../../supabase/migrations/' + countryName, import.meta.url), 'utf8');
const migration = await readFile(new URL('../../supabase/migrations/' + migrationName, import.meta.url), 'utf8');
const db = new PGlite();
const results = [];
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const org = 'us-sql-fixture-a';
const timestamp = '2026-10-08T12:00:00.000Z';
const actor = { organizationId: org, userId: 'owner-fixture', role: 'owner', managementEntitled: true, timestamp };
const config = { schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'10 Example Road',postalCode:'10001',city:'New York',subdivision:'NY'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'configured'} };
const accounts = [{id:'receivables',code:'1100',name:'Accounts receivable',type:'asset'},{id:'sales',code:'4000',name:'Sales',type:'income'},{id:'cash',code:'1000',name:'Cash',type:'asset',cash:true},{id:'tax-payable',code:'2200',name:'Sales tax payable',type:'liability'}];
const period = {id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'};
const initialHeader = {schemaVersion:1,revision:1,configuration:config,counters:{estimate:0,invoice:0},ledger:{organizationId:org,currency:'USD',basis:'accrual',revision:0,accounts,periods:[period]}};
const customer = {id:'customer-1',organizationId:org,kind:'business',name:'Example Customer LLC',billingAddress:config.address,paymentTermsDays:30};
const line = {id:'line-1',description:'Synthetic service',quantityUnits:'1',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'10000'},discountBasisPoints:0,taxTreatment:'exempt'};
const estimate = {id:'estimate-1',organizationId:org,revision:1,currency:'USD',number:'EST-000001',customer,date:'2026-10-08',expiresAt:'2026-11-08',paymentTermsDays:30,lines:[line],notes:'Fictitious test only',status:'draft'};
const accepted = {...estimate,revision:2,status:'accepted'};
const fingerprint=JSON.stringify([org,'US','USD',config.address,accepted.id,2,'2026-10-08',customer.billingAddress,null,[{id:line.id,netMinor:'10000',taxTreatment:line.taxTreatment}]]);
const invoice = {id:'invoice-1',organizationId:org,currency:'USD',companyConfiguration:config,number:'INV-000001',sourceEstimateId:accepted.id,sourceEstimateRevision:2,customer,date:'2026-10-08',accountingDate:'2026-10-08',dueDate:'2026-11-07',lines:[line],notes:'Fictitious test only',subtotal:{currency:'USD',minorUnits:'10000'},discount:{currency:'USD',minorUnits:'0'},tax:{currency:'USD',minorUnits:'0'},total:{currency:'USD',minorUnits:'10000'},taxAssessment:{organizationId:org,country:'US',currency:'USD',documentId:accepted.id,documentRevision:2,fingerprint,source:'documented-exemption',providerReference:'fictitious exemption',determinedAt:timestamp,validUntil:'2026-10-09T12:00:00.000Z',lines:[{id:'line-1',taxMinor:'0',jurisdiction:'US-NY',evidenceReference:'fictitious'}]},payments:[],issuedAt:timestamp,issuedBy:actor.userId};
const journal = {id:'entry:invoice:invoice-1',idempotencyKey:'invoice:invoice-1',organizationId:org,currency:'USD',basis:'accrual',transactionDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',description:'Invoice INV-000001',source:{type:'customer_invoice',id:invoice.id},lines:[{accountId:'receivables',debitMinor:'10000',creditMinor:'0'},{accountId:'sales',debitMinor:'0',creditMinor:'10000'}],postedBy:actor.userId,postedAt:timestamp,revision:1,fingerprint:'synthetic journal identity'};
const audit = (entry, revision, action='posted') => ({revision,action,actorId:actor.userId,timestamp,entityId:entry});
const change = (kind, payload) => ({kind,id:payload.id,payload});
function commitInput(header, action, entityId, changes=[], ledgerAudit=[], expectedRevision=header.revision-1, key=`request-${header.revision}`) {
  return { organizationId:org,expectedRevision,header,changes,ledgerAudit,actor:copy(actor),receipt:{idempotencyKey:key,commandHash:hash([org,key,action,entityId]),revision:header.revision,entityId,action} };
}
async function commit(input) {
  return (await db.query('select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) result',[input.organizationId,input.expectedRevision,JSON.stringify(input.header),JSON.stringify(input.changes),JSON.stringify(input.ledgerAudit),JSON.stringify(input.receipt),JSON.stringify(input.actor)])).rows[0].result;
}
async function state(organizationId=org) { return (await db.query('select public.zentra_read_us_erp($1) result',[organizationId])).rows[0].result; }
async function test(name, task) { await task(); results.push({name,passed:true}); }
async function rejects(input, code) { await assert.rejects(()=>commit(input), error => error.code===code); }
async function mutateError(sql, parameters, code) { await assert.rejects(()=>db.query(sql,parameters),error=>error.code===code); }
function next(header) { const value=copy(header); value.revision++; return value; }
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.zentra_workspaces(organization_id text primary key,revision bigint not null default 0,snapshot_id uuid,number_floors jsonb not null default '[]',updated_by text not null default 'fixture');
    alter table public.zentra_workspaces enable row level security;
    grant usage on schema public to service_role; grant select,update on public.zentra_workspaces to service_role;
    create policy fixture_workspace_server on public.zentra_workspaces for all to service_role using(true) with check(true);
    insert into public.zentra_workspaces(organization_id,revision) values ('${org}',7),('us-sql-fixture-b',2),('ch-sql-fixture',4);`);
  await db.exec(countrySql);
  await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)',[org,actor.userId,'10000000-0000-4000-8000-000000000001',JSON.stringify(config)]);
  const otherConfig = {...config,organizationId:'us-sql-fixture-b'};
  await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)',[otherConfig.organizationId,actor.userId,'10000000-0000-4000-8000-000000000002',JSON.stringify(otherConfig)]);
  const chConfig={...config,organizationId:'ch-sql-fixture',country:'CH',currency:'CHF',timeZone:'Europe/Zurich',address:{country:'CH',line1:'10 Rue Exemple',postalCode:'1201',city:'Genève',subdivision:'GE'}};
  await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)',[chConfig.organizationId,actor.userId,'10000000-0000-4000-8000-000000000003',JSON.stringify(chConfig)]);
  await db.exec(migration);
  await test('all US store tables have RLS',async()=>assert.equal((await db.query("select count(*)::int n from pg_class where relname in ('zentra_us_erp_heads','zentra_us_erp_records','zentra_us_erp_receipts','zentra_us_erp_ledger_audit') and relrowsecurity")).rows[0].n,4));
  for(const role of ['anon','authenticated']) await test(`${role} has no table or RPC privileges`,async()=> {
    assert.equal((await db.query("select has_table_privilege($1,'public.zentra_us_erp_heads','SELECT,INSERT,UPDATE,DELETE') or has_function_privilege($1,'public.zentra_commit_us_erp(text,bigint,jsonb,jsonb,jsonb,jsonb,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed,false);
    await db.exec(`set role ${role}`); await mutateError('select public.zentra_read_us_erp($1)',[org],'42501'); await db.exec('reset role');
  });
  await test('RPCs use invoker with empty search path',async()=>assert.equal((await db.query("select count(*)::int n from pg_proc where proname in ('zentra_read_us_erp','zentra_us_erp_receipt','zentra_commit_us_erp') and not prosecdef and proconfig=array['search_path=\"\"']")).rows[0].n,3));
  await db.exec('set role service_role');
  await test('minor units retain the ledger exact 36 digit financial bound',async()=>{assert.equal((await db.query('select public.zentra_us_erp_minor($1::jsonb)::text result',[JSON.stringify('9'.repeat(36))])).rows[0].result,'9'.repeat(36));await mutateError('select public.zentra_us_erp_minor($1::jsonb)',[JSON.stringify('1'+'0'.repeat(36))],'PU004');});
  await test('line quantity and discount round separately with integer cents',async()=>{const synthetic={...line,quantityUnits:'15',quantityScale:1,unitPrice:{currency:'USD',minorUnits:'101'},discountBasisPoints:500};assert.deepEqual((await db.query('select public.zentra_us_erp_line_totals($1::jsonb) result',[JSON.stringify(synthetic)])).rows[0].result,{grossMinor:'152',discountMinor:'8',netMinor:'144'});});
  let header=copy(initialHeader); const init=commitInput(header,'initialize',org);
  await test('posting chart account types cannot invert the financial meaning',async()=>{const bad=copy(init);bad.header.ledger.accounts.find(a=>a.id==='receivables').type='income';await rejects(bad,'PU004');assert.equal(await state(),null);});
  await test('initialize committed and read back from PostgreSQL',async()=> {assert.deepEqual(await commit(init),init.receipt); assert.deepEqual(await state(),{...header,customers:[],estimates:[],invoices:[],ledger:{...header.ledger,entries:[],audit:[]}});});
  await test('initialize replay does not advance head',async()=> {assert.deepEqual(await commit(init),init.receipt); assert.equal((await state()).revision,1);});
  await test('other company remains empty',async()=>assert.equal(await state('us-sql-fixture-b'),null));
  await test('reused request with different hash conflicts',async()=>{const input=copy(init);input.receipt.commandHash='b'.repeat(64);await rejects(input,'PU002');});
  await test('client cannot change actor tenant',async()=>{const input=copy(init);input.actor.organizationId='us-sql-fixture-b';await rejects(input,'PU004');});
  await test('replay still requires management right',async()=>{const input=copy(init);input.actor.managementEntitled=false;await rejects(input,'PU004');});
  header=next(header);let input=commitInput(header,'save_customer',customer.id,[change('customer',customer)]);
  await test('customer record persisted',async()=> {await commit(input); assert.deepEqual((await state()).customers,[customer]);});
  await test('stale CAS rejected with no record change',async()=> {const bad=commitInput({...header,revision:3},'save_customer','stale',[change('customer',{...customer,id:'stale'})],[],0,'stale-key'); await rejects(bad,'PU001'); assert.equal((await state()).customers.length,1);});
  header=next(header);header.counters.estimate=1;input=commitInput(header,'save_estimate',estimate.id,[change('estimate',estimate)]);
  await test('estimate and counter committed together',async()=> {await commit(input);assert.equal((await state()).estimates[0].number,'EST-000001');});
  header=next(header);input=commitInput(header,'accept_estimate',estimate.id,[change('estimate',accepted)]);await test('acceptance persisted with revision',async()=>{await commit(input);assert.equal((await state()).estimates[0].revision,2);});
  const issueHeader=next(header);issueHeader.counters.invoice=1;issueHeader.ledger.revision=1;
  const issue=commitInput(issueHeader,'issue_invoice',invoice.id,[change('invoice',invoice),change('journal',journal)],[audit(journal.id,1)]);
  await test('unbalanced journal rolls back invoice number and head',async()=> {const bad=copy(issue);bad.changes[1].payload.lines[1].creditMinor='9999';await rejects(bad,'PU004');const saved=await state();assert.equal(saved.revision,4);assert.equal(saved.counters.invoice,0);assert.equal(saved.invoices.length,0);});
  await test('decimal minor amount refused',async()=> {const bad=copy(issue);bad.changes[1].payload.lines[1].creditMinor='10000.0';await rejects(bad,'PU004');});
  await test('balanced journal at a different amount is refused',async()=>{const bad=copy(issue);bad.changes[1].payload.lines[0].debitMinor='1';bad.changes[1].payload.lines[1].creditMinor='1';await rejects(bad,'PU004');assert.equal((await state()).revision,4);});
  await test('balanced journal with swapped account meaning is refused',async()=>{const bad=copy(issue);bad.changes[1].payload.lines[0].accountId='cash';await rejects(bad,'PU004');});
  await test('invoice cannot replace the accepted estimate contents',async()=>{const bad=copy(issue);bad.changes[0].payload.lines[0].description='Replaced';await rejects(bad,'PU004');});
  await test('invoice totals cannot be fabricated with a matching balanced journal',async()=>{const bad=copy(issue);bad.changes[0].payload.subtotal.minorUnits='1';bad.changes[0].payload.total.minorUnits='1';bad.changes[1].payload.lines[0].debitMinor='1';bad.changes[1].payload.lines[1].creditMinor='1';await rejects(bad,'PU004');});
  await test('foreign tenant tax proof is refused',async()=>{const bad=copy(issue);bad.changes[0].payload.taxAssessment.organizationId='us-sql-fixture-b';await rejects(bad,'PU004');});
  await test('a Swiss tax source cannot authorize a US invoice',async()=>{const bad=copy(issue);bad.changes[0].payload.taxAssessment.source='swiss-vat';await rejects(bad,'PU004');});
  await test('expired tax proof is refused without spending a document number',async()=>{const bad=copy(issue);bad.changes[0].payload.taxAssessment.validUntil='2026-10-07T12:00:00.000Z';await rejects(bad,'PU004');assert.equal((await state()).counters.invoice,0);});
  await test('tax request fingerprint must match invoice date and location',async()=>{const bad=copy(issue);const values=JSON.parse(fingerprint);values[6]='2026-10-07';bad.changes[0].payload.taxAssessment.fingerprint=JSON.stringify(values);await rejects(bad,'PU004');});
  await test('tax aggregate must match evidence line amounts',async()=>{const bad=copy(issue);bad.changes[0].payload.taxAssessment.lines[0].taxMinor='1';await rejects(bad,'PU004');});
  await test('invoice number must match its own atomic counter',async()=>{const bad=copy(issue);bad.changes[0].payload.number='INV-000999';await rejects(bad,'PU004');});
  await test('customer invoice journal and audit are atomic',async()=> {await commit(issue);const saved=await state();assert.equal(saved.invoices.length,1);assert.equal(saved.ledger.entries.length,1);assert.equal(saved.ledger.audit.length,1);assert.equal(saved.revision,5);});
  await test('issue response lost and retried returns same receipt',async()=> {assert.deepEqual(await commit(issue),issue.receipt);assert.equal((await state()).ledger.entries.length,1);});
  header=issueHeader;
  await test('issued estimate cannot be edited',async()=> {const bad=commitInput(next(header),'save_estimate',estimate.id,[change('estimate',{...accepted,revision:3,status:'draft'})],[],5,'edit-issued');await rejects(bad,'PU004');});
  await test('journal direct update is immutable',async()=>mutateError("update public.zentra_us_erp_records set payload=jsonb_set(payload,'{description}','\"changed\"'),state_revision=6 where organization_id=$1 and kind='journal'",[org],'PU003'));
  await test('journal direct unbalanced insert cannot bypass balance check',async()=> {const bad={...journal,id:'bad-direct',idempotencyKey:'bad-direct',lines:[{accountId:'cash',debitMinor:'1',creditMinor:'0'},{accountId:'sales',debitMinor:'0',creditMinor:'2'}]};await mutateError('insert into public.zentra_us_erp_records values($1,$2,$3,$4::jsonb,6)',[org,'journal',bad.id,JSON.stringify(bad)],'23514');});
  await test('direct invoice body modification blocked',async()=>mutateError("update public.zentra_us_erp_records set payload=jsonb_set(payload,'{notes}','\"changed\"'),state_revision=6 where organization_id=$1 and kind='invoice'",[org],'PU003'));
  await test('direct history removal has no grant',async()=>mutateError('delete from public.zentra_us_erp_receipts where organization_id=$1',[org],'42501'));
  const payment={id:'payment-1',idempotencyKey:'request-6',organizationId:org,invoiceId:invoice.id,amount:{currency:'USD',minorUnits:'4000'},paymentDate:'2026-10-08',accountingDate:'2026-10-08',reference:'fictitious bank reference',recordedBy:actor.userId};
  const paid={...invoice,payments:[payment]};
  const paymentJournal={...journal,id:'entry:payment:request-6',idempotencyKey:'payment:request-6',revision:2,paymentDate:'2026-10-08',cashFlowCategory:'operating',source:{type:'customer_payment',id:invoice.id},lines:[{accountId:'cash',debitMinor:'4000',creditMinor:'0',description:JSON.stringify([payment.id,payment.reference])},{accountId:'receivables',debitMinor:'0',creditMinor:'4000'}]};
  const paidHeader=next(header);paidHeader.ledger.revision=2;
  const paymentInput=commitInput(paidHeader,'record_payment',payment.id,[change('invoice',paid),change('journal',paymentJournal)],[audit(paymentJournal.id,2)]);
  await test('overpayment rolls back journal',async()=> {const bad=copy(paymentInput);bad.changes[0].payload.payments[0].amount.minorUnits='10001';await rejects(bad,'PU004');assert.equal((await state()).ledger.entries.length,1);});
  await test('payment journal must match the actual payment amount',async()=>{const bad=copy(paymentInput);bad.changes[1].payload.lines[0].debitMinor='1';bad.changes[1].payload.lines[1].creditMinor='1';await rejects(bad,'PU004');});
  await test('payment key must match the operation receipt',async()=>{const bad=copy(paymentInput);bad.changes[0].payload.payments[0].idempotencyKey='another-key';await rejects(bad,'PU004');});
  await test('partial payment and journal persisted together',async()=> {await commit(paymentInput);const saved=await state();assert.equal(saved.invoices[0].payments[0].amount.minorUnits,'4000');assert.equal(saved.ledger.entries.length,2);});
  await test('payment retry has no duplicate',async()=> {await commit(paymentInput);assert.equal((await state()).invoices[0].payments.length,1);});
  await test('recorded payment cannot be changed',async()=> {const bad=commitInput(next(paidHeader),'record_payment','payment-2',[change('invoice',{...paid,payments:[{...payment,reference:'changed'}, {...payment,id:'payment-2',idempotencyKey:'new',amount:{currency:'USD',minorUnits:'1'}}]})],[],6,'rewrite-payment');await rejects(bad,'PU003');});
  header=next(paidHeader);header.ledger.revision=3;header.ledger.periods[0].status='closed';
  const close=commitInput(header,'close_period','2026',[],[audit('2026',3,'period_closed')]);
  await test('period closure recorded',async()=> {await commit(close);assert.equal((await state()).ledger.periods[0].status,'closed');assert.equal((await state()).ledger.audit.length,3);});
  await test('period cannot be reopened',async()=> {const bad=commitInput(next(header),'save_customer',customer.id,[change('customer',{...customer,name:'Changed'})],[],7,'reopen');bad.header.ledger.periods[0].status='open';await rejects(bad,'PU003');});
  await test('configuration cannot be silently replaced',async()=> {const bad=commitInput(next(header),'save_customer',customer.id,[change('customer',customer)],[],7,'config');bad.header.configuration.language='fr';await rejects(bad,'PU006');});
  await test('read-only cannot mutate',async()=> {const bad=commitInput(next(header),'save_customer',customer.id,[change('customer',customer)],[],7,'readonly');bad.actor.role='read_only';await rejects(bad,'PU004');});
  await test('commercial member can save a customer',async()=> {const memberHeader=next(header);const member=commitInput(memberHeader,'save_customer',customer.id,[change('customer',{...customer,name:'Example Customer renamed'})],[],7,'member');member.actor.role='member';await commit(member);header=memberHeader;});
  await test('commercial member cannot issue',async()=> {const bad=commitInput(next(header),'issue_invoice','invoice-2',[],[],8,'member-issue');bad.actor.role='member';await rejects(bad,'PU004');});
  await test('financial receipt replay still rejects a downgraded member',async()=>{const bad=copy(issue);bad.actor.role='member';await rejects(bad,'PU004');});
  const refreshedConfig={...config,language:'fr',timeZone:'America/Los_Angeles',invoiceNumberPrefix:'US',taxConfiguration:{status:'unconfigured'}};
  await db.exec('reset role');await db.query('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4::jsonb)',[org,actor.userId,'10000000-0000-4000-8000-000000000004',JSON.stringify(refreshedConfig)]);await db.exec('set role service_role');
  const refreshHeader=next(header);refreshHeader.configuration=refreshedConfig;
  const refresh=commitInput(refreshHeader,'refresh_configuration',org,[],[],header.revision,'refresh-config');
  await test('member cannot refresh national configuration',async()=>{const bad=copy(refresh);bad.actor.role='member';await rejects(bad,'PU004');});
  await test('old configuration prevents unrelated writes until explicit refresh',async()=>{const bad=commitInput(next(header),'save_customer',customer.id,[change('customer',customer)],[],header.revision,'stale-config');await rejects(bad,'PU006');});
  await test('owner refreshes metadata while retaining historical invoice configuration',async()=>{await commit(refresh);header=refreshHeader;const saved=await state();assert.deepEqual(saved.configuration,refreshedConfig);assert.deepEqual(saved.invoices[0].companyConfiguration,config);assert.equal(saved.ledger.entries.length,2);assert.equal(saved.counters.invoice,1);});
  await test('configuration refresh is idempotent',async()=>{await commit(refresh);assert.equal((await state()).revision,9);});
  await test('CH workspace cannot initialize US store',async()=> {const bad=commitInput({...initialHeader,configuration:chConfig},'initialize','ch-sql-fixture');bad.organizationId='ch-sql-fixture';bad.actor.organizationId='ch-sql-fixture';await rejects(bad,'PU005');assert.equal(await state('ch-sql-fixture'),null);});
  await test('snapshot revision is unchanged by all US business commits',async()=>assert.equal(Number((await db.query('select revision from public.zentra_workspaces where organization_id=$1',[org])).rows[0].revision),7));
  await test('receipt lookup isolates tenant',async()=>assert.equal((await db.query('select public.zentra_us_erp_receipt($1,$2) result',['us-sql-fixture-b','request-5'])).rows[0].result,null));
  await db.exec('reset role');
  await test('no US rows accidentally created for other companies',async()=>assert.equal((await db.query('select count(distinct organization_id)::int n from public.zentra_us_erp_heads')).rows[0].n,1));
  console.log(JSON.stringify({executedAt:new Date().toISOString(),engine:(await db.query('select version()')).rows[0].version,pgliteVersion:pkg.version,migration:migrationName,migrationSha256:hash(migration),passed:results.length,results,scope:'Real PostgreSQL WASM SQL execution; complete synthetic flow and grants. No production, PostgREST, live tax provider, multi-connection race or native bridge proof.'},null,2));
} catch(error) {
  console.error(JSON.stringify({error:'us_erp_sql_test_failed',afterPassed:results.length,lastPassed:results.at(-1)?.name,code:error.code,message:error.message,position:error.position},null,2));
  process.exitCode=1;
} finally { await db.close(); }
