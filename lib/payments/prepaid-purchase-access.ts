import { prepaidProduct, type PrepaidProduct } from './prepaid-catalog';

export class PrepaidPurchaseAccessError extends Error {
  constructor(
    public readonly code: 'authentication' | 'target' | 'ownership' | 'link',
  ) {
    super(`Prepaid purchase ${code}.`);
  }
}
export type PrepaidPurchaseAuthority = Readonly<{
  ownerId: string;
  emailAddress: string;
  organizationId: string | null;
  workspaceId: string | null;
  product: PrepaidProduct;
}>;
function identity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 180 &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

/** Billing authorization is independent of paid seats: a genuine owner must
 * be able to pay for an expired company without already holding its licence.
 * user must come from refreshed server authentication; this grants no rights.
 * Targets are existing authoritative records, never IDs taken on trust. */
export async function authorizePrepaidPurchase(
  db: Pick<D1Database, 'prepare'>,
  user: { userId: string; email: string; emailConfirmed: boolean },
  request: {
    productKey: unknown;
    organizationId?: unknown;
    workspaceId?: unknown;
  },
): Promise<PrepaidPurchaseAuthority> {
  if (
    !identity(user.userId) ||
    user.emailConfirmed !== true ||
    typeof user.email !== 'string' ||
    user.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)
  )
    throw new PrepaidPurchaseAccessError('authentication');
  const product = prepaidProduct(request.productKey);
  const org = request.organizationId ?? null,
    workspace = request.workspaceId ?? null;
  if (
    !product ||
    (org !== null && !identity(org)) ||
    (workspace !== null && !identity(workspace))
  )
    throw new PrepaidPurchaseAccessError('target');
  if (
    (product.productKind !== 'support' && org === null) ||
    (product.support !== null && workspace === null) ||
    (product.support === null && workspace !== null)
  )
    throw new PrepaidPurchaseAccessError('target');

  const requireOwner = async (organizationId: string) => {
    const owned = await db
      .prepare(`SELECT 1 FROM organizations o
      JOIN organization_members m ON m.organization_id=o.organization_id
      AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL
      WHERE o.organization_id=? AND o.created_by_user_id=?`)
      .bind(user.userId, organizationId, user.userId)
      .first();
    if (!owned) throw new PrepaidPurchaseAccessError('ownership');
  };
  if (org !== null) await requireOwner(org);

  let organizationId = org;
  if (workspace !== null) {
    const owned = await db
      .prepare('SELECT 1 FROM support_workspaces WHERE id=? AND owner_id=?')
      .bind(workspace, user.userId)
      .first();
    if (!owned) throw new PrepaidPurchaseAccessError('ownership');
    const links = await db
      .prepare(`SELECT organization_id,workspace_id
      FROM support_gestion_links WHERE workspace_id=? OR organization_id=?`)
      .bind(workspace, org ?? '')
      .all<{ organization_id: string; workspace_id: string }>();
    if (links.results.length > 1) throw new PrepaidPurchaseAccessError('link');
    const link = links.results[0];
    if (link) {
      if (
        link.workspace_id !== workspace ||
        (org !== null && link.organization_id !== org)
      )
        throw new PrepaidPurchaseAccessError('link');
      await requireOwner(link.organization_id);
      organizationId = link.organization_id;
    }
  }
  return Object.freeze({
    ownerId: user.userId,
    emailAddress: user.email,
    organizationId,
    workspaceId: workspace,
    product,
  });
}
