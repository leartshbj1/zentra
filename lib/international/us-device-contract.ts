import { isAccountRole, type AccountRole } from '../account-security';
import { snapshotPrivateJson } from './private-json';
import { usDeviceDisplayText } from './us-device-display-text';
import type { ErpSchemaVersion } from './erp-schema-capability';

import { US_DEVICE_PROTOCOL } from './us-device-protocol';
export { US_DEVICE_PROTOCOL } from './us-device-protocol';
export class UsDeviceError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'UsDeviceError'; }
}
export const usDeviceUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const usDeviceHash = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
export const usDeviceToken = (value: unknown, family: 'zus_' | 'zud_'): value is string => typeof value === 'string' && value.startsWith(family) && usDeviceHash(value.slice(4));
export const usDeviceSeconds = (value: unknown): value is number => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= 253402300799;
export function usDeviceExact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    const value = snapshotPrivateJson(input);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new UsDeviceError('invalid_request', 422); }
}
export function validateUsDeviceStart(input: unknown) {
  const v = usDeviceExact(input, ['protocol','installationId','sessionTokenHash','supportedSchemaVersion']);
  if (v.protocol !== US_DEVICE_PROTOCOL || !usDeviceUuid(v.installationId) || !usDeviceHash(v.sessionTokenHash) || ![1,2,3].includes(v.supportedSchemaVersion as number)) throw new UsDeviceError('invalid_request', 422);
  return Object.freeze({ protocol: US_DEVICE_PROTOCOL, installationId: v.installationId, sessionTokenHash: v.sessionTokenHash, supportedSchemaVersion: v.supportedSchemaVersion as ErpSchemaVersion });
}
export function validateUsDeviceApprove(input: unknown) {
  const v = usDeviceExact(input, ['protocol','userCode','organizationId']);
  if (v.protocol !== US_DEVICE_PROTOCOL || typeof v.userCode !== 'string' || !/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/.test(v.userCode) || !usDeviceUuid(v.organizationId)) throw new UsDeviceError('invalid_request', 422);
  return Object.freeze({ protocol: US_DEVICE_PROTOCOL, userCode: v.userCode, organizationId: v.organizationId });
}
export function validateUsDeviceExchange(input: unknown) {
  const v = usDeviceExact(input, ['protocol','deviceCode','installationId','sessionToken']);
  if (v.protocol !== US_DEVICE_PROTOCOL || !usDeviceToken(v.deviceCode, 'zud_') || !usDeviceUuid(v.installationId) || !usDeviceToken(v.sessionToken, 'zus_')) throw new UsDeviceError('invalid_request', 422);
  return Object.freeze({ protocol: US_DEVICE_PROTOCOL, deviceCode: v.deviceCode, installationId: v.installationId, sessionToken: v.sessionToken });
}
export function usDeviceBearer(request: Request): string {
  const match = /^Bearer (zus_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '');
  if (!match || !usDeviceToken(match[1], 'zus_')) throw new UsDeviceError('unauthorized', 401);
  return match[1];
}
function base64(bytes: Uint8Array): string { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); }
export function newUsDeviceCode(): string { return 'zud_' + base64(crypto.getRandomValues(new Uint8Array(32))); }
export async function hashUsDeviceSecret(purpose: 'session' | 'code', token: string): Promise<string> {
  if (!usDeviceToken(token, purpose === 'session' ? 'zus_' : 'zud_')) throw new UsDeviceError('unauthorized', 401);
  const prefix = purpose === 'session' ? 'zentra:us-device-session:v1:' : 'zentra:us-device-code:v1:';
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prefix + token))));
}
export interface UsDeviceAdmission {
  readonly organizationId: string; readonly organizationName: string; readonly userId: string;
  readonly role: AccountRole; readonly subscriptionId: string; readonly entitlementValidUntil: number;
  readonly configurationStamp: string;
}
export function validateUsDeviceAdmission(input: UsDeviceAdmission): UsDeviceAdmission {
  let v:Record<string,unknown>;
  try{v=usDeviceExact(input, ['organizationId','organizationName','userId','role','subscriptionId','entitlementValidUntil','configurationStamp']);}catch{throw new UsDeviceError('service_unavailable',503);}
  if (!usDeviceUuid(v.organizationId) || !usDeviceUuid(v.userId) || !isAccountRole(v.role) || !usDeviceDisplayText(v.organizationName,160) || typeof v.subscriptionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.subscriptionId) || !usDeviceSeconds(v.entitlementValidUntil) || typeof v.configurationStamp !== 'string' || v.configurationStamp.length > 65536 || !v.configurationStamp) throw new UsDeviceError('service_unavailable',503);
  return v as unknown as UsDeviceAdmission;
}
export interface UsDeviceSession {
  readonly protocol: typeof US_DEVICE_PROTOCOL; readonly edition: 'us_experimental'; readonly status: 'connected';
  readonly sessionId: string; readonly organizationId: string; readonly organizationName: string; readonly userId: string;
  readonly installationId: string; readonly role: AccountRole; readonly subscriptionId: string;
  readonly country: 'US'; readonly currency: 'USD'; readonly expiresAt: number; readonly entitlementValidUntil: number;
  readonly supportedSchemaVersion: ErpSchemaVersion;
}
