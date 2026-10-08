/** Country-independent SHA-256 for canonical ERP command receipts.
 * No account, entitlement, retention or storage policy belongs in this module. */
export async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> = typeof value === 'string'
    ? new TextEncoder().encode(value) : Uint8Array.from(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
