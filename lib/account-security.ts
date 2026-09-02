export const ACCOUNT_ROLES = [
  'owner',
  'admin',
  'accountant',
  'member',
  'read_only',
] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

const INSTALLATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_URL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const USER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AccountPublicError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function isInstallationId(value: string): boolean {
  return INSTALLATION_ID.test(value);
}

export function isAccountRole(value: unknown): value is AccountRole {
  return (
    typeof value === 'string' &&
    (ACCOUNT_ROLES as readonly string[]).includes(value)
  );
}

export function roleCanManageMembers(role: AccountRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function roleCanWriteInvoices(role: AccountRole): boolean {
  return role !== 'read_only';
}

function randomBase64Url(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function newDeviceCode(): string {
  return `zdv_${randomBase64Url(32)}`;
}

export function newDeviceSessionToken(): string {
  return `zds_${randomBase64Url(32)}`;
}

export function newInvitationToken(): string {
  return `zin_${randomBase64Url(32)}`;
}

export function isDeviceCode(value: string): boolean {
  return value.startsWith('zdv_') && BASE64_URL_TOKEN.test(value.slice(4));
}

export function isDeviceSessionToken(value: string): boolean {
  return value.startsWith('zds_') && BASE64_URL_TOKEN.test(value.slice(4));
}

export function isInvitationToken(value: string): boolean {
  return value.startsWith('zin_') && BASE64_URL_TOKEN.test(value.slice(4));
}

export function newUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let bits = 0;
  for (const byte of bytes) bits = bits * 256 + byte;
  let compact = '';
  for (let index = 0; index < 8; index += 1) {
    compact = USER_CODE_ALPHABET[bits % 32] + compact;
    bits = Math.floor(bits / 32);
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function normalizeUserCode(value: string): string {
  const compact = value
    .trim()
    .toUpperCase()
    .replaceAll('O', '0')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replace(/[^0-9A-Z]/g, '');
  if (
    compact.length !== 8 ||
    compact
      .split('')
      .some((character) => !USER_CODE_ALPHABET.includes(character))
  ) {
    throw new AccountPublicError(
      'Le code appareil doit contenir 8 caractères.',
    );
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export async function hashOpaqueToken(
  purpose: 'device-code' | 'device-session' | 'invitation',
  token: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`zentra:${purpose}:v1:${token}`),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export function bearerSessionToken(request: Request): string {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const token = match?.[1] ?? '';
  if (!isDeviceSessionToken(token)) {
    throw new AccountPublicError('Session Zentra absente ou invalide.', 401);
  }
  return token;
}

export function requireAccountSameOrigin(request: Request): void {
  const requestUrl = new URL(request.url);
  const supplied = request.headers.get('Origin');
  if (supplied && supplied !== requestUrl.origin) {
    throw new AccountPublicError('Requête intersite refusée.', 403);
  }
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    throw new AccountPublicError('Requête intersite refusée.', 403);
  }
}

export function isCanonicalDate(value: string): boolean {
  if (!CANONICAL_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function retentionUntil(
  issueDate: string,
  fiscalYearEnd?: string | null,
): string {
  if (!isCanonicalDate(issueDate)) {
    throw new AccountPublicError('La date de facture est invalide.');
  }
  const defaultFiscalEnd = `${issueDate.slice(0, 4)}-12-31`;
  const end = fiscalYearEnd?.trim() || defaultFiscalEnd;
  if (!isCanonicalDate(end) || end < issueDate) {
    throw new AccountPublicError(
      'La fin de l’exercice comptable est invalide.',
    );
  }
  const issue = new Date(`${issueDate}T00:00:00.000Z`);
  const fiscal = new Date(`${end}T00:00:00.000Z`);
  const maximumEnd = new Date(issue);
  maximumEnd.setUTCMonth(maximumEnd.getUTCMonth() + 18);
  if (fiscal > maximumEnd) {
    throw new AccountPublicError(
      'La fin de l’exercice est trop éloignée de la date de facture.',
    );
  }
  const retained = new Date(fiscal);
  retained.setUTCFullYear(retained.getUTCFullYear() + 10);
  return retained.toISOString().slice(0, 10);
}

export async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> =
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : Uint8Array.from(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function invoiceChainHash(input: {
  organizationId: string;
  sourceInvoiceId: string;
  revision: number;
  invoiceNumber: string;
  issueDate: string;
  paidAt: string | null;
  correctionKind: 'initial' | 'correction';
  correctionReason: string | null;
  contentSha256: string;
  retentionUntil: string;
  previousChainSha256: string | null;
}): Promise<string> {
  const fields = [
    'zentra-invoice-archive-v1',
    input.organizationId,
    input.sourceInvoiceId,
    String(input.revision),
    input.invoiceNumber,
    input.issueDate,
    input.paidAt ?? '',
    input.correctionKind,
    input.correctionReason ?? '',
    input.contentSha256,
    input.retentionUntil,
    input.previousChainSha256 ?? '',
  ];
  return sha256Hex(fields.map((value) => `${value.length}:${value}`).join('|'));
}
