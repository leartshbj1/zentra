import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const {PGlite}=await import(pathToFileURL(process.env.ZENTRA_PGLITE_MODULE).href);
const db=new PGlite();const digest=s=>createHash('sha256').update(s).digest('hex');
const parts=[{sha256:digest('logo'),size_bytes:4},{sha256:digest('invoice'),size_bytes:7}];
const manifest={format:'zentra-cloud-backup',version:1,app_version:'1.75.0',sha256:digest('logoinvoice'),size_bytes:11,chunks:[{sha256:digest('logoinvoice'),size_bytes:11}]};
const prepare=async(id,base=0,entries=parts,org='company-a',user='alice',device='pc-a')=>(await db.query('SELECT zentra_prepare_content($1,$2,$3,$4,$5,$6,$7,$8,true,$9) AS r',[org,id,device,user,base,JSON.stringify(manifest),JSON.stringify(entries),digest(JSON.stringify(entries)),'[]'])).rows[0].r;
const reserve=async(id,part,org='company-a',user='alice',device='pc-a')=>(await db.query('SELECT zentra_reserve_content_blob($1,$2,$3,$4,$5,$6) AS r',[org,id,device,user,part.sha256,part.size_bytes])).rows[0].r;
const commit=async(id,org='company-a',user='alice',device='pc-a')=>(await db.query('SELECT zentra_commit_workspace($1,$2,$3,$4) AS r',[org,id,device,user])).rows[0].r;
const cleanup=async()=>(await db.query("SELECT zentra_claim_content_cleanup('company-a') AS r")).rows[0].r;
try {
 await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
 for(const name of ['202609140200_company_collaboration','202609200300_company_content'])await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
 const a=randomUUID(),b=randomUUID(),c=randomUUID();
 assert.equal((await prepare(a)).missing.length,2);
 await assert.rejects(commit(a),/workspace_incomplete/);
 for(const part of parts){await reserve(a,part);await db.query("UPDATE zentra_workspace_content_blobs SET state='ready' WHERE sha256=$1",[part.sha256]);}
 assert.equal((await commit(a)).revision,1);
 assert.equal((await commit(a)).revision,1); // Ambiguous commit response replay.
 assert.deepEqual((await prepare(b,1)).missing,[]); // No duplicate bytes.
 await prepare(c,1,parts,'company-a','bob','iphone-b');
 const outcomes=await Promise.all([commit(b),commit(c,'company-a','bob','iphone-b')]);
 assert.equal(outcomes.filter(v=>v.committed).length,1);assert.equal(outcomes.filter(v=>v.conflict).length,1);
 assert.equal((await db.query("SELECT sum(size_bytes)::integer AS n FROM zentra_workspace_content_blobs")).rows[0].n,11);
 await assert.rejects(reserve(c,parts[0]),/content_not_found/);
 await assert.rejects(prepare(a,0,parts,'company-a','mallory'),/content_request_mismatch/);
 const other=randomUUID();assert.equal((await prepare(other,0,parts,'company-b')).missing.length,2);
 await assert.rejects(reserve(other,parts[0]),/content_not_found/);
 await db.exec("UPDATE zentra_workspace_content_blobs SET created_at=now()-interval '2 hours'");
 assert.deepEqual(await cleanup(),[]); // Current and pending branches protect shared bytes.
 const orphan=digest('orphan');
 await db.query("INSERT INTO zentra_workspace_content_blobs(organization_id,sha256,size_bytes,state,created_at) VALUES('company-a',$1,7,'ready',now()-interval '2 hours')",[orphan]);
 const claimed=await cleanup();assert.equal(claimed.length,1);assert.equal(claimed[0].sha256,orphan);
 const next=randomUUID(),newParts=[parts[0],{sha256:orphan,size_bytes:7}];await prepare(next,2,newParts);
 await assert.rejects(reserve(next,newParts[1]),/content_cleanup_pending/);
 await db.query("DELETE FROM zentra_workspace_content_blobs WHERE organization_id='company-a' AND sha256=$1 AND storage_key=$2 AND state='deleting'",[orphan,claimed[0].storage_key]);
 const replacement=await reserve(next,newParts[1]);assert.notEqual(replacement.storageKey,claimed[0].storage_key);
 // Replayed old cleanup cannot remove the replacement database row or object key.
 await db.query("DELETE FROM zentra_workspace_content_blobs WHERE organization_id='company-a' AND sha256=$1 AND storage_key=$2 AND state='deleting'",[orphan,claimed[0].storage_key]);
 assert.equal((await reserve(next,newParts[1])).storageKey,replacement.storageKey);
 await assert.rejects(prepare(randomUUID(),2,[]),/invalid_content/);
 for(const role of ['anon','authenticated']){
   await db.exec(`SET ROLE ${role}`);await assert.rejects(prepare(randomUUID(),2),/permission denied/);
   await assert.rejects(db.query('SELECT * FROM zentra_workspace_content_parts'),/permission denied/);await db.exec('RESET ROLE');
 }
 console.log('PASS: content deduplication, complete-only commits, 2-device CAS, retries, pending-branch retention, tenant/device boundaries, cleanup generation race, direct-access denial.');
}finally{await db.close();}
