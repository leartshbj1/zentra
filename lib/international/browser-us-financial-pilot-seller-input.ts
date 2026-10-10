import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import type { UsSellerProfile } from './seller-profile';
import { usFinancialPilotSellerProfile, validateUsFinancialPilotSellerRead, type UsFinancialPilotSellerCommand, type UsFinancialPilotSellerRead } from './us-financial-pilot-seller';

export type SellerDraft = Readonly<{ displayName: string; contactEmail: string; contactPhone: string }>;
export type SellerReview = Readonly<{
  source: UsFinancialPilotSellerRead; command: UsFinancialPilotSellerCommand; profile: UsSellerProfile; changed: boolean;
}>;
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError();
  return value as Record<string, unknown>;
}
function checkedCommand(value: unknown): Readonly<{ command: UsFinancialPilotSellerCommand; profile: UsSellerProfile }> {
  const profile = usFinancialPilotSellerProfile(value);
  return Object.freeze({ profile, command: Object.freeze({ type: 'update_seller_presentation', displayName: profile.displayName, contactEmail: profile.contactEmail ?? null, contactPhone: profile.contactPhone ?? null }) });
}

/** Empty contacts deliberately remove them. Other values retain their exact
 * spelling and must already satisfy the shared presentation contract. */
export function sellerCommandFromDraft(value: SellerDraft): UsFinancialPilotSellerCommand {
  try {
    const draft = fields(snapshotPrivateJson(value), ['displayName', 'contactEmail', 'contactPhone']);
    if (typeof draft.displayName !== 'string' || typeof draft.contactEmail !== 'string' || typeof draft.contactPhone !== 'string') throw new TypeError();
    return checkedCommand({ type: 'update_seller_presentation', displayName: draft.displayName, contactEmail: draft.contactEmail === '' ? null : draft.contactEmail, contactPhone: draft.contactPhone === '' ? null : draft.contactPhone }).command;
  } catch { throw new TypeError('invalid_seller_input'); }
}

/** Pure capture only. The financial session owns admission, the review object,
 * approval and the single durable request identity; this function owns none. */
export function buildSellerReview(source: UsFinancialPilotSellerRead, command: UsFinancialPilotSellerCommand): SellerReview {
  try {
    const captured = snapshotPrivateJson({ source, command }) as { source: unknown; command: unknown };
    const read = validateUsFinancialPilotSellerRead(captured.source), checked = checkedCommand(captured.command);
    return Object.freeze({ source: read, command: checked.command, profile: checked.profile, changed: canonicalErpJson(read.presentation.profile) !== canonicalErpJson(checked.profile) });
  } catch { throw new TypeError('invalid_seller_input'); }
}
