/**
 * Conversion helpers at the D1 -> PostgreSQL boundary.
 *
 * The existing HTTP/domain contracts use Unix seconds, 0/1 booleans and
 * base64url SHA-256 values. PostgreSQL stores the same values as timestamptz,
 * boolean and bytea. Keeping these conversions in one fail-closed module avoids
 * subtle comparisons against values expressed in different units or encodings.
 */

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const POSTGRES_BYTEA_HEX = /^\\x(?:[0-9a-f]{2})*$/i;

export function epochSecondsToIso(
  value: number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('A Unix timestamp must be a non-negative safe integer.');
  }
  const date = new Date(value * 1_000);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError('The Unix timestamp is outside the supported range.');
  }
  return date.toISOString();
}

export function isoToEpochSeconds(
  value: string | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  // PostgreSQL can return either Z or an explicit UTC offset. Requiring one
  // prevents the server locale from changing the meaning of a timestamp.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new TypeError('A PostgreSQL timestamp must include a timezone.');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('The PostgreSQL timestamp is invalid.');
  }
  return Math.floor(milliseconds / 1_000);
}

export function d1BooleanToBoolean(value: boolean | 0 | 1): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new TypeError('A D1 boolean must be true, false, 0 or 1.');
}

export function booleanToD1Integer(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError('The base64url value is invalid.');
  }
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError('The base64url value is invalid.');
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function base64UrlHashToPostgresBytea(value: string): string {
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength !== 32 || encodeBase64Url(bytes) !== value) {
    throw new TypeError('A Zentra token hash must be a canonical SHA-256 value.');
  }
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `\\x${hex}`;
}

export function postgresByteaToBase64UrlHash(value: string): string {
  if (!POSTGRES_BYTEA_HEX.test(value) || value.length !== 66) {
    throw new TypeError('The PostgreSQL bytea value is not a SHA-256 hash.');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return encodeBase64Url(bytes);
}
