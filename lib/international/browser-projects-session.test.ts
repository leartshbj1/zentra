import { describe, expect, it, vi } from 'vitest';
import { createBrowserErpSession } from './browser-erp-session';
import { createBrowserExportSession, browserExportUrl } from './browser-export-session';
import { publicErpState } from './public-projection';
import { exportFixture } from './export-test-fixture';
import { browserProjectDraft, buildBrowserProjectsCommand } from './browser-projects';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import type { ErpReceipt } from './runtime-types';

describe('schema3 browser project admission and recovery', () => {
  it('announces explicit cap3 and accepts a public schema3 book without a second project store', async () => {
    const state = await exportFixture('accrual', '', 'Fictitious', '12345', true), fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: 'ready', state: publicErpState(state) }));
    const session = createBrowserErpSession({ organizationId: state.configuration.organizationId, expectedUserId: 'owner', supportedSchemaVersion: 3, fetch: fetcher });
    expect((await session.load()).status).toBe('ready'); expect(new Headers(fetcher.mock.calls[0][1]?.headers).get(ERP_SCHEMA_HEADER)).toBe('3'); expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false); session.dispose();
  });
  it.each([1, 2] as const)('keeps cap%s closed for project writes and schema3 books', async cap => {
    const state = await exportFixture('accrual', '', 'Fictitious', '12345', true), fetcher = vi.fn(async () => Response.json({ status: 'ready', state: publicErpState(state) }));
    const session = createBrowserErpSession({ organizationId: state.configuration.organizationId, supportedSchemaVersion: cap, fetch: fetcher });
    await expect(session.load()).rejects.toMatchObject({ code: 'client_upgrade_required', outcome: 'rejected' });
    await expect(session.submit({ type: 'save_projects', projects: [] }, state.revision)).rejects.toMatchObject({ code: 'client_upgrade_required', outcome: 'rejected' }); expect(fetcher).toHaveBeenCalledOnce(); session.dispose();
  });
  it('retains the exact project batch after a lost receipt and verifies its first entity ID', async () => {
    const state = await exportFixture('accrual', '', 'Fictitious', '12345', true), project = state.projects![0], command = buildBrowserProjectsCommand(state.configuration.organizationId, state, [{ id: project.id, draft: browserProjectDraft(project), expectedProjectRevision: project.revision }]);
    const receipt: ErpReceipt = { idempotencyKey: 'exact-project-batch', commandHash: 'a'.repeat(64), revision: state.revision + 1, entityId: project.id, action: 'save_projects' };
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Fictitious loss')).mockResolvedValueOnce(Response.json({ receipt, replayed: true }));
    const session = createBrowserErpSession({ organizationId: state.configuration.organizationId, supportedSchemaVersion: 3, fetch: fetcher, newId: () => 'exact-project-batch' });
    await expect(session.submit(command, state.revision)).rejects.toMatchObject({ outcome: 'uncertain' }); expect(session.hasPending()).toBe(true); expect(await session.retry()).toEqual({ receipt, replayed: true }); expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[0][1]?.body); session.dispose();
  });
  it('releases a confirmed project revision conflict and requires a fresh read', async () => {
    const state = await exportFixture('accrual', '', 'Fictitious', '12345', true), project = state.projects![0], command = buildBrowserProjectsCommand(state.configuration.organizationId, state, [{ id: project.id, draft: browserProjectDraft(project), expectedProjectRevision: project.revision }]);
    const fetcher = vi.fn(async () => Response.json({ error: 'project_revision_conflict' }, { status: 409 })), session = createBrowserErpSession({ organizationId: state.configuration.organizationId, supportedSchemaVersion: 3, fetch: fetcher });
    await expect(session.submit(command, state.revision)).rejects.toMatchObject({ code: 'project_revision_conflict', outcome: 'rejected' }); expect(session.hasPending()).toBe(false); await expect(session.submit(command, state.revision)).rejects.toMatchObject({ code: 'read_required' }); session.dispose();
  });
  it('routes a project export with only a selector and rejects it locally without cap3', async () => {
    const selector = { kind: 'document' as const, documentType: 'project' as const, id: 'project 1 é' };
    expect(browserExportUrl('company', selector, 'it', 'pdf')).toBe('/api/international/workspaces/company/exports/documents/project/project%201%20%C3%A9?format=pdf&language=it');
    const fetcher = vi.fn<typeof fetch>(), session = createBrowserExportSession({ organizationId: 'company', expectedUserId: 'owner', supportedSchemaVersion: 2, fetch: fetcher });
    await expect(session.file(selector, 'it', 1, 'pdf')).rejects.toMatchObject({ code: 'client_upgrade_required' }); expect(fetcher).not.toHaveBeenCalled(); session.dispose();
  });
});
