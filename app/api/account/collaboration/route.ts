import { accountJsonError,accountNoStoreHeaders,enforceSyncRateLimit,requireDeviceSession } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { collaborationBase,collaborationHead,collaborationRevision,collaborationRevisionHead,collaborationSnapshot,commitCollaboration,downloadCollaborationChunk,prepareCollaboration,receiveCollaborationChunk } from '@/lib/company-collaboration';
import { companyContentManifest, prepareCompanyContent, readCompanyContent, receiveCompanyContent } from '@/lib/company-content';
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
      await enforceSyncRateLimit(request,'collaboration-watch',`${actor.organizationId}:${actor.installationId}`,1500);
      const head=await watchCompanyRevision(actor.organizationId,after,request.signal,{
        configuration:supabaseRealtimeConfiguration(),fetch:(...args)=>fetch(...args),head:()=>collaborationRevisionHead(actor),
      });
      // Membership may have been revoked during the long poll.
      await requireDeviceSession(request);
      return Response.json(head,{headers:accountNoStoreHeaders()});
    }
    await enforceSyncRateLimit(request,query.has('blob')?'collaboration-content-read':'collaboration-read',`${actor.organizationId}:${actor.installationId}`,query.has('blob')?20000:3000);
    if(query.has('content')||query.has('blob')) {
      const snapshot=await collaborationSnapshot(actor,query.get('id'));
      if(snapshot.content_version!==1)throw new AccountPublicError('Ce format de transfert est indisponible.',409);
      if(query.has('blob')) {
        const bytes=await readCompanyContent(actor,snapshot.id,query.get('blob'));
        const headers=new Headers(accountNoStoreHeaders());headers.set('Content-Type','application/octet-stream');headers.set('Content-Length',String(bytes.length));
        return new Response(bytes as BodyInit,{headers});
      }
      return Response.json({entries:await companyContentManifest(actor,snapshot.id,snapshot.manifest)},{headers:accountNoStoreHeaders()});
    }
    if(query.has('revision')) {
      const raw=query.get('revision')!;
      if(!/^[1-9][0-9]{0,15}$/.test(raw)||query.has('index')||query.has('id'))throw new AccountPublicError('La version de référence est invalide.');
      return Response.json(await collaborationBase(actor,Number(raw)),{headers:accountNoStoreHeaders()});
    }
    if(query.has('index')) {
      const bytes=await downloadCollaborationChunk(actor,query.get('id'),query.get('index'));
      const headers=new Headers(accountNoStoreHeaders());
      headers.set('Content-Type','application/octet-stream');
      headers.set('Content-Length',String(bytes.length));
      return new Response(bytes as BodyInit,{headers});
    }
    const after=query.get('after');
    if(after!==null&&!/^(0|[1-9][0-9]{0,15})$/.test(after))throw new AccountPublicError('La version de référence est invalide.');
    return Response.json(await collaborationHead(actor,after===null?undefined:collaborationRevision(Number(after))),{headers:accountNoStoreHeaders()});
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
    await enforceSyncRateLimit(request,'collaboration-write',`${actor.organizationId}:${actor.installationId}`,500);
    const body=await readJsonObjectWithinLimit(request,1024*1024);
    if(body.action==='commit')return Response.json(await commitCollaboration(actor,body.id),{headers:accountNoStoreHeaders()});
    if(body.action==='prepare-content')return Response.json(await prepareCompanyContent(actor,body),{headers:accountNoStoreHeaders()});
    if(body.action!=='prepare')throw new AccountPublicError('Action de synchronisation invalide.');
    return Response.json(await prepareCollaboration(actor,body),{headers:accountNoStoreHeaders()});
  }catch(error){return accountJsonError(error);}
}
export async function PUT(request:Request) {
  try {
    const actor=await requireDeviceSession(request),query=new URL(request.url).searchParams;
    await enforceSyncRateLimit(request,query.has('blob')?'collaboration-content-write':'collaboration-files',`${actor.organizationId}:${actor.installationId}`,query.has('blob')?20000:2000);
    const bytes=await readBytesBodyWithinLimit(request,(query.has('blob')?1:8)*1024*1024);
    if(query.has('blob'))return Response.json(await receiveCompanyContent(actor,query.get('id'),query.get('blob'),bytes),{headers:accountNoStoreHeaders()});
    return Response.json(await receiveCollaborationChunk(actor,query.get('id'),query.get('index'),bytes),{headers:accountNoStoreHeaders()});
  }catch(error){return accountJsonError(error);}
}
