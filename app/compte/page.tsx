import { getZentraUser, zentraSignInPath } from '@/app/zentra-auth';
import { TeamInvite } from '@/components/team-invite';
import { TeamAccessList } from '@/components/team-access-list';
import { ZentraSignOut } from '@/components/zentra-sign-out';
import { membershipsForUser } from '@/lib/account';
import { roleCanManageMembers, type AccountRole } from '@/lib/account-security';
import { database } from '@/lib/runtime';
import { Archive, Laptop, ShieldCheck, UsersRound } from 'lucide-react';

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<AccountRole, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  accountant: 'Comptable',
  member: 'Collaborateur',
  read_only: 'Lecture seule',
};

type OrganizationStats = {
  members: number;
  devices: number;
  archives: number;
};

async function organizationStats(organizationId: string) {
  const row = await database()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM organization_members member
          WHERE member.organization_id=? AND member.revoked_at IS NULL) AS members,
        (SELECT COUNT(*) FROM device_sessions session
          WHERE session.organization_id=? AND session.revoked_at IS NULL
            AND session.expires_at>=?) AS devices,
        (SELECT COUNT(*) FROM invoice_archives archive
          WHERE archive.organization_id=? AND archive.storage_status='stored') AS archives`,
    )
    .bind(
      organizationId,
      organizationId,
      Math.floor(Date.now() / 1000),
      organizationId,
    )
    .first<OrganizationStats>();
  return row ?? { members: 0, devices: 0, archives: 0 };
}

async function organizationAccess(organizationId: string) {
  const db = database();
  const now = Math.floor(Date.now() / 1_000);
  const [memberRows, deviceRows, invitationRows, archiveRows] =
    await Promise.all([
      db
        .prepare(
          `SELECT membership_id,user_id,email,display_name,role
           FROM organization_members
          WHERE organization_id=? AND revoked_at IS NULL
          ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                   joined_at,membership_id`,
        )
        .bind(organizationId)
        .all<{
          membership_id: string;
          user_id: string;
          email: string;
          display_name: string | null;
          role: string;
        }>(),
      db
        .prepare(
          `SELECT session.session_id,session.user_id,session.installation_id,
                session.last_seen_at,session.expires_at,member.email
           FROM device_sessions session
           JOIN organization_members member
             ON member.organization_id=session.organization_id
            AND member.user_id=session.user_id AND member.revoked_at IS NULL
          WHERE session.organization_id=? AND session.revoked_at IS NULL
            AND session.expires_at>=?
          ORDER BY session.last_seen_at DESC`,
        )
        .bind(organizationId, now)
        .all<{
          session_id: string;
          user_id: string;
          installation_id: string;
          last_seen_at: number;
          expires_at: number;
          email: string;
        }>(),
      db
        .prepare(
          `SELECT invitation_id,invited_email,role,created_at,expires_at
           FROM organization_invitations
          WHERE organization_id=? AND accepted_at IS NULL
            AND revoked_at IS NULL AND expires_at>=?
          ORDER BY created_at DESC,invitation_id`,
        )
        .bind(organizationId, now)
        .all<{
          invitation_id: string;
          invited_email: string | null;
          role: string;
          created_at: number;
          expires_at: number;
        }>(),
      db
        .prepare(
          `SELECT archive_id,invoice_number,revision,issue_date,retention_until,
                stored_at,content_sha256
           FROM invoice_archives
          WHERE organization_id=? AND storage_status='stored'
          ORDER BY issue_date DESC,invoice_number DESC,revision DESC
          LIMIT 10`,
        )
        .bind(organizationId)
        .all<{
          archive_id: string;
          invoice_number: string;
          revision: number;
          issue_date: string;
          retention_until: string;
          stored_at: number;
          content_sha256: string;
        }>(),
    ]);
  return {
    members: memberRows.results.map((row) => ({
      id: row.membership_id,
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    })),
    devices: deviceRows.results.map((row) => ({
      id: row.session_id,
      userId: row.user_id,
      ownerEmail: row.email,
      installationId: row.installation_id,
      lastSeenAt: new Date(row.last_seen_at * 1_000).toISOString(),
      expiresAt: new Date(row.expires_at * 1_000).toISOString(),
    })),
    invitations: invitationRows.results.map((row) => ({
      id: row.invitation_id,
      email: row.invited_email,
      role: row.role,
      createdAt: new Date(row.created_at * 1_000).toISOString(),
      expiresAt: new Date(row.expires_at * 1_000).toISOString(),
    })),
    archives: archiveRows.results.map((row) => ({
      id: row.archive_id,
      invoiceNumber: row.invoice_number,
      revision: row.revision,
      issueDate: row.issue_date,
      retentionUntil: row.retention_until,
      storedAt: new Date(row.stored_at * 1_000).toISOString(),
      contentSha256: row.content_sha256,
    })),
  };
}

export default async function AccountPage() {
  const user = await getZentraUser();
  if (!user) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f6f4ee] px-5 py-14 text-[#173d2c]">
        <div className="w-full max-w-xl rounded-[2rem] border border-[#d9d4c9] bg-white p-8 shadow-[0_30px_90px_rgba(29,45,35,.1)] sm:p-10">
          <ShieldCheck className="size-11 text-[#a66b1f]" />
          <h1 className="mt-5 text-4xl font-semibold tracking-[-.04em]">
            Compte Zentra
          </h1>
          <p className="mt-4 leading-7 text-[#5f6962]">
            Connectez-vous pour gérer les accès de votre entreprise, vos
            appareils autorisés et le coffre de factures.
          </p>
          <a
            href={zentraSignInPath('/compte')}
            className="mt-7 inline-flex min-h-12 items-center rounded-full bg-[#173d2c] px-6 text-sm font-semibold text-white"
          >
            Se connecter en sécurité
          </a>
        </div>
      </main>
    );
  }

  const memberships = await membershipsForUser(user.userId);
  const organizations = await Promise.all(
    memberships.map(async (membership) => ({
      ...membership,
      stats: await organizationStats(membership.organizationId),
      access: await organizationAccess(membership.organizationId),
    })),
  );

  return (
    <main className="min-h-screen bg-[#f6f4ee] px-5 py-12 text-[#173d2c] sm:py-16">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <a href="/" className="text-sm font-semibold text-[#52645a]">
              ← Zentra
            </a>
            <h1 className="mt-5 text-4xl font-semibold tracking-[-.04em] sm:text-5xl">
              Mon compte
            </h1>
            <p className="mt-2 text-[#5f6962]">
              {user.displayName} · {user.email}
            </p>
          </div>
          <ZentraSignOut provider={user.provider} returnTo="/compte" />
        </header>

        {organizations.length === 0 ? (
          <section className="mt-10 rounded-[2rem] border border-[#e2c98e] bg-[#fff8e9] p-7 sm:p-9">
            <h2 className="text-2xl font-semibold">Aucune entreprise reliée</h2>
            <p className="mt-3 max-w-2xl leading-7 text-[#6e6044]">
              Achetez Zentra puis associez l’abonnement depuis la page de
              succès, ou ouvrez le lien d’invitation transmis par votre
              entreprise.
            </p>
            <a
              href="/download"
              className="mt-6 inline-flex min-h-11 items-center rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white"
            >
              Voir l’offre Zentra
            </a>
          </section>
        ) : (
          <div className="mt-10 space-y-8">
            {organizations.map((organization) => (
              <section
                key={organization.organizationId}
                className="overflow-hidden rounded-[2rem] border border-[#d9d4c9] bg-[#fbfaf7] shadow-[0_20px_70px_rgba(29,45,35,.06)]"
              >
                <div className="p-6 sm:p-8">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[.2em] text-[#a66b1f]">
                        Espace d’entreprise
                      </p>
                      <h2 className="mt-2 text-3xl font-semibold tracking-[-.03em]">
                        {organization.organizationName}
                      </h2>
                    </div>
                    <span className="self-start rounded-full bg-[#e8f0ea] px-4 py-2 text-xs font-semibold text-[#24593d]">
                      {ROLE_LABEL[organization.role]}
                    </span>
                  </div>
                  <div className="mt-7 grid gap-3 sm:grid-cols-3">
                    {[
                      {
                        icon: UsersRound,
                        value: organization.stats.members,
                        label: 'personnes · sans limite',
                      },
                      {
                        icon: Laptop,
                        value: organization.stats.devices,
                        label: 'appareils actifs',
                      },
                      {
                        icon: Archive,
                        value: organization.stats.archives,
                        label: 'versions archivées',
                      },
                    ].map((stat) => (
                      <div
                        key={stat.label}
                        className="rounded-2xl bg-white p-5"
                      >
                        <stat.icon className="size-5 text-[#a66b1f]" />
                        <p className="mt-3 text-2xl font-semibold">
                          {stat.value}
                        </p>
                        <p className="mt-1 text-sm text-[#667168]">
                          {stat.label}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-6">
                    <TeamAccessList
                      key={`${organization.organizationId}:${organization.access.invitations
                        .map((invitation) => invitation.id)
                        .join(',')}`}
                      organizationId={organization.organizationId}
                      currentUserId={user.userId}
                      canManage={roleCanManageMembers(organization.role)}
                      canRemoveAdmins={organization.role === 'owner'}
                      members={organization.access.members}
                      devices={organization.access.devices}
                      invitations={
                        roleCanManageMembers(organization.role)
                          ? organization.access.invitations
                          : []
                      }
                    />
                  </div>
                  <div className="mt-6 rounded-3xl border border-[#d9d4c9] bg-white p-5 sm:p-6">
                    <div className="flex items-start gap-3">
                      <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-[#edf5ef] text-[#24593d]">
                        <Archive className="size-5" />
                      </span>
                      <div>
                        <h3 className="font-semibold">Coffre de factures</h3>
                        <p className="mt-1 text-sm leading-6 text-[#667168]">
                          Téléchargement conservé pendant la durée indiquée,
                          même si l’abonnement Zentra est ensuite résilié.
                        </p>
                      </div>
                    </div>
                    {organization.access.archives.length === 0 ? (
                      <p className="mt-5 rounded-2xl bg-[#f4f2ec] p-4 text-sm text-[#667168]">
                        Aucune facture n’a encore été déposée depuis
                        l’application.
                      </p>
                    ) : (
                      <ul className="mt-5 divide-y divide-[#e7e3da]">
                        {organization.access.archives.map((archive) => (
                          <li
                            key={archive.id}
                            className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0">
                              <p className="font-semibold">
                                {archive.invoiceNumber} · version{' '}
                                {archive.revision}
                              </p>
                              <p className="mt-1 text-sm text-[#667168]">
                                Émise le {archive.issueDate} · conservée
                                jusqu’au {archive.retentionUntil}
                              </p>
                              <p className="mt-1 truncate font-mono text-[11px] text-[#839087]">
                                SHA-256 {archive.contentSha256}
                              </p>
                            </div>
                            <a
                              href={`/api/archive/account/${encodeURIComponent(archive.id)}`}
                              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-[#b9c8bd] px-5 text-sm font-semibold"
                            >
                              Télécharger le PDF
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {organization.stats.archives > 0 ? (
                      <a
                        href={`/compte/archives?organizationId=${encodeURIComponent(organization.organizationId)}`}
                        className="mt-5 inline-flex min-h-11 items-center justify-center rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white"
                      >
                        Rechercher dans toutes les archives
                      </a>
                    ) : null}
                  </div>
                </div>
                <div className="border-t border-[#e0ddd5] bg-white p-6 sm:p-8">
                  {roleCanManageMembers(organization.role) ? (
                    <TeamInvite organizationId={organization.organizationId} />
                  ) : (
                    <p className="rounded-2xl bg-[#f4f2ec] p-5 text-sm leading-6 text-[#5f6962]">
                      Seuls le propriétaire et les administrateurs peuvent
                      inviter ou retirer des membres.
                    </p>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
