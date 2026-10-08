import { ErpError } from './erp-contract';

/** A protocol capability only. Auth, workspace access, product entitlement and
 * the server's enabled capabilities remain independent admission checks. */
export const ERP_SCHEMA_HEADER = 'X-Zentra-Erp-Schema-Version';
export type ErpSchemaVersion = 1 | 2 | 3 | 4;
export function erpClientSchemaVersion(request: Request): ErpSchemaVersion {
  const value = request.headers.get(ERP_SCHEMA_HEADER);
  if (value === null || value === '1') return 1;
  if (value === '2') return 2;
  if (value === '3') return 3;
  if (value === '4') return 4;
  throw new ErpError('invalid_request', 422);
}
export function requireErpClientSchema(version: ErpSchemaVersion, supported: ErpSchemaVersion): void {
  if(![1,2,3,4].includes(version)||![1,2,3,4].includes(supported))throw new ErpError('service_unavailable',503);
  if (version > supported) throw new ErpError('client_upgrade_required', 409);
}
