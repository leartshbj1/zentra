import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { DeviceSessionContext } from './account';
const stubs = vi.hoisted(()=>({database:vi.fn(),fileArchive:vi.fn(),session:vi.fn()}));
vi.mock('./runtime',()=>({database:stubs.database,fileArchive:stubs.fileArchive}));
vi.mock('@/lib/account',async original=>({...await original<object>(),requireDeviceSession:stubs.session,enforceAccountRateLimit:vi.fn()}));
import { companyCopy, publishCompanyCopy, requireCompanyCopy } from './company-copy';
import { GET } from '../app/api/account/company-copy/route';
import { AccountPublicError, sha256Hex } from './account-security';
let db: DatabaseSync;
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const owner={organizationId:'org_a',userId:'owner',role:'owner'} as DeviceSessionContext;
const bytes = new TextEncoder().encode('company contents');
beforeEach(async()=>{
  vi.clearAllMocks();db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workspace_backups(backup_id TEXT PRIMARY KEY,organization_id TEXT,installation_id TEXT,created_by TEXT,manifest_json TEXT,size_bytes INTEGER,state TEXT,created_at TEXT,completed_at TEXT); CREATE TABLE company_copies(organization_id TEXT PRIMARY KEY,backup_id TEXT,published_by TEXT,published_at TEXT)');
  stubs.database.mockReturnValue({prepare:(sql:string)=>{const stmt=db.prepare(sql);let args: (string|number|null)[]=[];const query={bind:(...v:typeof args)=>{args=v;return query;},first:async()=>stmt.get(...args)??null,run:async()=>({meta:{changes:Number(stmt.run(...args).changes)}})};return query;}});
  const sha256=await sha256Hex(bytes);
  const manifest=JSON.stringify({format:'zentra-cloud-backup',version:1,app_version:'1.65.0',sha256,size_bytes:bytes.length,chunks:[{sha256,size_bytes:bytes.length}]});
  for(const [backup,org] of [[id,'org_a'],[other,'org_b']])db.prepare('INSERT INTO workspace_backups VALUES(?,?,?,?,?,?,?,?,?)').run(backup,org,'device','owner',manifest,bytes.length,'complete','2026-09-14','2026-09-14');
  stubs.fileArchive.mockReturnValue({get:vi.fn(async()=>({body:bytes}))});
  stubs.session.mockResolvedValue(owner);
});
afterEach(()=>db.close());
describe('private company handoff',()=>{
  it('does not expose historical backups before explicit publication',async()=>{expect(await companyCopy('org_a')).toBeNull();await expect(requireCompanyCopy('org_a')).rejects.toThrow('partager');});
  it('requires an administrator and explicit full-data consent',async()=>{
    for(const role of ['member','accountant','read_only'])await expect(publishCompanyCopy({...owner,role} as DeviceSessionContext,id,true)).rejects.toThrow('administrateurs');
    for(const confirmation of [false,undefined,'true',1])await expect(publishCompanyCopy(owner,id,confirmation)).rejects.toThrow('Confirmez');
    expect(await companyCopy('org_a')).toBeNull();
  });
  it('refuses another organization, incomplete and deleted archives',async()=>{
    await expect(publishCompanyCopy(owner,other,true)).rejects.toThrow('introuvable');
    for(const state of ['uploading','deleting','deleted']){db.prepare('UPDATE workspace_backups SET state=? WHERE backup_id=?').run(state,id);await expect(publishCompanyCopy(owner,id,true)).rejects.toThrow();}
  });
  it('publishes exactly one complete copy, bound to the actor organization',async()=>{
    expect((await publishCompanyCopy(owner,id,true))?.backupId).toBe(id);
    expect(await companyCopy('org_b')).toBeNull();
    await expect(requireCompanyCopy('org_a',other)).rejects.toThrow('changé');
    expect(db.prepare('SELECT published_by FROM company_copies').get()?.published_by).toBe('owner');
  });
  it('allows each active team role to retrieve only the published snapshot',async()=>{
    await publishCompanyCopy(owner,id,true);
    for(const role of ['owner','admin','member','accountant','read_only']) {
      stubs.session.mockResolvedValue({...owner,role});
      const response=await GET(new Request('https://zentra.test/api/account/company-copy'));
      expect(response.status).toBe(200);const body=await response.json() as {organizationId:string;backup_id:string};
      expect(body.organizationId).toBe('org_a');expect(body.backup_id).toBe(id);
    }
    stubs.session.mockResolvedValue({...owner,organizationId:'org_b'});
    expect((await GET(new Request(`https://zentra.test/api/account/company-copy?id=${id}`))).status).toBe(409);
  });
  it('enforces identity again for each chunk, with no public or stale access',async()=>{
    await publishCompanyCopy(owner,id,true);
    expect((await GET(new Request(`https://zentra.test/api/account/company-copy?id=${id}&index=0`))).status).toBe(200);
    for(const index of ['-1','0x0','100','1'])expect((await GET(new Request(`https://zentra.test/api/account/company-copy?id=${id}&index=${index}`))).status).toBe(400);
    stubs.session.mockRejectedValue(new AccountPublicError('Connexion requise.',401));
    expect((await GET(new Request(`https://zentra.test/api/account/company-copy?id=${id}&index=0`))).status).toBe(401);
    stubs.session.mockResolvedValue(owner);db.prepare("UPDATE workspace_backups SET state='deleted' WHERE backup_id=?").run(id);
    expect((await GET(new Request(`https://zentra.test/api/account/company-copy?id=${id}&index=0`))).status).toBe(409);
  });
});
