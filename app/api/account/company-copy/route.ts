import { accountJsonError, accountNoStoreHeaders, enforceAccountRateLimit, requireDeviceSession } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { requireCompanyCopy } from '@/lib/company-copy';
import { downloadBackupChunk, getBackup } from '@/lib/workspace-backup';
import { requireLegacyCountryTransport } from '@/lib/international/legacy-country-guard';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const actor = await requireDeviceSession(request);
    await requireLegacyCountryTransport(actor.organizationId);
    await enforceAccountRateLimit(request,'company-copy',`${actor.organizationId}:${actor.userId}`,2000);
    const query = new URL(request.url).searchParams;
    const id = query.get('id'), index = query.get('index');
    const copy = await requireCompanyCopy(actor.organizationId,id ?? undefined);
    if (index === null) return Response.json({organizationId:actor.organizationId,copy, ...await getBackup(actor.organizationId,copy.backupId)}, {headers:accountNoStoreHeaders()});
    if (!id || !/^(0|[1-9][0-9]?)$/.test(index)) throw new AccountPublicError('Le fragment demandé est invalide.');
    const {part,object} = await downloadBackupChunk(actor.organizationId,copy.backupId,Number(index));
    const headers = new Headers(accountNoStoreHeaders());
    headers.set('Content-Type','application/octet-stream');
    headers.set('Content-Length',String(part.size_bytes));
    headers.set('X-Zentra-Sha256',part.sha256);
    return new Response(object.body,{headers});
  } catch(error) {return accountJsonError(error);}
}
