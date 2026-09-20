import { database } from '@/lib/runtime';
type OrganizationStats = {
  members: number;
  devices: number;
  archives: number;
};

export async function organizationStats(organizationId: string) {
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

export async function organizationAccess(organizationId: string) {
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

