import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '@/lib/supabase-server';
import { AccountPublicError } from '@/lib/account-security';
import { getWorkspaceCountry, putWorkspaceCountry, validateWorkspaceCountryWrite, type WorkspaceCountryActor, type WorkspaceCountryStore } from './workspace-service';

const configuration = {
  schemaVersion: 1, organizationId: 'org-a', country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
  address: { country: 'US', line1: '10 Example Road', postalCode: '10001', city: 'New York', subdivision: 'NY' },
  accountingBasis: 'cash', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' },
};
const actor: WorkspaceCountryActor = { organizationId: 'org-a', userId: 'owner-a', role: 'owner' };
const requestId = '10000000-0000-4000-8000-000000000001';
const body = { expectedRevision: 0, requestId, configuration };
const updatedAt = '2026-10-07T12:00:00.000Z';
const receipt = { organizationId: 'org-a', revision: 1, configuration, updatedBy: 'owner-a', updatedAt, replayed: false };
function store() {
  const select = vi.fn().mockResolvedValueOnce([{ organization_id: 'org-a' }]).mockResolvedValue([]);
  const rpc = vi.fn().mockResolvedValue(receipt);
  return { select, rpc, client: { select, rpc } as unknown as WorkspaceCountryStore };
}

describe('organization country configuration service', () => {
  it('preserves unknown legacy jurisdiction without creating or inferring a CH row', async () => {
    const db = store();
    expect(await getWorkspaceCountry(db.client, actor)).toEqual({ status: 'unconfigured', organizationId: 'org-a', revision: 0, country: 'unknown', requiresAdministrativeReview: true, preserveLegacyBehavior: true });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.select.mock.calls[1][1]).toMatchObject({ organization_id: 'eq.org-a', limit: 1 });
  });
  it('does not provision a missing Supabase workspace from a D1 organization', async () => {
    const db = store(); db.select.mockReset().mockResolvedValue([]);
    await expect(getWorkspaceCountry(db.client, actor)).rejects.toMatchObject({ code: 'workspace_unavailable', status: 409 });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('reads only a validated record for the authenticated organization', async () => {
    const db = store(); db.select.mockReset().mockResolvedValueOnce([{ organization_id: 'org-a' }]).mockResolvedValueOnce([{ organization_id: 'org-a', schema_version: 1, config: configuration, country: 'US', currency: 'USD', revision: 1, updated_by: 'owner-a', updated_at: updatedAt }]);
    expect(await getWorkspaceCountry(db.client, { ...actor, role: 'read_only' })).toMatchObject({ status: 'configured', configuration });
  });
  it('rejects an upstream cross-tenant record without disclosing its content', async () => {
    const db = store(); db.select.mockReset().mockResolvedValueOnce([{ organization_id: 'org-a' }]).mockResolvedValueOnce([{ organization_id: 'org-b', config: { private: 'other company' } }]);
    await expect(getWorkspaceCountry(db.client, actor)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
  });
  it.each(['admin', 'accountant', 'member', 'read_only'] as const)('refuses writes from the %s role before storage', async role => {
    const db = store();
    await expect(putWorkspaceCountry(db.client, { ...actor, role }, body)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([{ role: 'owner' }, { userId: 'owner-a' }, { entitlements: ['international'] }, { organizationId: 'org-b' }])('refuses client authority fields', extra => {
    expect(() => validateWorkspaceCountryWrite({ ...body, ...extra }, 'org-a')).toThrow('invalid_request');
  });
  it('binds the body configuration to the trusted organization', () => {
    expect(() => validateWorkspaceCountryWrite({ ...body, configuration: { ...configuration, organizationId: 'org-b' } }, 'org-a')).toThrow('forbidden');
  });
  it.each([-1, 0.5, '0', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])('refuses an unsafe expected revision %s', expectedRevision => {
    expect(() => validateWorkspaceCountryWrite({ ...body, expectedRevision }, 'org-a')).toThrow('invalid_request');
  });
  it('writes with only the trusted actor, validated config, CAS and opaque request id', async () => {
    const db = store();
    expect(await putWorkspaceCountry(db.client, actor, body)).toMatchObject({ status: 'configured', revision: 1, requestId, replayed: false });
    expect(db.rpc).toHaveBeenCalledWith('zentra_put_workspace_country_config', { p_organization: 'org-a', p_actor: 'owner-a', p_expected_revision: 0, p_request_id: requestId, p_config: configuration });
  });
  it('allows retrying the same uncertain request and exposes the durable replay receipt', async () => {
    const db = store(); db.rpc.mockRejectedValueOnce(new Error('secret upstream timeout')).mockResolvedValueOnce({ ...receipt, replayed: true });
    await expect(putWorkspaceCountry(db.client, actor, body)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await putWorkspaceCountry(db.client, actor, body)).toMatchObject({ replayed: true, revision: 1 });
    expect(db.rpc.mock.calls[1]).toEqual(db.rpc.mock.calls[0]);
  });
  it.each([['PZ001','revision_conflict'], ['PZ002','request_id_conflict'], ['PZ003','jurisdiction_locked'], ['PZ004','workspace_unavailable']])('maps SQL %s to a safe conflict', async (sqlCode, code) => {
    const db = store(); db.rpc.mockRejectedValue(new SupabaseServerError(400, sqlCode));
    await expect(putWorkspaceCountry(db.client, actor, body)).rejects.toMatchObject({ code, status: 409 });
  });
  it('never accepts a mismatched privileged write receipt', async () => {
    const db = store(); db.rpc.mockResolvedValue({ ...receipt, configuration: { ...configuration, invoiceNumberPrefix: 'OTHER' } });
    await expect(putWorkspaceCountry(db.client, actor, body)).rejects.toMatchObject({ code: 'service_unavailable' });
  });
  it('preserves an omitted EIN from the exact durable baseline, without consulting the mutable head', async () => {
    const db = store(); const privateConfiguration = { ...configuration, ein: '12-3456789' };
    db.select.mockReset().mockResolvedValue([{ organization_id: actor.organizationId, revision: 3, config: privateConfiguration }]);
    db.rpc.mockResolvedValue({ ...receipt, revision: 4, configuration: privateConfiguration });
    const result = await putWorkspaceCountry(db.client, actor, { ...body, expectedRevision: 3 });
    expect(result.configuration).toMatchObject({ ein: '12-3456789' });
    expect(db.select).toHaveBeenCalledWith('zentra_workspace_country_config_changes', { select: 'organization_id,revision,config', organization_id: 'eq.org-a', revision: 'eq.3', limit: 1 });
    expect(db.select).toHaveBeenCalledTimes(1); expect(db.rpc.mock.calls[0][1].p_config).toMatchObject({ ein: '12-3456789' });
  });
  it('retains the same historical EIN on a retry after later private changes', async () => {
    const db = store(); const historicalConfiguration = { ...configuration, ein: '12-3456789' };
    db.select.mockReset().mockResolvedValue([{ organization_id: actor.organizationId, revision: 3, config: historicalConfiguration }]);
    db.rpc.mockRejectedValueOnce(new Error('fictitious lost response')).mockResolvedValue({ ...receipt, revision: 4, configuration: historicalConfiguration, replayed: true });
    const request = { ...body, expectedRevision: 3 };
    await expect(putWorkspaceCountry(db.client, actor, request)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await putWorkspaceCountry(db.client, actor, request)).toMatchObject({ revision: 4, replayed: true, configuration: { ein: '12-3456789' } });
    expect(db.rpc.mock.calls[1]).toEqual(db.rpc.mock.calls[0]);
  });
  it('does not invent EIN when the historical US baseline did not have one', async () => {
    const db = store(); db.select.mockReset().mockResolvedValue([{ organization_id: actor.organizationId, revision: 1, config: configuration }]);
    db.rpc.mockResolvedValue({ ...receipt, revision: 2 });
    await putWorkspaceCountry(db.client, actor, { ...body, expectedRevision: 1 }); expect(db.rpc.mock.calls[0][1].p_config).not.toHaveProperty('ein');
  });
  it('keeps an explicit EIN input independent from implicit baseline preservation', async () => {
    const db = store(); const explicit = { ...configuration, ein: '98-7654321' }; db.rpc.mockResolvedValue({ ...receipt, revision: 2, configuration: explicit });
    await putWorkspaceCountry(db.client, actor, { ...body, expectedRevision: 1, configuration: explicit });
    expect(db.select).not.toHaveBeenCalled(); expect(db.rpc.mock.calls[0][1].p_config).toMatchObject({ ein: '98-7654321' });
  });
  it('refuses an unavailable historical baseline rather than using a current profile', async () => {
    const db = store(); db.select.mockReset().mockResolvedValue([]);
    await expect(putWorkspaceCountry(db.client, actor, { ...body, expectedRevision: 99 })).rejects.toMatchObject({ code: 'revision_conflict', status: 409 }); expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { organization_id: 'foreign', revision: 1, config: configuration },
    { organization_id: actor.organizationId, revision: 2, config: configuration },
    { organization_id: actor.organizationId, revision: 1, config: { ...configuration, organizationId: 'foreign' } },
    { organization_id: actor.organizationId, revision: 1, config: { ...configuration, ein: 'INVALID' } },
  ])('refuses malformed or foreign historical baseline rows without exposing them', async row => {
    const db = store(); db.select.mockReset().mockResolvedValue([row]);
    await expect(putWorkspaceCountry(db.client, actor, { ...body, expectedRevision: 1 })).rejects.toMatchObject({ code: 'service_unavailable', status: 503 }); expect(db.rpc).not.toHaveBeenCalled();
  });
  it('does not hydrate an US request from a historical Swiss record', async () => {
    const db = store(); db.select.mockReset().mockResolvedValue([{ organization_id: actor.organizationId, revision: 1, config: { ...configuration, country: 'CH', currency: 'CHF', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: 'Rue Exemple 1', city: 'Genève', postalCode: '1201', subdivision: 'GE' } } }]);
    await expect(putWorkspaceCountry(db.client, actor, { ...body, expectedRevision: 1 })).rejects.toMatchObject({ code: 'jurisdiction_locked', status: 409 }); expect(db.rpc).not.toHaveBeenCalled();
  });
  it('revalidates after the historical lookup and retains authorization failures without writing', async () => {
    const db = store(); db.select.mockReset().mockResolvedValue([{ organization_id: actor.organizationId, revision: 1, config: configuration }]);
    const beforeWrite = vi.fn(async () => { expect(db.select).toHaveBeenCalled(); throw new AccountPublicError('fictitious revoked owner', 401); });
    await expect(putWorkspaceCountry(db.client, actor, { ...body, expectedRevision: 1 }, beforeWrite)).rejects.toMatchObject({ status: 401 }); expect(beforeWrite).toHaveBeenCalledOnce(); expect(db.rpc).not.toHaveBeenCalled();
  });
});
