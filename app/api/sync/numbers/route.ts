import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import {
  AccountPublicError,
  roleCanWriteInvoices,
} from '@/lib/account-security';
import {
  numberReservationRequest,
  reserveDocumentNumbers,
} from '@/lib/document-number-reservations';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { supabaseServerClient } from '@/lib/supabase-server-runtime';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    if (!roleCanWriteInvoices(session.role))
      throw new AccountPublicError(
        'Votre accès est limité à la consultation.',
        403,
      );
    await enforceAccountRateLimit(
      request,
      'document-number-reservations',
      `${session.organizationId}:${session.installationId}`,
      240,
    );
    const input = numberReservationRequest(
      await readJsonObjectWithinLimit(request, 8192),
    );
    const supabase=supabaseServerClient();
    const shared=await supabase.select<{revision:number}>('zentra_workspaces',{organization_id:`eq.${session.organizationId}`,select:'revision',limit:1});
    const reservation=shared[0]?.revision>0 ? await supabase.rpc('zentra_reserve_workspace_numbers',{
      p_organization:session.organizationId,p_installation:session.installationId,p_request:input.request_id,
      p_prefix:input.prefix,p_year:input.year,p_minimum:input.minimum,p_count:input.count,
    }) : await reserveDocumentNumbers(session,input);
    return Response.json(reservation, {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    return accountJsonError(error);
  }
}
