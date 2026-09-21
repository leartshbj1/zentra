import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { it,expect,vi } from 'vitest';
vi.mock('./runtime',()=>({database:()=>null,fileArchive:()=>null,runtimeValue:()=>''}));
vi.mock('./supabase-server-runtime',()=>({supabaseRealtimeConfiguration:()=>({})}));
import { parsePhase2Reset,phase2ResetStatements,phase2Reset,RESET_ACK } from './phase2-reset';
import { phase2Tables } from './phase2-reset-plan';

const counts=()=>Object.fromEntries(phase2Tables.filter(t=>t!=='founder_admin_nonces').map(t=>[t,0]));
const input=()=>({operation:'reset-d1',acknowledgement:RESET_ACK,backupSha256:'a'.repeat(64),counts:counts()});
function db(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('drizzle/'+f,'utf8'));return db;}
it('keeps the reset unavailable without a maintenance window and matching backup proof',async()=>{
 await expect(phase2Reset(parsePhase2Reset(input()))).rejects.toMatchObject({status:403});
});
it.each([
 ()=>({...input(),acknowledgement:'delete'}),
 ()=>({...input(),counts:{organizations:4}}),
 ()=>({...input(),counts:{...counts(),'organizations;DROP TABLE subscriptions':2}}),
 ()=>({...input(),operation:'reset-supabase-object',key:'x',bucket:'zentra-releases',sha256:'b'.repeat(64)}),
])('rejects broadened or incomplete reset scope',make=>expect(()=>parsePhase2Reset(make())).toThrow());
it('restores the archive guard and leaves global configuration untouched',()=>{
 const database=db();try{
 const before=database.prepare("SELECT sql FROM sqlite_master WHERE name='invoice_archives_immutable_delete_guard'").get();
 const actual=counts();for(const name of Object.keys(actual))actual[name]=Number((database.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {n:number}).n);
 database.exec('BEGIN');for(const sql of phase2ResetStatements(actual))database.exec(sql);database.exec('COMMIT');
 expect(database.prepare("SELECT sql FROM sqlite_master WHERE name='invoice_archives_immutable_delete_guard'").get()?.sql?.toString().replaceAll("\r","")).toEqual(before?.sql?.toString().replaceAll("\r",""));
 expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 expect(phase2ResetStatements(actual).some(sql=>sql.includes('DELETE FROM "support_platform_secrets"'))).toBe(false);
 }finally{database.close();}
});
it('rolls back completely when data changed after the snapshot',()=>{
 const database=db();try{
 const before=database.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
 const stale=counts();stale.organizations=999;
 database.exec('BEGIN');expect(()=>{for(const sql of phase2ResetStatements(stale))database.exec(sql)}).toThrow();database.exec('ROLLBACK');
 expect(database.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
 }finally{database.close();}
});
