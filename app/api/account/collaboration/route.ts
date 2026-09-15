import { accountJsonError,accountNoStoreHeaders,enforceAccountRateLimit,requireDeviceSession } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { collaborationHead,collaborationRevision,collaborationRevisionHead,commitCollaboration,downloadCollaborationChunk,prepareCollaboration,receiveCollaborationChunk } from '@/lib/company-collaboration';
import { watchCompanyRevision } from '@/lib/company-realtime';
import { supabaseRealtimeConfiguration } from '@/lib/supabase-server-runtime';
import { readBytesBodyWithinLimit,readJsonObjectWithinLimit } from '@/lib/request-body';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {
    const actor=await requireDeviceSession(request),query=new URL(request.url).searchParams;
    if(query.has('watch')) {
      const raw=query.get('watch')!;
      if(!/^(0|[1-9][0-9]{0,15})$/.test(raw)||query.has('index'))throw new AccountPublicError('La version de l’entreprise est invalide.');
      const after=collaborationRevision(Number(raw));
      await enforceAccountRateLimit(request,'collaboration-watch',`${actor.organizationId}:${actor.installationId}`,1500);
      const head=await watchCompanyRevision(actor.organizationId,after,request.signal,{
        configuration:supabaseRealtimeConfiguration(),fetch:(...args)=>fetch(...args),head:()=>collaborationRevisionHead(actor),
      });
      // Membership may have been revoked during the long poll.
      await requireDeviceSession(request);
      return Response.json(head,{headers:accountNoStoreHeaders()});
    }
    await enforceAccountRateLimit(request,'collaboration-read',`${actor.organizationId}:${actor.installationId}`,3000);
    if(query.has('index')) {
      const bytes=await downloadCollaborationChunk(actor,query.get('id'),query.get('index'));
      const headers=new Headers(accountNoStoreHeaders());
      headers.set('Content-Type','application/octet-stream');
      headers.set('Content-Length',String(bytes.length));
      return new Response(bytes as BodyInit,{headers});
    }
    return Response.json(await collaborationHead(actor),{headers:accountNoStoreHeaders()});
  }catch(error){
    if(new URL(request.url).searchParams.has('watch'))console.error('Company watch failed',{
      kind:error instanceof Error?error.name:'UnknownError',
      reason:error instanceof Error?error.message.replace(/(?:sb_secret_|eyJ|zds_)[A-Za-z0-9_.-]+/g,'[redacted]').replace(/https?:\S+/g,'[endpoint]').slice(0,240):'Unavailable',
    });
    return accountJsonError(error);
  }
}
export async function POST(request:Request) {
  try {
    const actor=await requireDeviceSession(request);
    await enforceAccountRateLimit(request,'collaboration-write',`${actor.organizationId}:${actor.installationId}`,500);
    const body=await readJsonObjectWithinLimit(request,32768);
    if(body.action==='commit')return Response.json(await commitCollaboration(actor,body.id),{headers:accountNoStoreHeaders()});
    if(body.action!=='prepare')throw new AccountPublicError('Action de synchronisation invalide.');
    return Response.json(await prepareCollaboration(actor,body),{headers:accountNoStoreHeaders()});
  }catch(error){return accountJsonError(error);}
}
export async function PUT(request:Request) {
  try {
    const actor=await requireDeviceSession(request),query=new URL(request.url).searchParams;
    await enforceAccountRateLimit(request,'collaboration-files',`${actor.organizationId}:${actor.installationId}`,2000);
    const bytes=await readBytesBodyWithinLimit(request,8*1024*1024);
    return Response.json(await receiveCollaborationChunk(actor,query.get('id'),query.get('index'),bytes),{headers:accountNoStoreHeaders()});
  }catch(error){return accountJsonError(error);}
}
