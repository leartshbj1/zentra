export const SUPPORT_WORKSPACES_SQL = `WITH company_seats AS (
  SELECT m.*,s.seat_limit,ROW_NUMBER() OVER(PARTITION BY m.organization_id ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END,m.joined_at,m.membership_id) AS seat
  FROM organization_members m JOIN organizations o ON o.organization_id=m.organization_id JOIN subscriptions s ON s.subscription_id=o.subscription_id WHERE m.revoked_at IS NULL
) SELECT DISTINCT w.*,CASE WHEN w.owner_id=? THEN 'owner' WHEN m.id IS NOT NULL THEN m.role WHEN om.role IN ('owner','admin') THEN 'admin' ELSE 'member' END AS role
        FROM support_workspaces w LEFT JOIN support_members m ON m.workspace_id=w.id AND m.email=?
        LEFT JOIN support_gestion_links l ON l.workspace_id=w.id
        LEFT JOIN organizations o ON o.organization_id=l.organization_id
        LEFT JOIN complete_subscriptions c ON c.subscription_id=o.subscription_id
        LEFT JOIN company_seats om ON om.organization_id=o.organization_id AND om.user_id=? AND (om.seat_limit IS NULL OR om.seat<=om.seat_limit) AND om.role IN ('owner','admin','accountant','member')
        WHERE w.owner_id=? OR m.id IS NOT NULL OR (c.subscription_id IS NOT NULL AND om.user_id IS NOT NULL) ORDER BY w.created_at,w.id`;
