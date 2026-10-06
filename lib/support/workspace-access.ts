// Limit the ranked organizations, never the members within them: every active
// person still consumes a seat, including roles that cannot open Support.
// The actor row preserves the existing four-bind contract used by service.ts.
// PF Complet collaborators require the current proof view and its immutable
// seat limit. Legacy Complete rows and cached subscription seats cannot admit
// them after expiry or reversal; owners retain their billing navigation.
export const SUPPORT_WORKSPACES_SQL = `WITH actor AS (
  SELECT ? AS owner_id,? AS email,? AS member_id,? AS access_owner_id
), company_seats AS (
  SELECT m.*,s.seat_limit,ROW_NUMBER() OVER(PARTITION BY m.organization_id ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END,m.joined_at,m.membership_id) AS seat
  FROM organization_members m JOIN organizations o ON o.organization_id=m.organization_id JOIN subscriptions s ON s.subscription_id=o.subscription_id
  WHERE m.revoked_at IS NULL AND m.organization_id IN (
    SELECT candidate.organization_id FROM organization_members candidate CROSS JOIN actor
    WHERE candidate.user_id=actor.member_id AND candidate.revoked_at IS NULL
  )
), prepaid_company_seats AS (
  SELECT m.*,r.owner_id AS paid_owner_id,r.workspace_id AS paid_workspace_id,r.seat_limit,
    ROW_NUMBER() OVER(PARTITION BY m.organization_id ORDER BY CASE WHEN m.user_id=r.owner_id AND m.role='owner' THEN 0 WHEN m.role='owner' THEN 1 ELSE 2 END,m.joined_at,m.membership_id) AS seat
  FROM organization_members m JOIN prepaid_current_company_rights r ON r.organization_id=m.organization_id
  WHERE m.revoked_at IS NULL AND r.product_key LIKE 'complet:%' AND r.support_plan_id IS NOT NULL
    AND m.organization_id IN (
      SELECT candidate.organization_id FROM organization_members candidate CROSS JOIN actor
      WHERE candidate.user_id=actor.member_id AND candidate.revoked_at IS NULL
    )
) SELECT DISTINCT w.*,CASE WHEN w.owner_id=actor.owner_id THEN 'owner' WHEN m.id IS NOT NULL THEN m.role WHEN pm.role IN ('owner','admin') OR om.role IN ('owner','admin') THEN 'admin' ELSE 'member' END AS role
        FROM actor CROSS JOIN support_workspaces w LEFT JOIN support_members m ON m.workspace_id=w.id AND m.email=actor.email
        LEFT JOIN support_gestion_links l ON l.workspace_id=w.id
        LEFT JOIN organizations o ON o.organization_id=l.organization_id
        LEFT JOIN complete_subscriptions c ON c.subscription_id=o.subscription_id
        LEFT JOIN complete_trials ct ON ct.organization_id=o.organization_id
        LEFT JOIN account_trials t ON t.user_id=ct.user_id AND t.organization_id=o.organization_id
          AND t.subscription_id=o.subscription_id AND t.converted_subscription_id IS NULL AND t.ends_at>unixepoch()
        LEFT JOIN company_seats om ON om.organization_id=o.organization_id AND om.user_id=actor.member_id AND (om.seat_limit IS NULL OR om.seat<=om.seat_limit) AND om.role IN ('owner','admin','accountant','member')
        LEFT JOIN prepaid_company_seats pm ON pm.organization_id=o.organization_id AND pm.user_id=actor.member_id AND pm.seat<=pm.seat_limit AND pm.role IN ('owner','admin','accountant','member')
          AND w.owner_id=pm.paid_owner_id AND (pm.paid_workspace_id IS NULL OR pm.paid_workspace_id=w.id)
        WHERE w.owner_id=actor.access_owner_id OR m.id IS NOT NULL
          OR (substr(o.subscription_id,1,4)<>'pfp_' AND (c.subscription_id IS NOT NULL OR t.user_id IS NOT NULL) AND om.user_id IS NOT NULL)
          OR pm.user_id IS NOT NULL ORDER BY w.created_at,w.id`;
