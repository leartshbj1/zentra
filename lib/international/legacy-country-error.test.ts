import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '@/lib/account-security';
import { RequestBodyError } from '@/lib/request-body';
import {
  LEGACY_COUNTRY_GUARD_CODE,
  LegacyCountryTransportError,
} from './legacy-country-guard';

const diagnostics = vi.hoisted(() => ({ report: vi.fn(), retryAfter: vi.fn() }));
vi.mock('@/lib/runtime', () => ({ database: vi.fn(), runtimeValue: () => '' }));
vi.mock('@/lib/service-diagnostics', () => ({ reportServiceFailure: diagnostics.report }));
vi.mock('@/lib/supabase-server', () => ({ supabaseServiceRetryAfter: diagnostics.retryAfter }));

import { accountJsonError } from '@/lib/account';

beforeEach(() => {
  diagnostics.report.mockReset();
  diagnostics.retryAfter.mockReset();
});

describe('legacy country HTTP error contract', () => {
  it('returns only the stable country refusal and public message with no private payload', async () => {
    const error = Object.assign(new LegacyCountryTransportError(), {
      organizationId: 'private-company',
      configuration: { ein: 'private-tax-id' },
      receipt: { actorUserId: 'private-actor' },
    });
    const response = accountJsonError(error);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: error.message, code: LEGACY_COUNTRY_GUARD_CODE });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it.each([
    new AccountPublicError('Accès refusé.', 403),
    new RequestBodyError('Requête trop volumineuse.', 413),
  ])('preserves an existing public error payload without inferring arbitrary codes', async error => {
    Object.assign(error, { code: 'raw-provider-code', details: 'private-provider-data' });
    const response = accountJsonError(error);
    expect(response.status).toBe(error.status);
    expect(await response.json()).toEqual({ error: error.message });
  });

  it('fails closed without exposing an unavailable guard table or provider exception', async () => {
    const error = Object.assign(new Error('no such table: international_workspace_creation_intents'), {
      code: 'SQLITE_ERROR', sql: 'private-query', token: 'private-token',
    });
    const response = accountJsonError(error);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Le service de compte Zentra est momentanément indisponible.' });
  });

  it('preserves a diagnostic reference without serializing its context or private error', async () => {
    const error = new LegacyCountryTransportError();
    const context = { operation: 'country-guard-test' };
    diagnostics.report.mockReturnValue('safe-reference');
    const response = accountJsonError(error, context);
    expect(diagnostics.report).toHaveBeenCalledWith(error, context);
    expect(response.headers.get('X-Zentra-Request-Id')).toBe('safe-reference');
    expect(await response.json()).toEqual({ error: error.message, code: LEGACY_COUNTRY_GUARD_CODE, reference: 'safe-reference' });
  });

  it('preserves the existing retry contract on temporary upstream failures', async () => {
    diagnostics.retryAfter.mockReturnValue(12);
    const response = accountJsonError(new Error('private temporary failure'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(await response.json()).toEqual({ error: 'Le service de compte Zentra est momentanément indisponible.' });
  });
});
