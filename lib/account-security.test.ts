import { describe, expect, it } from 'vitest';
import {
  bearerSessionToken,
  hashOpaqueToken,
  invoiceChainHash,
  isDeviceCode,
  isDeviceSessionToken,
  isInstallationId,
  newDeviceCode,
  newDeviceSessionToken,
  newUserCode,
  normalizeUserCode,
  retentionUntil,
} from './account-security';

describe('Zentra account security primitives', () => {
  it('generates distinct opaque device credentials and a readable user code', () => {
    const deviceCodes = new Set(Array.from({ length: 32 }, newDeviceCode));
    const sessionTokens = new Set(
      Array.from({ length: 32 }, newDeviceSessionToken),
    );
    expect(deviceCodes.size).toBe(32);
    expect(sessionTokens.size).toBe(32);
    expect([...deviceCodes].every(isDeviceCode)).toBe(true);
    expect([...sessionTokens].every(isDeviceSessionToken)).toBe(true);
    expect(newUserCode()).toMatch(
      /^[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$/,
    );
    expect(normalizeUserCode('o1il abcd')).toBe('0111-ABCD');
  });

  it('domain-separates hashes and strictly parses the bearer token', async () => {
    const token = newDeviceSessionToken();
    expect(await hashOpaqueToken('device-code', token)).not.toBe(
      await hashOpaqueToken('device-session', token),
    );
    expect(
      bearerSessionToken(
        new Request('https://zentra.test', {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ),
    ).toBe(token);
    expect(() =>
      bearerSessionToken(
        new Request('https://zentra.test', {
          headers: { Authorization: `Basic ${token}` },
        }),
      ),
    ).toThrow('Session Zentra');
  });

  it('validates installation ids and keeps invoices ten years after fiscal year end', () => {
    expect(isInstallationId('7f25e57a-a2b4-4c1e-9b0c-f991a04de830')).toBe(true);
    expect(isInstallationId('not-a-device')).toBe(false);
    expect(retentionUntil('2026-09-02')).toBe('2036-12-31');
    expect(retentionUntil('2026-09-02', '2027-03-31')).toBe('2037-03-31');
    expect(retentionUntil('2024-01-01', '2024-02-29')).toBe('2034-02-28');
    expect(retentionUntil('2026-08-31', '2028-02-29')).toBe('2038-02-28');
    expect(() => retentionUntil('2026-08-31', '2028-03-01')).toThrow(
      'trop éloignée',
    );
    expect(() => retentionUntil('2026-02-30')).toThrow('date de facture');
  });

  it('chains invoice revisions over content and correction metadata', async () => {
    const base = {
      organizationId: 'org_1',
      sourceInvoiceId: 'invoice_1',
      revision: 1,
      invoiceNumber: 'F-2026-0001',
      issueDate: '2026-09-02',
      paidAt: '2026-09-03',
      correctionKind: 'initial' as const,
      correctionReason: null,
      contentSha256: 'a'.repeat(64),
      retentionUntil: '2036-12-31',
      previousChainSha256: null,
    };
    const first = await invoiceChainHash(base);
    const changed = await invoiceChainHash({
      ...base,
      contentSha256: 'b'.repeat(64),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(first);
  });
});
