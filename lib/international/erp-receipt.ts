import { ErpError } from './erp-contract';
import type { ErpReceipt } from './runtime-types';
function unavailable(): never { throw new ErpError('invalid_stored_state',503); }
const receiptFields = ['idempotencyKey','commandHash','revision','entityId','action'] as const;
const receiptActions = ['initialize','refresh_configuration','save_customer','save_estimate','accept_estimate','issue_invoice','record_payment','close_period','save_vendor','record_vendor_bill','record_vendor_payment','save_projects','upgrade_accounting','open_period','post_manual_journal','reverse_manual_journal'];
/** Privileged RPC results are unknown. Copy only own JSON data; never invoke getters or return the source object. */
export function validateErpReceipt(input: unknown, organizationId: string): ErpReceipt {
  try {
    if (typeof organizationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId) || !input || typeof input !== 'object' || Array.isArray(input)) return unavailable();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return unavailable();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== receiptFields.length || keys.some(key => typeof key !== 'string' || !receiptFields.includes(key as typeof receiptFields[number]))) return unavailable();
    const copied: Record<string, unknown> = Object.create(null);
    for (const key of receiptFields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return unavailable();
      copied[key] = descriptor.value;
    }
    const { idempotencyKey, commandHash, revision, entityId, action } = copied;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
      || typeof commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(commandHash)
      || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$/.test(idempotencyKey)
      || typeof entityId !== 'string' || !entityId.trim() || entityId.length > 160 || Array.from(entityId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || typeof action !== 'string' || !receiptActions.includes(action)) return unavailable();
    return Object.freeze({ idempotencyKey, commandHash, revision, entityId, action: action as ErpReceipt['action'] });
  } catch { return unavailable(); }
}
