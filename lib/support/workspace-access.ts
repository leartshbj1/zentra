export const SUPPORT_WORKSPACES_SQL = `SELECT DISTINCT w.*,CASE WHEN w.owner_id=? THEN 'owner' WHEN m.id IS NOT NULL THEN m.role WHEN om.role IN ('owner','admin') THEN 'admin' ELSE 'member' END AS role
        FROM support_workspaces w LEFT JOIN support_members m ON m.workspace_id=w.id AND m.email=?
        LEFT JOIN support_gestion_links l ON l.workspace_id=w.id AND l.enabled=1
        LEFT JOIN organizations o ON o.organization_id=l.organization_id
        LEFT JOIN complete_subscriptions c ON c.subscription_id=o.subscription_id
        LEFT JOIN organization_members om ON om.organization_id=o.organization_id AND om.user_id=? AND om.revoked_at IS NULL AND om.role IN ('owner','admin','accountant','member')
        WHERE w.owner_id=? OR m.id IS NOT NULL OR (c.subscription_id IS NOT NULL AND om.user_id IS NOT NULL) ORDER BY w.created_at,w.id`;
