/** Billing navigation must remain available without a currently paid seat.
 * This is discovery only, not permission to dispatch a purchase. The checkout
 * controller revalidates ownership, target and occupied products atomically. */
export async function ownedGestionPurchaseCompanies(
  db: Pick<D1Database, 'prepare'>,
  userId: string,
) {
  const result = await db
    .prepare(`SELECT o.organization_id AS id,o.name FROM organizations o
    JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=?
    AND m.role='owner' AND m.revoked_at IS NULL
    WHERE o.created_by_user_id=? ORDER BY o.created_at,o.organization_id LIMIT 101`)
    .bind(userId, userId)
    .all<{ id: string; name: string }>();
  // Never truncate the choice and accidentally default to an omitted company.
  if (result.results.length > 100) throw new Error('Too many billing targets.');
  return result.results.map((company) => ({
    id: company.id,
    name: company.name,
  }));
}
