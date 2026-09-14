import { accountJsonError, accountNoStoreHeaders, enforceAccountRateLimit, requireDeviceSession } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { requireCompanyCopy } from '@/lib/company-copy';
import { downloadBackupChunk, getBackup } from '@/lib/workspace-backup';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const actor = await requireDeviceSession(request);
    await enforceAccountRateLimit(request,'company-copy',`${actor.organizationId}:${actor.userId}`,2000);
    const query = new URL(request.url).searchParams;
    const id = query.get('id'), index = query.get('index');
    const copy = await requireCompanyCopy(actor.organizationId,id ?? undefined);
    if (index === null) return Response.json({organizationId:actor.organizationId,copy, ...await getBackup(actor.organizationId,copy.backupId)}, {headers:accountNoStoreHeaders()});
    if (!id || !/^(0|[1-9][0-9]?)$/.test(index)) throw new AccountPublicError('Le fragment demandé est invalide.');
    const {part,object} = await downloadBackupChunk(actor.organizationId,copy.backupId,Number(index));
    return new Response(object.body,{headers:{...accountNoStoreHeaders(),'Content-Type':'application/octet-stream','Content-Length':String(part.size_bytes),'X-Zentra-Sha256':part.sha256}});
  } catch(error) {return accountJsonError(error);}
}
