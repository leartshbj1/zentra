import {beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({session:vi.fn(),limit:vi.fn(),head:vi.fn(),download:vi.fn(),prepare:vi.fn(),commit:vi.fn(),receive:vi.fn()}));
vi.mock('./account',()=>({
 requireDeviceSession:mock.session,enforceAccountRateLimit:mock.limit,
 accountNoStoreHeaders:()=>new Headers({'Cache-Control':'no-store','Pragma':'no-cache'}),
 accountJsonError:()=>Response.json({error:'Accès refusé'},{status:401}),
}));
vi.mock('./company-collaboration',()=>({collaborationHead:mock.head,downloadCollaborationChunk:mock.download,prepareCollaboration:mock.prepare,commitCollaboration:mock.commit,receiveCollaborationChunk:mock.receive}));
import {GET,POST,PUT} from '../app/api/account/collaboration/route';
const actor={organizationId:'organization-a',installationId:'device-a',userId:'user-a',role:'owner'};
beforeEach(()=>{vi.clearAllMocks();mock.session.mockResolvedValue(actor);mock.limit.mockResolvedValue(undefined);});
describe('company collaboration HTTP boundary',()=>{
 it('requires a verified device session before every operation',async()=>{
  mock.session.mockRejectedValue(new Error('invalid session'));
  for(const handler of [GET,POST,PUT])expect((await handler(new Request('https://zentra.example/api/account/collaboration'))).status).toBe(401);
  expect(mock.head).not.toHaveBeenCalled();expect(mock.prepare).not.toHaveBeenCalled();expect(mock.receive).not.toHaveBeenCalled();
 });
 it('returns private bytes without losing the no-store headers',async()=>{
  mock.download.mockResolvedValue(new Uint8Array([1,2,3]));
  const response=await GET(new Request('https://zentra.example/api/account/collaboration?id=file&index=0&organizationId=forged'));
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toBe('application/octet-stream');expect(response.headers.get('content-length')).toBe('3');
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1,2,3]);
  expect(mock.download).toHaveBeenCalledWith(actor,'file','0');
 });
 it('binds publication to the session instead of supplied company or user fields',async()=>{
  mock.commit.mockResolvedValue({committed:true,revision:1});
  const response=await POST(new Request('https://zentra.example/api/account/collaboration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'commit',id:'snapshot',organizationId:'forged',userId:'forged'})}));
  expect(response.status).toBe(200);expect(mock.commit).toHaveBeenCalledWith(actor,'snapshot');
 });
});
