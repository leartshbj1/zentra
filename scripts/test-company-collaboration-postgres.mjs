import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(process.env.ZENTRA_PGLITE_MODULE?pathToFileURL(process.env.ZENTRA_PGLITE_MODULE).href:'@electric-sql/pglite');
const db=new PGlite();
const idA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',idB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',idC='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
try {
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(await readFile(new URL('../supabase/migrations/202609140200_company_collaboration.sql',import.meta.url),'utf8'));
  await db.query('INSERT INTO zentra_workspaces(organization_id,updated_by,number_floors) VALUES($1,$2,$3),($4,$5,$6)', ['org_a','alice',JSON.stringify([{prefix:'F',year:2026,minimum:125}]),'org_b','eve','[]']);
  const manifest={format:'zentra-cloud-backup',version:1,app_version:'1.67.0',sha256:'a'.repeat(64),size_bytes:3,chunks:[{sha256:'a'.repeat(64),size_bytes:3}]};
  async function candidate(id,device,user,base) { await db.query('INSERT INTO zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',['org_a',id,device,user,base,JSON.stringify(manifest),3]); }
  async function receipt(id) { await db.query('INSERT INTO zentra_workspace_chunks VALUES($1,$2,0,$3,3)',['org_a',id,'a'.repeat(64)]); }
  async function commit(org,id,device,user) {return (await db.query('SELECT zentra_commit_workspace($1,$2,$3,$4) AS result',[org,id,device,user])).rows[0].result;}
  await candidate(idA,'pc-a','alice',0);
  await assert.rejects(commit('org_a',idA,'pc-a','alice'),/workspace_incomplete/);
  assert.equal((await db.query("SELECT revision FROM zentra_workspaces WHERE organization_id='org_a'")).rows[0].revision,0);
  await receipt(idA);
  await assert.rejects(commit('org_b',idA,'pc-a','alice'),/workspace_not_found/);
  await assert.rejects(commit('org_a',idA,'pc-b','alice'),/workspace_not_found/);
  await assert.rejects(commit('org_a',idA,'pc-a','bob'),/workspace_not_found/);
  assert.deepEqual(await commit('org_a',idA,'pc-a','alice'),{committed:true,revision:1,snapshotId:idA});
  await candidate(idB,'pc-b','bob',1);await candidate(idC,'pc-a','alice',1);await receipt(idB);await receipt(idC);
  const outcomes=await Promise.all([commit('org_a',idB,'pc-b','bob'),commit('org_a',idC,'pc-a','alice')]);
  assert.equal(outcomes.filter(r=>r.committed).length,1);assert.equal(outcomes.filter(r=>r.conflict).length,1);
  assert.deepEqual(await commit('org_a',idA,'pc-a','alice'),{committed:true,revision:1,snapshotId:idA});
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM zentra_workspace_snapshots WHERE organization_id='org_a'")).rows[0].n,3);
  const number=async(device,id,minimum=1)=>(await db.query('SELECT zentra_reserve_workspace_numbers($1,$2,$3,$4,$5,$6,$7) AS result',['org_a',device,id,'F',2026,minimum,200])).rows[0].result;
  const [a,b]=await Promise.all([number('pc-a',idA),number('pc-b',idB)]);
  assert.equal(a.start_value,125);assert.equal(b.start_value,a.end_value+1);
  assert.deepEqual(await number('pc-a',idA),a);
  await assert.rejects(number('pc-b',idA),/number_request_mismatch/);
  await assert.rejects(number('pc-a',idA,42),/number_request_mismatch/);
  const bucket=(await db.query("SELECT * FROM storage.buckets WHERE id='zentra-company-data'")).rows[0];
  assert.equal(bucket.public,false);assert.equal(bucket.file_size_limit,8388608);
  for(const role of ['anon','authenticated']){
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM public.zentra_workspaces'),/permission denied/);
    await assert.rejects(commit('org_a',idA,'pc-a','alice'),/permission denied/);
    await assert.rejects(number('pc-a',idA),/permission denied/);
    await db.exec('RESET ROLE');
  }
  console.log('PASS: PostgreSQL migration, tenant/device/actor boundaries, incomplete upload, competing revisions, idempotent receipts, original branches preserved, shared numbering and denied direct client access.');
} finally {await db.close();}
