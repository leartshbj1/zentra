import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsErpProjects } from '../../components/account/us-erp-projects';
import { buildBrowserEstimateCommand, type BrowserEstimateDraft } from '../../components/account/us-erp-workbench';
import { browserDocumentAnchor, browserLegacyProjectReferences, browserProjectDraft, browserProjectFigures, buildBrowserProjectsCommand, canUseBrowserProjects, checkBrowserEstimateProject, eligibleBrowserProjects, emptyBrowserProject } from './browser-projects';
import { browserProjectsCopy } from './browser-projects-copy';
import { exportFixture } from './export-test-fixture';
import { SITE_LANGUAGES } from '../site-language';
import type { AccountRole } from '../account-security';
import type { ErpState } from './runtime-types';

let saved: ErpState;
beforeAll(async () => { saved = await exportFixture('accrual', 'First line\nSecond line', 'Fictitious service', '12345', true); });
type MutableState = { -readonly [K in keyof ErpState]: ErpState[K] } & { counters: { estimate: number; invoice: number; project?: number } };
const clone = () => structuredClone(saved) as MutableState;
const row = () => ({ id: 'new-project', expectedProjectRevision: 0, draft: { ...emptyBrowserProject(), name: 'Actual typed name', customerId: saved.customers[0].id } });
const build = (rows = [row()], state = saved) => buildBrowserProjectsCommand(saved.configuration.organizationId, state, rows);

describe('US project presentation and exact commands', () => {
  it.each(['owner', 'admin', 'accountant', 'member', 'read_only'] as AccountRole[])('keeps schema and role eligibility independent for %s', role => {
    expect(canUseBrowserProjects(role, 2)).toBe(false); expect(canUseBrowserProjects(role, 3)).toBe(['owner', 'admin', 'accountant'].includes(role));
  });
  it('builds an exact net budget above floating point precision without server-owned identity or totals', () => {
    const value = row(); value.draft.budget = '90071992547409.93'; const command = build([value]);
    expect(command.projects[0]).toEqual({ id: 'new-project', expectedProjectRevision: 0, customerId: saved.customers[0].id, name: 'Actual typed name', status: 'active', notes: '', startDate: null, targetDate: null, budgetMinor: '9007199254740993', vendorBillIds: [] });
    expect(JSON.stringify(command)).not.toMatch(/organizationId|currency|number|tax|role|createdAt|updatedAt/);
  });
  it('distinguishes absent and zero budget and retains exact edit decimals', () => {
    expect(build().projects[0].budgetMinor).toBeNull(); const value = row(); value.draft.budget = '0'; expect(build([value]).projects[0].budgetMinor).toBe('0');
    expect(browserProjectDraft({ ...saved.projects![0], budget: { currency: 'USD', minorUnits: '9007199254740993' } }).budget).toBe('90071992547409.93');
  });
  it.each(['-1', '1.005', '1e3', '1,000.00', 'NaN', 'Infinity', ' 100', '9'.repeat(37)])('rejects ambiguous or unsupported budget %s', budget => { const value = row(); value.draft.budget = budget; expect(() => build([value])).toThrow(); });
  it.each([{ name: '' }, { name: 'x'.repeat(201) }, { notes: 'x'.repeat(20001) }, { startDate: '2026-02-30' }, { startDate: '2026-10-09', targetDate: '2026-10-08' }, { customerId: 'unknown' }, { vendorBillIds: ['unknown'] }, { vendorBillIds: ['bill-1', 'bill-1'] }])('rejects unusable project fields %j', fields => { const value = row(); Object.assign(value.draft, fields); expect(() => build([value])).toThrow(); });
  it('validates boundary fields, multiline notes and ISO dates without translation', () => {
    const value = row(); Object.assign(value.draft, { name: 'x'.repeat(200), notes: 'é'.repeat(19990) + '\nkeep\tthis', startDate: '2026-10-08', targetDate: '2026-10-08' }); expect(build([value]).projects[0]).toMatchObject({ notes: value.draft.notes, startDate: '2026-10-08', targetDate: '2026-10-08' });
  });
  it('preserves recorded project revision and blocks a stale draft or changing a linked customer', () => {
    const project = saved.projects![0], value = { id: project.id, expectedProjectRevision: project.revision, draft: browserProjectDraft(project) };
    expect(build([value]).projects[0].expectedProjectRevision).toBe(project.revision); expect(() => build([{ ...value, expectedProjectRevision: project.revision - 1 }])).toThrow();
    const state = clone(); state.customers = [...state.customers, { ...state.customers[0], id: 'other-customer' }]; value.draft.customerId = 'other-customer'; expect(() => build([value], state)).toThrow();
  });
  it('prevents duplicate projects, foreign workspace and assigning a purchase to two folders', () => {
    expect(() => build([row(), row()])).toThrow(); expect(() => buildBrowserProjectsCommand('other-workspace', saved, [row()])).toThrow();
    const value = row(); value.draft.vendorBillIds = ['bill-1']; expect(() => build([value])).toThrow();
  });
  it('uses only an active project belonging to the selected customer in an estimate', () => {
    const project = saved.projects![0]; expect(eligibleBrowserProjects(saved, project.customerId).map(item => item.id)).toEqual([project.id]); checkBrowserEstimateProject(saved, project.customerId, project.id);
    expect(() => checkBrowserEstimateProject(saved, 'other-customer', project.id)).toThrow(); const state = clone(); state.projects = [{ ...project, status: 'archived' }]; expect(eligibleBrowserProjects(state, project.customerId)).toEqual([]); expect(() => checkBrowserEstimateProject(state, project.customerId, project.id)).toThrow();
    const draft: BrowserEstimateDraft = { customerId: project.customerId, projectId: project.id, date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: '30', notes: '', lines: [{ id: 'line', description: 'Recorded service', quantity: '1', unitPrice: '100' }] };
    expect(buildBrowserEstimateCommand(saved.configuration.organizationId, draft, 'new-estimate', saved)).toMatchObject({ projectId: project.id }); expect(() => buildBrowserEstimateCommand(saved.configuration.organizationId, draft, 'new-estimate')).toThrow();
  });
  it('keeps estimated sales, actual revenue, receipts and payables separate and exact', () => {
    const figures = browserProjectFigures(saved, saved.projects![0]);
    expect(Object.fromEntries(['estimatedNet', 'invoicedNet', 'invoicedTotal', 'received', 'receivable', 'purchasedNet', 'purchasedTotal', 'payable'].map(key => [key, figures[key as 'estimatedNet'].minorUnits]))).toEqual({ estimatedNet: '24690', invoicedNet: '24690', invoicedTotal: '25515', received: '10000', receivable: '15515', purchasedNet: '10000', purchasedTotal: '10825', payable: '5825' });
    expect(figures.estimates).toHaveLength(1); expect(figures.invoices).toHaveLength(1); expect(figures.bills).toHaveLength(1);
  });
  it('discovers only real missing references and requires explicit names for the complete migration batch', () => {
    const state = clone(); state.schemaVersion = 2; delete state.projects; delete state.counters.project;
    const refs = browserLegacyProjectReferences(state); expect(refs).toEqual([{ id: 'project 1 é', customerIds: [saved.customers[0].id], estimateIds: ['estimate 1 é'], invoiceIds: ['invoice 1 é'] }]);
    expect(Object.keys(refs[0])).not.toContain('name'); expect(() => build([row()], state)).toThrow(); const value = { ...row(), id: refs[0].id }; expect(build([value], state).projects[0].name).toBe('Actual typed name');
    value.draft.name = ''; expect(() => build([value], state)).toThrow();
  });
  it('refuses a legacy ID shared by different customers instead of inventing a resolution', () => {
    const state = clone(); delete state.projects; state.invoices = [{ ...state.invoices[0], customer: { ...state.customers[0], id: 'other-customer' } }]; expect(browserLegacyProjectReferences(state)[0].customerIds).toHaveLength(2); expect(() => build([{ ...row(), id: 'project 1 é' }], state)).toThrow();
  });
  it.each(SITE_LANGUAGES)('provides complete %s copy and safe stored text in the familiar project list', language => {
    expect(Object.keys(browserProjectsCopy[language]).sort()).toEqual(Object.keys(browserProjectsCopy.en).sort()); expect(Object.values(browserProjectsCopy[language]).every(value => value.trim())).toBe(true);
    const state = clone(); state.projects = [{ ...state.projects![0], name: '<script>unsafe()</script>' }]; const html = renderToStaticMarkup(createElement(UsErpProjects, { state, organizationId: state.configuration.organizationId, language, role: 'owner', disabled: false, onWrite: () => {} }));
    expect(html).toContain(browserProjectsCopy[language].title); expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;'); expect(html).not.toContain('<script>');
  });
  it('hides creation for member/read-only, retains archives and uses stable encoded document anchors', () => {
    for (const role of ['member', 'read_only'] as const) { const html = renderToStaticMarkup(createElement(UsErpProjects, { state: saved, organizationId: saved.configuration.organizationId, language: 'en', role, disabled: false, onWrite: () => {} })); expect(html).not.toContain('>New project<'); expect(html).toContain(browserProjectsCopy.en.readOnly); }
    expect(browserDocumentAnchor('invoice', 'invoice 1 é')).toBe('us-invoice-invoice%201%20%C3%A9');
  });
});
