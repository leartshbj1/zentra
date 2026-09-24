import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  active: vi.fn(), settings: vi.fn(), flags: vi.fn(), rows: vi.fn(), identity: vi.fn(),
  inbox: vi.fn(), appointments: vi.fn(), workflows: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({ database: () => ({ prepare: () => ({ bind: () => ({ all: mocks.rows, first: mocks.identity }) }) }) }));
vi.mock('./entitlement', () => ({ automationEntitlement: mocks.active }));
vi.mock('./config', () => ({ settingsFor: mocks.settings, globalFlags: mocks.flags }));
vi.mock('@/lib/supplier-inbox/service', () => ({ inboxDaily: mocks.inbox }));
vi.mock('@/lib/appointments/service', () => ({ appointmentDaily: mocks.appointments }));
vi.mock('./workflow-activity', () => ({ workflowDaily: mocks.workflows }));
import { automationCompanyState } from './activity';

const actor = { organizationId: 'org-a', userId: 'member-a', role: 'member', founder: false };
const now = new Date('2026-09-24T10:00:00Z');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.active.mockResolvedValue(true);
  mocks.settings.mockResolvedValue({enabled:true});
  mocks.flags.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
it('loads all independent daily sections together, after checking the company entitlement', async () => {
  vi.useFakeTimers();
  const delayed = (value: unknown) => new Promise(resolve => setTimeout(() => resolve(value), 100));
  mocks.rows.mockImplementation(() => delayed({results:[]}));
  mocks.identity.mockImplementation(() => delayed({display_name:'Camille'}));
  mocks.inbox.mockImplementation(() => delayed({received:2}));
  mocks.appointments.mockImplementation(() => delayed({imported:1}));
  mocks.workflows.mockImplementation(() => delayed({tasks:3}));
  const result = automationCompanyState(actor, now);
  await vi.advanceTimersByTimeAsync(0);
  for (const call of [mocks.rows,mocks.identity,mocks.inbox,mocks.appointments,mocks.workflows]) expect(call).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  await expect(result).resolves.toMatchObject({organizationId:'org-a',active:true,canManage:false,activity:{displayName:'Camille',supplierInbox:{received:2},appointments:{imported:1},workflows:{tasks:3}}});
  expect(mocks.inbox.mock.calls[0][0]).toBe('org-a');
  expect(mocks.appointments.mock.calls[0][0]).toBe('org-a');
  expect(mocks.workflows.mock.calls[0][0]).toBe(actor);
});
it('does not query business activity for an inactive entitlement', async () => {
  mocks.active.mockResolvedValue(false);
  await expect(automationCompanyState(actor, now)).resolves.toMatchObject({active:false,activity:null});
  for (const call of [mocks.rows,mocks.identity,mocks.inbox,mocks.appointments,mocks.workflows]) expect(call).not.toHaveBeenCalled();
});
