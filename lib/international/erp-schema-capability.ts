import { ErpError } from './erp-contract';

/** A protocol capability only. Auth, workspace access, product entitlement and
 * the server's enabled capabilities remain independent admission checks. */
export const ERP_SCHEMA_HEADER = 'X-Zentra-Erp-Schema-Version';
export function erpClientSchemaVersion(request: Request): 1 | 2 {
  const value = request.headers.get(ERP_SCHEMA_HEADER);
  if (value === null || value === '1') return 1;
  if (value === '2') return 2;
  throw new ErpError('invalid_request', 422);
}
export function requireErpClientSchema(version: 1 | 2, supported: 1 | 2): void {
  if (version > supported) throw new ErpError('client_upgrade_required', 409);
}
