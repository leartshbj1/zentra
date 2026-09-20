import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { it,expect,vi } from 'vitest';
const mock=vi.hoisted(()=>({db:null as unknown}));
vi.mock('./runtime',()=>({database:()=>mock.db,fileArchive:()=>null}));
vi.mock('./supabase-server-runtime',()=>({supabaseRealtimeConfiguration:()=>({url:'https://project.supabase.co',secretKey:'sb_secret_fixture'})}));
import { phase2Read,parsePhase2Action } from './phase2-admin';
it('inventories the migrated database within the D1 compound-query budget',async()=>{
 const db=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('drizzle/'+f,'utf8'));
 let calls=0;mock.db={prepare(sql:string){calls++;expect(sql.split(' UNION ALL ').length).toBeLessThanOrEqual(20);return {async all(){return {results:db.prepare(sql).all()}}}}};
 try{const result=await phase2Read({operation:'inventory'}) as {tables:unknown[]};expect(result.tables.length).toBeGreaterThan(80);expect(calls).toBeLessThan(10);}finally{db.close();}
});
it('never follows a Supabase redirect carrying server credentials',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:302,headers:{Location:'https://elsewhere.test'}}));
 try{await expect(phase2Read({operation:'supabase-buckets'})).rejects.toMatchObject({status:502});expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');}finally{fetcher.mockRestore();}
});
it.each([{operation:'delete'},{operation:'table',table:'organizations;DROP',offset:0},{operation:'supabase-object',bucket:'zentra-releases',key:'app.exe'},{operation:'objects',cursor:42}])('refuses malformed administrative reads',input=>expect(()=>parsePhase2Action(input)).toThrow());
