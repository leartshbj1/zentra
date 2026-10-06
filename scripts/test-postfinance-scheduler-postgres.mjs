import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const source = new URL('../supabase/migrations/20261006114402_prepare_private_postfinance_scheduler.sql', import.meta.url);
const modulePath = process.env.ZENTRA_PGLITE_MODULE;
const resultPath = process.argv[2];
if (!resultPath) throw Error('Pass a new absolute evidence JSON path as the first argument.');
const expectedHash = process.argv[3];
const digest = value => createHash('sha256').update(value).digest('hex');
const original = await readFile(source);
const sourceHash = digest(original);
if (expectedHash) assert.equal(sourceHash, expectedHash.toLowerCase(), 'Migration must have the externally frozen hash');
try { await readFile(resultPath); throw new Error('Existing evidence must not be overwritten'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

let externalTransportAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { externalTransportAttempts++; throw new Error('External transport forbidden'); };
const tokens = { reconcile: randomBytes(32).toString('base64url'), billing: randomBytes(32).toString('base64url') };
const { PGlite } = await import(modulePath ? pathToFileURL(modulePath).href : '@electric-sql/pglite');
const db = new PGlite();
const checks = [];
let stage = 'bootstrap';
const result = {
  startedAt: new Date().toISOString(),
  runtime: 'PGlite 0.5.8 real PostgreSQL engine, isolated in-memory database',
  source, sourceSha256: sourceHash, exactSqlExecuted: true,
  stubs: {
    extensions: 'Only pg_extension catalogue rows OID 50001/50002/50003; no actual pg_cron, pg_net or Vault extension code',
    cron: 'Local SQL schedule/alter_job functions and job tables; no scheduler clock or background execution',
    net: 'Transactional SQL http_post appends a fictitious envelope to an isolated table; no HTTP or provider transport',
    vault: 'Local plaintext fixture table with randomly generated test-only credentials kept only in memory',
    responses: 'Artificial response rows and deliberately aged timestamps; no real HTTP response, cron delivery or production Supabase',
  },
  checks,
};
async function rows(sql, args = []) { return (await db.query(sql, args)).rows; }
async function one(sql, args = []) { return (await rows(sql, args))[0]; }
async function number(sql, args = []) { return Number((await one(sql, args)).n); }
const envelopeCount = () => number('select count(*)::int as n from net.mock_requests');
const dispatch = async () => Number((await one('select zentra_internal.dispatch_postfinance() as n')).n);
async function check(name, run) {
  try { await run(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, errorClass: error.name, sqlState: error.code ?? null }); }
}
async function sqlError(action, code) {
  let caught;
  try { await action(); } catch (error) { caught = error; }
  assert.ok(caught, 'Expected SQL refusal');
  if (code) assert.equal(caught.code, code, 'Expected SQL refusal code');
}
async function reset() {
  await db.exec(`truncate zentra_internal.postfinance_scheduler_requests,net._http_response,net.mock_requests restart identity;
    update zentra_internal.postfinance_scheduler_settings set enabled=false;
    truncate vault.decrypted_secrets;`);
}
async function credentials() {
  for (const kind of ['reconcile', 'billing']) {
    const name = kind === 'reconcile' ? 'zentra_postfinance_reconciliation' : 'zentra_postfinance_billing';
    await db.query('insert into vault.decrypted_secrets(name,decrypted_secret) values($1,$2)', [name, tokens[kind]]);
  }
}
async function enable(kind = 'both') {
  await db.query("update zentra_internal.postfinance_scheduler_settings set enabled=true where $1='both' or kind=$1", [kind]);
}
async function request(kind) { return one('select * from zentra_internal.postfinance_scheduler_requests where kind=$1 order by request_id desc limit 1', [kind]); }
async function state(kind) { return (await request(kind)).state; }
async function respond(kind, content, options = {}) {
  const q = await request(kind);
  await db.query(`insert into net._http_response(id,status_code,content,timed_out,error_msg,created)
    values($1,$2,$3,$4,$5,coalesce($6::timestamptz,clock_timestamp()))`, [
      options.id ?? q.request_id, options.status ?? 200, typeof content === 'string' ? content : JSON.stringify(content),
      options.timedOut ?? false, options.error ?? null, options.created ?? null,
    ]);
}
const reconcile = (values = {}) => ({ state: 'processed', claimed: 1, completed: 1, waiting: 0, lost: 0, ...values });
const billing = (values = {}) => ({ stopped: 0, terminalObserved: 0, uncertain: 0, renewal: 'idle', ...values });
async function observed(kind, content, expectedState, options = {}) {
  await reset(); await credentials(); await enable(kind);
  assert.equal(await dispatch(), 1);
  await respond(kind, content, options);
  await db.exec('update zentra_internal.postfinance_scheduler_settings set enabled=false');
  assert.equal(await dispatch(), 0);
  assert.equal(await state(kind), expectedState, 'Expected honest response classification');
  assert.equal(await envelopeCount(), 1);
}
async function deniedRole(role, sql) {
  await db.exec(`begin; set local role ${role};`);
  try { await sqlError(() => db.query(sql), '42501'); }
  finally { await db.exec('rollback'); }
}

try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema cron; create schema net; create schema vault;
    create table cron.job(jobid bigint generated by default as identity primary key,jobname text unique,schedule text not null,command text not null,active boolean not null default true);
    create table cron.job_run_details(runid bigint generated by default as identity primary key,jobid bigint not null references cron.job(jobid),status text,end_time timestamptz);
    create function cron.schedule(job_name text,schedule text,command text) returns bigint language plpgsql as $$declare id bigint;begin
      insert into cron.job(jobname,schedule,command) values(job_name,schedule,command) returning jobid into id; return id;end;$$;
    create function cron.alter_job(job_id bigint,schedule text default null,command text default null,database text default null,username text default null,active boolean default null)
      returns void language plpgsql as $$begin update cron.job j set active=coalesce(alter_job.active,j.active) where j.jobid=job_id;end;$$;
    create table net.mock_requests(id bigint generated by default as identity primary key,url text,body jsonb,params jsonb,headers jsonb,timeout_milliseconds integer,created timestamptz not null default clock_timestamp());
    create function net.http_post(url text,body jsonb default '{}'::jsonb,params jsonb default '{}'::jsonb,headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 1000)
      returns bigint language plpgsql as $$declare id bigint;begin insert into net.mock_requests(url,body,params,headers,timeout_milliseconds)
        values(http_post.url,http_post.body,http_post.params,http_post.headers,http_post.timeout_milliseconds) returning net.mock_requests.id into id;return id;end;$$;
    create table net._http_response(id bigint primary key,status_code integer,content text,timed_out boolean,error_msg text,created timestamptz not null default clock_timestamp());
    create table vault.decrypted_secrets(name text primary key,decrypted_secret text not null);
    insert into pg_catalog.pg_extension(oid,extname,extowner,extnamespace,extrelocatable,extversion)
      select id,name,(select oid from pg_catalog.pg_roles where rolname=current_user),(select oid from pg_catalog.pg_namespace where nspname=ns),false,'isolated-sql-stub'
      from (values(50001::oid,'pg_cron','cron'),(50002::oid,'pg_net','net'),(50003::oid,'supabase_vault','vault')) as mocks(id,name,ns);
    insert into cron.job(jobname,schedule,command,active) values('zentra-mail-existing','*/2 * * * *','select existing_mail_job()',true);
    insert into cron.job_run_details(jobid,status,end_time) select jobid,'succeeded',clock_timestamp()-interval '60 days' from cron.job where jobname='zentra-mail-existing';`);
  const mailBefore = await rows("select j.*,r.runid,r.status,r.end_time from cron.job j join cron.job_run_details r using(jobid) where j.jobname='zentra-mail-existing' order by runid");
  await check('three stub extension catalogue rows are real and verified', async () => {
    assert.equal(await number("select count(*)::int as n from pg_catalog.pg_extension where oid between 50001 and 50003 and extname in('pg_cron','pg_net','supabase_vault')"), 3);
  });
  await check('missing prerequisite fails before installing relay or making a call', async () => {
    await db.exec('begin; delete from pg_catalog.pg_extension where oid=50001;');
    try { await sqlError(() => db.exec(original.toString('utf8')), 'P0001'); }
    finally { await db.exec('rollback'); }
    assert.equal(await envelopeCount(), 0);
    assert.equal((await one("select to_regclass('zentra_internal.postfinance_scheduler_settings') as rel")).rel, null);
  });
  await check('existing PostFinance job is never silently replaced', async () => {
    await db.exec("begin; insert into cron.job(jobname,schedule,command,active) values('zentra-postfinance','0 0 * * *','select prior_relay()',true);");
    try { await sqlError(() => db.exec(original.toString('utf8')), 'P0001'); }
    finally { await db.exec('rollback'); }
    assert.equal(await envelopeCount(), 0);
  });
  stage = 'exact-migration';
  await db.exec(original.toString('utf8'));
  stage = 'behavior';
  await check('exact migration installs a paused minute job, both flags false and zero envelope', async () => {
    const job = await one("select schedule,command,active from cron.job where jobname='zentra-postfinance'");
    assert.deepEqual(job, { schedule: '* * * * *', command: 'select zentra_internal.dispatch_postfinance()', active: false });
    assert.equal(await number('select count(*)::int as n from zentra_internal.postfinance_scheduler_settings where enabled'), 0);
    assert.equal(await envelopeCount(), 0);
    assert.equal(await dispatch(), 0);
    assert.equal(await envelopeCount(), 0);
  });
  await check('enabling without a credential refuses with zero committed calls', async () => {
    await reset(); await enable('reconcile');
    await sqlError(dispatch, 'P0001'); assert.equal(await envelopeCount(), 0);
  });
  await check('invalid credential refuses with zero committed calls', async () => {
    await reset(); await enable('billing');
    await db.query('insert into vault.decrypted_secrets values($1,$2)', ['zentra_postfinance_billing', 'invalid-fixture']);
    await sqlError(dispatch, 'P0001'); assert.equal(await envelopeCount(), 0);
  });
  await check('second missing credential rolls back any first queued envelope', async () => {
    await reset(); await enable();
    await db.query('insert into vault.decrypted_secrets values($1,$2)', ['zentra_postfinance_reconciliation', tokens.reconcile]);
    await sqlError(dispatch, 'P0001'); assert.equal(await envelopeCount(), 0);
    assert.equal(await number('select count(*)::int as n from zentra_internal.postfinance_scheduler_requests'), 0);
  });
  await check('only two exact private workers receive JSON empty bodies and fixed deadlines', async () => {
    await reset(); await credentials(); await enable(); assert.equal(await dispatch(), 2);
    const calls = await rows('select url,body,params,headers,timeout_milliseconds from net.mock_requests order by url');
    assert.deepEqual(calls.map(call => call.url), ['https://zentraapp.ch/api/payments/postfinance/billing-worker','https://zentraapp.ch/api/payments/postfinance/reconcile']);
    for (const call of calls) {
      assert.deepEqual(call.body, {}); assert.deepEqual(call.params, {}); assert.equal(call.timeout_milliseconds, 300000);
      assert.deepEqual(Object.keys(call.headers).sort(), ['Authorization','Content-Type']);
      assert.equal(call.headers['Content-Type'], 'application/json');
      const key = call.url.endsWith('/reconcile') ? 'reconcile' : 'billing';
      assert.ok(call.headers.Authorization === `Bearer ${tokens[key]}`, 'Each envelope must use only its corresponding fixture credential');
    }
  });
  await check('one in-flight per kind suppresses repeated invocations and unique index rejects a duplicate', async () => {
    assert.equal(await dispatch(), 0); assert.equal(await envelopeCount(), 2);
    await sqlError(() => db.query("insert into zentra_internal.postfinance_scheduler_requests(request_id,kind) values(99999,'reconcile')"), '23505');
    assert.equal(await number("select count(*)::int as n from zentra_internal.postfinance_scheduler_requests where state='pending'"), 2);
  });
  await check('a response with a different ID does not complete either request', async () => {
    await respond('reconcile', reconcile(), { id: 99998 });
    assert.equal(await dispatch(), 0); assert.equal(await state('reconcile'), 'pending'); assert.equal(await state('billing'), 'pending');
  });
  await check('a response preceding started_at is ignored even for the exact ID', async () => {
    await reset(); await credentials(); await enable('reconcile'); await dispatch();
    await respond('reconcile', reconcile(), { created: new Date(Date.now() - 60000).toISOString() });
    assert.equal(await dispatch(), 0); assert.equal(await state('reconcile'), 'pending');
  });
  await check('exact ID and later observation time classify valid reconciliation as completed', () => observed('reconcile', reconcile(), 'completed'));
  await check('idle billing counts classify as completed without pretending a charge', () => observed('billing', billing(), 'completed'));
  for (const [name, content] of [
    ['malformed JSON', '{'], ['JSON null', 'null'], ['JSON string', '"ok"'], ['JSON array', '[]'],
    ['missing state/counters', {}], ['oversize object', { ...reconcile(), filler: 'x'.repeat(8200) }],
    ['string counter', reconcile({ completed: '1' })], ['negative counter', reconcile({ completed: -1 })],
    ['fractional counter', reconcile({ completed: 0.5 })], ['more than one claim', reconcile({ claimed: 2, completed: 2 })],
    ['overcounted outcomes', reconcile({ waiting: 1 })], ['unaccounted claimed work', reconcile({ completed: 0 })],
  ]) await check(`HTTP 200 ${name} is never success`, () => observed('reconcile', content, 'failed'));
  await check('HTTP 503 with otherwise valid JSON is failed', () => observed('reconcile', reconcile(), 'failed', { status: 503 }));
  await check('billing missing or invalid counters is failed', () => observed('billing', billing({ uncertain: '0' }), 'failed'));
  await check('billing overcounts more than one inspected flow is failed', () => observed('billing', billing({ stopped: 1, terminalObserved: 1 }), 'failed'));
  await check('billing unknown renewal is failed', () => observed('billing', billing({ renewal: 'paid' }), 'failed'));
  await check('reconciliation waiting outcome is partial, not completed', () => observed('reconcile', reconcile({ completed: 0, waiting: 1 }), 'partial'));
  await check('reconciliation lost outcome is partial, not completed', () => observed('reconcile', reconcile({ completed: 0, lost: 1 }), 'partial'));
  await check('billing uncertain stop is partial, not completed', () => observed('billing', billing({ uncertain: 1 }), 'partial'));
  await check('billing uncertain renewal is partial, not paid', () => observed('billing', billing({ renewal: 'uncertain' }), 'partial'));
  await check('billing disabled renewal is partial, not completed', () => observed('billing', billing({ renewal: 'disabled' }), 'partial'));
  await check('failure/partial impose backoff, then allow one new request after that window', async () => {
    for (const partial of [false, true]) {
      await reset(); await credentials(); await enable('reconcile'); await dispatch();
      await respond('reconcile', partial ? reconcile({ completed: 0, waiting: 1 }) : {}, { status: partial ? 200 : 503 });
      assert.equal(await dispatch(), 0); assert.equal(await envelopeCount(), 1);
      assert.equal(await dispatch(), 0); assert.equal(await envelopeCount(), 1);
      await db.exec("update zentra_internal.postfinance_scheduler_requests set started_at=clock_timestamp()-interval '11 minutes';");
      assert.equal(await dispatch(), 1); assert.equal(await envelopeCount(), 2);
    }
  });
  await check('completed response permits the next bounded tick without an extra active request', async () => {
    await reset(); await credentials(); await enable('reconcile'); await dispatch(); await respond('reconcile', reconcile());
    assert.equal(await dispatch(), 1); assert.equal(await envelopeCount(), 2);
    assert.equal(await number("select count(*)::int as n from zentra_internal.postfinance_scheduler_requests where state='pending'"), 1);
  });
  await check('transport timeout stays uncertain/in-flight until expiry and is never labelled paid or failed', async () => {
    await reset(); await credentials(); await enable('billing'); await dispatch();
    await respond('billing', billing(), { timedOut: true });
    assert.equal(await dispatch(), 0); assert.equal(await state('billing'), 'uncertain'); assert.equal(await envelopeCount(), 1);
    assert.equal((await request('billing')).finished_at, null);
    await db.exec("update zentra_internal.postfinance_scheduler_requests set started_at=clock_timestamp()-interval '11 minutes';");
    assert.equal(await dispatch(), 1); assert.equal(await envelopeCount(), 2);
    assert.equal(await number("select count(*)::int as n from zentra_internal.postfinance_scheduler_requests where state='expired'"), 1);
  });
  await check('transport error and no-response expiry keep uncertainty distinct from financial outcome', async () => {
    await observed('reconcile', reconcile(), 'uncertain', { error: 'fictitious_transport_failure' });
    await reset(); await credentials(); await enable('reconcile'); await dispatch();
    await db.exec("update zentra_internal.postfinance_scheduler_requests set started_at=clock_timestamp()-interval '11 minutes'; update zentra_internal.postfinance_scheduler_settings set enabled=false;");
    assert.equal(await dispatch(), 0); assert.equal(await state('reconcile'), 'expired'); assert.equal(await envelopeCount(), 1);
  });
  await check('internal tables have RLS, no policies, and the definer has an empty search path', async () => {
    assert.equal(await number("select count(*)::int as n from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='zentra_internal' and c.relkind='r' and c.relrowsecurity"), 2);
    assert.equal(await number("select count(*)::int as n from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='zentra_internal'"), 0);
    const fn = await one("select prosecdef,proconfig from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='zentra_internal' and p.proname='dispatch_postfinance'");
    assert.equal(fn.prosecdef, true); assert.ok(fn.proconfig.includes('search_path=""'));
  });
  for (const role of ['anon', 'authenticated', 'service_role']) await check(`${role} cannot call relay, read flags/requests, or change flags, including BYPASSRLS role`, async () => {
    for (const table of ['postfinance_scheduler_settings', 'postfinance_scheduler_requests']) {
      const permissions = await one('select has_table_privilege($1,$2,\'SELECT\') as s,has_table_privilege($1,$2,\'INSERT\') as i,has_table_privilege($1,$2,\'UPDATE\') as u,has_table_privilege($1,$2,\'DELETE\') as d', [role, `zentra_internal.${table}`]);
      assert.deepEqual(permissions, { s: false, i: false, u: false, d: false });
      await deniedRole(role, `select * from zentra_internal.${table}`);
    }
    assert.equal((await one("select has_function_privilege($1,'zentra_internal.dispatch_postfinance()','EXECUTE') as allowed", [role])).allowed, false);
    await deniedRole(role, 'select zentra_internal.dispatch_postfinance()');
    await deniedRole(role, 'update zentra_internal.postfinance_scheduler_settings set enabled=true');
  });
  for (const role of ['anon', 'authenticated']) await check(`RLS still hides rows from ${role} under a temporary SELECT-only fixture grant`, async () => {
    await db.exec(`begin; grant usage on schema zentra_internal to ${role}; grant select on zentra_internal.postfinance_scheduler_settings to ${role}; set local role ${role};`);
    try { assert.equal(await number('select count(*)::int as n from zentra_internal.postfinance_scheduler_settings'), 0); }
    finally { await db.exec('rollback'); }
  });
  await check('30-day cleanup affects only this relay and preserves existing mail job and old run detail', async () => {
    await reset();
    await db.exec("insert into zentra_internal.postfinance_scheduler_requests(request_id,kind,started_at,state) values(99100,'reconcile',clock_timestamp()-interval '60 days','completed'); insert into cron.job_run_details(jobid,status,end_time) select jobid,'succeeded',clock_timestamp()-interval '60 days' from cron.job where jobname='zentra-postfinance';");
    await dispatch();
    assert.equal(await number('select count(*)::int as n from zentra_internal.postfinance_scheduler_requests'), 0);
    assert.equal(await number("select count(*)::int as n from cron.job_run_details r join cron.job j using(jobid) where j.jobname='zentra-postfinance'"), 0);
    const mailAfter = await rows("select j.*,r.runid,r.status,r.end_time from cron.job j join cron.job_run_details r using(jobid) where j.jobname='zentra-mail-existing' order by runid");
    assert.deepEqual(mailAfter, mailBefore); result.existingMailSnapshotSha256 = digest(JSON.stringify(mailAfter));
    assert.equal((await one("select active from cron.job where jobname='zentra-postfinance'")).active, false);
  });
  await check('source bytes unchanged and no actual transport attempted', async () => {
    assert.equal(digest(await readFile(source)), sourceHash); assert.equal(externalTransportAttempts, 0);
  });
} catch (error) {
  result.fatal = { stage, errorClass: error.name, sqlState: error.code ?? null };
} finally {
  await db.close(); globalThis.fetch = originalFetch;
}
result.finishedAt = new Date().toISOString();
result.proofScriptSha256 = digest(await readFile(new URL(import.meta.url)));
result.externalTransportAttempts = externalTransportAttempts;
result.checkCount = checks.length;
result.passedCount = checks.filter(check => check.passed).length;
result.failedChecks = checks.filter(check => !check.passed).map(check => check.name);
result.passed = !result.fatal && result.checkCount > 0 && result.passedCount === result.checkCount && externalTransportAttempts === 0;
result.limitations = [
  'Exact migration PL/pgSQL, PostgreSQL permissions and transactions are exercised, but all three extension implementations are explicit local SQL stubs.',
  'No real cron schedule, extension queue flush, Vault encryption, Supabase hosted privilege defaults, merchant configuration or actual worker response was tested.',
  'Single PGlite connection; the unique active-kind index and repeated calls are tested, not parallel advisory-lock behavior across production sessions.',
  'Fixture aging tests expiry/backoff predicates without waiting ten minutes or altering a production clock.',
  'A relay request expiry allows a new worker invocation; this harness does not execute D1 or prove the downstream financial ledger in that scenario.',
  'No tokens, headers, bodies, provider/account identifiers or raw PostgreSQL error payloads are exported.',
];
await writeFile(resultPath, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed: result.passed, checks: result.checkCount, passedChecks: result.passedCount, failedChecks: result.failedChecks, fatal: result.fatal ?? null, sourceSha256: sourceHash, externalTransportAttempts, resultPath }));
if (!result.passed) process.exitCode = 1;
