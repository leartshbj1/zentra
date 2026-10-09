import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { createSupabaseUsTaxOperationStore, type UsTaxOperationStore } from './us-tax-operation-store';
import { usTaxPreparationStoreError } from './us-tax-invoice-preparation-store';

/** Preserve the existing exact operation/proof/receipt validation and captured
 * capability. Only the private mutation RPCs gain durable preparation fences. */
export function createSupabasePreparedUsTaxOperationStore(client: Pick<SupabaseServerClient, 'rpc'>, options: Readonly<{ supportedSchemaVersion?: ErpSchemaVersion }> = {}): UsTaxOperationStore {
  const capability = options.supportedSchemaVersion ?? 1;
  const rpc: Pick<SupabaseServerClient, 'rpc'> = { async rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
    const mutationNames: Record<string, string> = { zentra_reserve_us_tax_operation: 'zentra_reserve_us_tax_prepared_operation', zentra_record_us_tax_calculation: 'zentra_record_us_tax_prepared_calculation', zentra_commit_us_tax_invoice_test_v2: 'zentra_commit_us_tax_prepared_invoice_test' };
    const input = name === 'zentra_reserve_us_tax_operation' || name === 'zentra_record_us_tax_calculation' ? { ...parameters, p_supported_schema_version: capability } : parameters;
    try { return await client.rpc<T>(mutationNames[name] ?? name, input); }
    catch (e) { if (e instanceof SupabaseServerError && /^PF[0-9]{3}$/.test(e.code)) throw usTaxPreparationStoreError(e); throw e; }
  } };
  return createSupabaseUsTaxOperationStore(rpc, options);
}
