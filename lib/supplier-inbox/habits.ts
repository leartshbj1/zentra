import { database } from '@/lib/runtime';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import type { AutomationActor } from '@/lib/automation/access';
export const normalizeSupplier = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
export type SupplierHabit = {
  id: string;
  sender: string;
  supplierName: string;
  supplierId: string;
  category: string;
  accountId: string | null;
  updatedAt: number;
};
export async function supplierHabits(org: string) {
  const r = await database()
    .prepare(
      'SELECT id,sender,supplier_name AS supplierName,supplier_id AS supplierId,category,account_id AS accountId,updated_at AS updatedAt FROM automation_supplier_habits WHERE organization_id=? ORDER BY updated_at DESC LIMIT 200',
    )
    .bind(org)
    .all<SupplierHabit>();
  return r.results;
}
export async function rememberSupplier(
  actor: AutomationActor,
  sender: string,
  name: string,
  raw: unknown,
) {
  if (actor.role === 'read_only' || !raw || typeof raw !== 'object') return;
  const m = raw as Record<string, unknown>;
  const uuid = (v: unknown) =>
    typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
  if (
    !uuid(m.supplierId) ||
    typeof m.category !== 'string' ||
    !m.category.trim() ||
    m.category.length > 120 ||
    (m.accountId !== null && !uuid(m.accountId))
  )
    return;
  const supplierName = normalizeSupplier(name),
    email = sender.trim().toLowerCase();
  if (!supplierName || !email) return;
  const id = await sha256Hex(
    JSON.stringify([actor.organizationId, email, supplierName]),
  );
  await database()
    .prepare(
      'INSERT INTO automation_supplier_habits(id,organization_id,sender,supplier_name,supplier_id,category,account_id,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET supplier_id=excluded.supplier_id,category=excluded.category,account_id=excluded.account_id,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
    )
    .bind(
      id,
      actor.organizationId,
      email,
      supplierName,
      m.supplierId,
      m.category,
      m.accountId,
      Math.floor(Date.now() / 1000),
      actor.userId,
    )
    .run();
}
export async function forgetSupplier(actor: AutomationActor, id: unknown) {
  if (!['owner', 'admin'].includes(actor.role))
    throw new AccountPublicError(
      'Seul un administrateur peut effacer les habitudes de l’entreprise.',
      403,
    );
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
    throw new AccountPublicError('Choisissez une habitude.');
  await database()
    .prepare(
      'DELETE FROM automation_supplier_habits WHERE organization_id=? AND id=?',
    )
    .bind(actor.organizationId, id)
    .run();
  return { saved: true };
}
