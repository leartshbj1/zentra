import { accountJsonError, accountNoStoreHeaders, enforceAccountRateLimit, normalizedEmail, requireDeviceSession } from '@/lib/account';
import { AccountPublicError, hashOpaqueToken, isAccountRole, newInvitationToken, roleCanManageMembers } from '@/lib/account-security';
import { database } from '@/lib/runtime';
import { teamSeats, requireInvitationCapacity } from '@/lib/team-seats';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { supabaseServerClient } from '@/lib/supabase-server-runtime';
import { companyProfile } from '@/lib/company-profile';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const session = await requireDeviceSession(request), manage = roleCanManageMembers(session.role), db = database();
    const profiles = await supabaseServerClient().select<{profile: Record<string,unknown>;updated_at:string}>('zentra_company_profiles', { organization_id:`eq.${session.organizationId}`,select:'profile,updated_at',limit:1 });
    const members = manage ? await db.prepare('SELECT membership_id AS id,email,role FROM organization_members WHERE organization_id=? AND revoked_at IS NULL ORDER BY joined_at').bind(session.organizationId).all() : { results:[] };
    const invitations = manage ? await db.prepare('SELECT invitation_id AS id,invited_email AS email,role,expires_at AS expiresAt FROM organization_invitations WHERE organization_id=? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>=? ORDER BY created_at DESC').bind(session.organizationId,Math.floor(Date.now()/1000)).all() : {results:[]};
    return Response.json({ organizationId:session.organizationId, organizationName:session.organizationName,role:session.role,canManage:manage,seats:await teamSeats(session.organizationId),members:members.results,invitations:invitations.results,profile:profiles[0]?.profile ?? null },{headers:accountNoStoreHeaders()});
  } catch(error) { return accountJsonError(error); }
}
export async function POST(request: Request) {
  try {
    const actor = await requireDeviceSession(request);
    if (!roleCanManageMembers(actor.role)) throw new AccountPublicError('Seuls le titulaire et les administrateurs peuvent gérer les invitations et les coordonnées partagées.',403);
    const body = await readJsonObjectWithinLimit(request, 32_768), db = database(), now = Math.floor(Date.now()/1000);
    await enforceAccountRateLimit(request,'device-team',`${actor.userId}:${actor.organizationId}`,30);
    if (body.action === 'profile') {
      const profile = companyProfile(body.profile);
      await supabaseServerClient().upsert('zentra_company_profiles',{organization_id:actor.organizationId,profile,updated_by:actor.userId,updated_at:new Date().toISOString()},{onConflict:'organization_id'});
      return Response.json({saved:true},{headers:accountNoStoreHeaders()});
    }
    if (body.action === 'revoke') {
      if (typeof body.invitationId !== 'string' || !/^inv_[0-9a-f-]{36}$/i.test(body.invitationId)) throw new AccountPublicError('Cette invitation est invalide.');
      const result = await db.prepare('UPDATE organization_invitations SET revoked_at=? WHERE invitation_id=? AND organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL').bind(now,body.invitationId,actor.organizationId).run();
      if(result.meta.changes !== 1) throw new AccountPublicError('Cette invitation est déjà utilisée ou annulée. Actualisez la liste.',409);
      return Response.json({revoked:true},{headers:accountNoStoreHeaders()});
    }
    if(body.action !== 'invite' || !isAccountRole(body.role) || body.role === 'owner') throw new AccountPublicError('Choisissez un rôle pour cette invitation.');
    const email = normalizedEmail(typeof body.email === 'string' ? body.email : '');
    await requireInvitationCapacity(actor.organizationId);
    const duplicate = await db.prepare('SELECT 1 FROM organization_members WHERE organization_id=? AND email=? AND revoked_at IS NULL UNION ALL SELECT 1 FROM organization_invitations WHERE organization_id=? AND invited_email=? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>=? LIMIT 1').bind(actor.organizationId,email,actor.organizationId,email,now).first();
    if (duplicate) throw new AccountPublicError('Cette personne a déjà un accès ou une invitation en attente.',409);
    const token = newInvitationToken(), id = `inv_${crypto.randomUUID()}`, expires = now + 7*86400;
    // Existing database triggers enforce capacity again atomically, including concurrent invitations.
    await db.prepare('INSERT INTO organization_invitations(invitation_id,organization_id,token_hash,invited_email,role,created_by_user_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,actor.organizationId,await hashOpaqueToken('invitation',token),email,body.role,actor.userId,now,expires).run();
    const url = new URL('/invitation', request.url); url.searchParams.set('token',token);
    return Response.json({invitation:{id,url:url.toString(),email,role:body.role,expiresAt:expires}},{status:201,headers:accountNoStoreHeaders()});
  } catch(error) { return accountJsonError(error); }
}
