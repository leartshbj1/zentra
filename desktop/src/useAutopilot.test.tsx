// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAutopilot, type AutopilotContext } from './useAutopilot';
import { createAutopilotBudget } from './autopilotBudget';
import { QUOTE_ACTIVITY_LIVE_SELECTOR } from './autopilotDraftNotices';
import type { ConfirmedQuoteActivity } from './confirmedQuoteActivity';
const api = vi.hoisted(() => ({ getQuoteAutopilotState: vi.fn(), readQuoteAutopilotConsent: vi.fn(),
  setQuoteAutopilotConsent: vi.fn(), tickQuoteAutopilot: vi.fn(), readQuoteAutopilotActivity: vi.fn(), readQuoteAutopilotReview: vi.fn() }));
vi.mock('./bridge', () => ({ desktopApi: api }));
vi.mock('./diagnostics', () => ({ classifyDiagnosticError: () => 'NETWORK', recordDiagnostic: vi.fn() }));
const pacing = vi.hoisted(() => ({ current: null as ReturnType<typeof createAutopilotBudget> | null }));
vi.mock('./autopilotBudget', async importOriginal => {
  const actual = await importOriginal<typeof import('./autopilotBudget')>();
  return { ...actual, autopilotBudget: {
    reserve: (...args: Parameters<ReturnType<typeof actual.createAutopilotBudget>['reserve']>) => pacing.current!.reserve(...args),
    rateLimited: (organizationId: string) => pacing.current!.rateLimited(organizationId),
  } };
});
const origin = { expectedWorkspaceScope: 'workspace-a', expectedMemberContextNonce: 'a'.repeat(32) };
const context: AutopilotContext = { organizationId: 'company-a', origin, readOnly: false };
const common = { schemaVersion: 1, status: 'available', code: 'none', organizationId: 'company-a', workspaceScope: 'workspace-a', memberContextNonce: 'a'.repeat(32) };
const consent = { schemaVersion: 1, enabled: true, revision: 2, consentVersion: 'version', requiredConsentVersion: 'version' };
const activityCursor = (sequence: number, user = 'user-a') => btoa(JSON.stringify(['confirmed-quote-changes-v2','company-a',user,'installation-a',sequence]))
  .replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function installFeed(items: readonly ConfirmedQuoteActivity[]) {
  api.readQuoteAutopilotActivity.mockImplementation(async (_origin, selection: { limit: number; cursor: string }) => {
    const initial = selection.cursor === QUOTE_ACTIVITY_LIVE_SELECTOR;
    const after = initial ? 0 : JSON.parse(atob(selection.cursor.replaceAll('-','+').replaceAll('_','/')))[4] as number;
    const rows = initial ? items.slice(-selection.limit) : items.slice(after, after + selection.limit);
    const head = !initial && after + rows.length < items.length ? after + rows.length : items.length;
    return { ...common, data: { organizationId: 'company-a', items: rows, nextCursor: activityCursor(head) } };
  });
}
const closed = { schemaVersion: 1, status: 'unavailable', code: 'product_gate_closed', organizationId: null, workspaceScope: null, memberContextNonce: null };
const tick = { ...common,status:'idle',phase:'page',counts:{confirmed:0,held:0,reviewRequired:0},roundComplete:true,hasMore:false,pendingRecovery:false };
let result: ReturnType<typeof useAutopilot>, root: Root | null = null, host: HTMLDivElement | null = null, renders = 0;
const changed = vi.fn();
function Probe({value}:{value:AutopilotContext|null}) { renders++; result=useAutopilot(value,changed); return <div>{result.state.status}</div>; }
async function mount(value: AutopilotContext|null = context) { host=document.createElement('div'); document.body.append(host); root=createRoot(host);
  await act(async () => root!.render(<Probe value={value}/>)); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); vi.clearAllMocks(); renders=0;
  pacing.current = createAutopilotBudget();
  vi.spyOn(navigator,'onLine','get').mockReturnValue(true); vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  api.getQuoteAutopilotState.mockResolvedValue({...common,canManage:true}); api.readQuoteAutopilotConsent.mockResolvedValue({...common,data:consent});
  api.tickQuoteAutopilot.mockResolvedValue(tick);
  api.readQuoteAutopilotActivity.mockResolvedValue({...common,data:{organizationId:'company-a',items:[],nextCursor:activityCursor(0)}});
  api.readQuoteAutopilotReview.mockResolvedValue({...common,data:{organizationId:'company-a',items:[],nextCursor:null}});
});
afterEach(async () => { if(root) await act(async () => root!.unmount()); root=null;host?.remove();host=null;
  vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers(); });
it('keeps a closed product gate explicitly unavailable without reading consent or ticking', async () => {
  api.getQuoteAutopilotState.mockResolvedValue({...closed,canManage:false}); await mount();
  expect(result.state.status).toBe('unavailable'); expect(result.state.consent).toBeNull();
  expect(api.readQuoteAutopilotConsent).not.toHaveBeenCalled(); expect(api.tickQuoteAutopilot).not.toHaveBeenCalled(); expect(api.setQuoteAutopilotConsent).not.toHaveBeenCalled();
});
it('does nothing for a disconnected company', async () => { await mount(null); expect(result.state.status).toBe('disconnected'); expect(api.getQuoteAutopilotState).not.toHaveBeenCalled(); });
it('waits for admitted consent and reads canonical rows instead of inventing them from tick counts', async () => {
  api.tickQuoteAutopilot.mockResolvedValue({...tick,status:'progress',counts:{confirmed:1,held:0,reviewRequired:0}}); await mount();
  expect(api.tickQuoteAutopilot).toHaveBeenCalledExactlyOnceWith(origin); expect(changed).toHaveBeenCalledTimes(1);
  expect(result.state.activity?.items).toEqual([]); expect(api.setQuoteAutopilotConsent).not.toHaveBeenCalled();
  expect(api.readQuoteAutopilotActivity.mock.invocationCallOrder[0]).toBeLessThan(api.tickQuoteAutopilot.mock.invocationCallOrder[0]);
  expect(result.draftNotices).toEqual([]);
});
it('never ticks from local state availability alone or a disabled consent', async () => {
  api.readQuoteAutopilotConsent.mockResolvedValue({...common,data:{...consent,enabled:false,consentVersion:null}}); await mount();
  expect(result.state.status).toBe('ready'); expect(api.tickQuoteAutopilot).not.toHaveBeenCalled(); expect(api.readQuoteAutopilotReview).toHaveBeenCalledTimes(1);
});
it('sends an explicit revision-bound consent, and uses null when disabling', async () => {
  api.setQuoteAutopilotConsent.mockResolvedValue({...common,data:{...consent,enabled:false,consentVersion:null,revision:3}}); await mount();
  await act(async () => { await result.onConsent(false); });
  expect(api.setQuoteAutopilotConsent).toHaveBeenCalledExactlyOnceWith(origin,{schemaVersion:1,enabled:false,consentVersion:null,expectedRevision:2});
  expect(result.state.consent?.enabled).toBe(false);
});
it('does not infer authority from a response for another organization', async () => {
  api.getQuoteAutopilotState.mockResolvedValue({...common,organizationId:'company-b',canManage:true}); await mount();
  expect(result.state.status).toBe('error'); expect(api.tickQuoteAutopilot).not.toHaveBeenCalled(); expect(result.state.activity).toBeNull();
});
it('does not execute in hidden or offline application contexts', async () => {
  vi.spyOn(navigator,'onLine','get').mockReturnValue(false); await mount();
  expect(result.state.status).toBe('offline'); expect(api.getQuoteAutopilotState).not.toHaveBeenCalled();
});
it('lets read-only collaborators see actual events without ticking or changing consent', async () => {
  api.getQuoteAutopilotState.mockResolvedValue({...common,canManage:false});
  await mount({...context,readOnly:true}); expect(result.state.status).toBe('ready'); expect(result.state.canManage).toBe(false);
  expect(api.tickQuoteAutopilot).not.toHaveBeenCalled(); expect(api.readQuoteAutopilotConsent).not.toHaveBeenCalled();
  await result.onConsent(false); expect(api.setQuoteAutopilotConsent).not.toHaveBeenCalled();
});
it('allows admitted writable members to tick and read shared history without owner consent access or inferred enabled state', async () => {
  api.getQuoteAutopilotState.mockResolvedValue({...common,canManage:false}); await mount();
  expect(api.readQuoteAutopilotConsent).not.toHaveBeenCalled(); expect(api.tickQuoteAutopilot).toHaveBeenCalledExactlyOnceWith(origin);
  expect(result.state.activity?.items).toEqual([]); expect(result.state.consent).toBeNull(); expect(result.state.canManage).toBe(false);
  await result.onConsent(true); expect(api.setQuoteAutopilotConsent).not.toHaveBeenCalled();
});
it('keeps a refused member tick explicit and backs off while reading independently authorized history', async () => {
  api.getQuoteAutopilotState.mockResolvedValue({...common,canManage:false});
  api.tickQuoteAutopilot.mockResolvedValue({...tick,status:'error',code:'forbidden',phase:'none',counts:null}); await mount();
  expect(result.state.error).toBe('permission'); expect(result.state.consent).toBeNull(); expect(result.state.activity?.items).toEqual([]);
  await act(async () => { await vi.advanceTimersByTimeAsync(29_999); }); expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(1);
});
it('treats the real closed native singleflight refusal as busy and keeps authorized history readable', async () => {
  api.tickQuoteAutopilot.mockResolvedValue({ ...tick, status:'busy', code:'busy', organizationId:null, workspaceScope:null, memberContextNonce:null,
    phase:'none', counts:null, roundComplete:false, hasMore:false, pendingRecovery:false });
  await mount();
  expect(result.state.status).toBe('ready'); expect(result.state.error).toBe('busy');
  expect(result.state.consent).toEqual(consent); expect(result.state.activity?.items).toEqual([]); expect(result.state.reviews?.items).toEqual([]);
  expect(api.readQuoteAutopilotActivity).toHaveBeenCalledOnce(); expect(api.readQuoteAutopilotReview).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(29_999); }); expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(2);
});

it('recognizes the real closed native error scope without misreporting a quota refusal as an account change', async () => {
  // The quota block lasts until the next UTC hour; start mid-hour so the five
  // minutes below never cross it, whatever the real clock says.
  vi.setSystemTime(new Date('2026-10-16T10:20:00Z'));
  api.tickQuoteAutopilot.mockResolvedValue({ ...tick, organizationId: null, workspaceScope: null, memberContextNonce: null,
    status: 'error', code: 'rate_limited', phase: 'none', counts: null });
  await mount(); expect(result.state.error).toBe('rate_limited');
  await act(async () => { await result.onRefresh(); await vi.advanceTimersByTimeAsync(300_000); });
  expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(1);
});
it('does not re-render the workspace for an unchanged idle background cycle', async () => {
  await mount(); const before=renders;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(2); expect(renders).toBe(before);
});

it('paces a real-cost hour of idle work with refresh and reconnection headroom', async () => {
  vi.setSystemTime(0); await mount();
  for (let interval = 0; interval < 12; interval++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    await act(async () => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); await result.onRefresh(); });
  }
  expect(api.tickQuoteAutopilot.mock.calls.length).toBeLessThanOrEqual(270);
  expect(api.readQuoteAutopilotConsent.mock.calls.length).toBeLessThanOrEqual(50);
  expect(api.readQuoteAutopilotActivity.mock.calls.length).toBeLessThanOrEqual(100);
  expect(api.readQuoteAutopilotReview.mock.calls.length).toBeLessThanOrEqual(100);
  expect(result.state.error).toBeNull();
});
it('bounds a continuous twenty-source native backlog under both HTTP budgets for a full hour', async () => {
  vi.setSystemTime(0);
  api.tickQuoteAutopilot.mockResolvedValue({ ...tick, status: 'progress', counts: { confirmed: 20, held: 0, reviewRequired: 0 }, roundComplete: false, hasMore: true });
  await mount(); await act(async () => { await vi.advanceTimersByTimeAsync(3_599_999); });
  const nativePages = api.tickQuoteAutopilot.mock.calls.length;
  expect(nativePages).toBe(10);
  expect(nativePages * 21).toBeLessThanOrEqual(400);
  expect(nativePages * 40).toBeLessThanOrEqual(400);
  expect(api.readQuoteAutopilotActivity.mock.calls.length).toBeLessThanOrEqual(100);
  expect(api.readQuoteAutopilotActivity.mock.calls.length).toBeGreaterThan(nativePages);
});
it('does not bypass server quota backoff with focus, refresh or online events', async () => {
  vi.setSystemTime(1_800_000);
  api.readQuoteAutopilotConsent.mockResolvedValue({ ...common, status: 'error', code: 'rate_limited', data: null });
  await mount(); expect(result.state.error).toBe('rate_limited');
  for (let count = 0; count < 10; count++) await act(async () => {
    window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); await result.onRefresh();
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_799_999); });
  expect(api.readQuoteAutopilotConsent).toHaveBeenCalledTimes(1);
  expect(api.tickQuoteAutopilot).not.toHaveBeenCalled();
});
it('keeps monthly quota distinct from network failure and resumes after a plan update',async()=>{
  api.tickQuoteAutopilot.mockResolvedValueOnce({...tick,status:'error',code:'quota_exhausted',organizationId:null,workspaceScope:null,memberContextNonce:null,counts:null,phase:'none'});
  await mount();expect(result.state.error).toBe('quota_exhausted');expect(result.state.status).toBe('ready');
  expect(api.readQuoteAutopilotActivity).toHaveBeenCalledOnce();expect(result.state.activity).not.toBeNull();expect(changed).not.toHaveBeenCalled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(90_000);});
  expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(1);expect(api.readQuoteAutopilotActivity.mock.calls.length).toBeGreaterThan(1);
  expect(result.state.error).toBe('quota_exhausted');
  api.tickQuoteAutopilot.mockResolvedValue(tick);await act(async()=>{await result.onRefresh();});
  expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(2);expect(result.state.error).toBeNull();
});
it('keeps a refresh newer than an in-flight pagination response and returns to the latest page', async () => {
  const firstPage={organizationId:'company-a',items:[],nextCursor:'next_page'};
  api.readQuoteAutopilotReview.mockResolvedValueOnce({...common,data:firstPage}); await mount();
  let finish!:(value:unknown)=>void;
  api.readQuoteAutopilotReview.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
    .mockResolvedValue({...common,data:{organizationId:'company-a',items:[],nextCursor:null}});
  let pageRead!:Promise<void>, refresh!:Promise<void>;
  await act(async()=>{pageRead=result.onNextReviews();});
  expect(api.readQuoteAutopilotReview).toHaveBeenLastCalledWith(origin,{limit:20,cursor:'next_page'});
  await act(async()=>{refresh=result.onRefresh();});
  await act(async()=>{finish({...common,data:{organizationId:'company-a',items:[],nextCursor:'stale_next'}});await pageRead;await refresh;});
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(api.readQuoteAutopilotReview).toHaveBeenCalledTimes(3);
  expect(api.readQuoteAutopilotReview).toHaveBeenLastCalledWith(origin,{limit:20,cursor:null});
  expect(result.state.reviews?.nextCursor).toBeNull(); expect(result.state.readingReviews).toBe(false);
});
it('does not replay an uncertain consent write and clears its actionable cached state', async () => {
  api.setQuoteAutopilotConsent.mockRejectedValue(Error('reply lost')); await mount();
  await act(async () => { await result.onConsent(false); });
  expect(api.setQuoteAutopilotConsent).toHaveBeenCalledTimes(1); expect(result.state.consent).toBeNull(); expect(result.state.error).toBe('save');
});
it('discards a late native reply immediately when the workspace changes', async () => {
  let finish!: (value:unknown)=>void;
  api.readQuoteAutopilotConsent.mockImplementationOnce(() => new Promise(resolve=>{finish=resolve;})); await mount();
  const replacement={...context,organizationId:'company-b',origin:{...origin,expectedWorkspaceScope:'workspace-b'}};
  await act(async () => root!.render(<Probe value={replacement}/>)); expect(result.state.status).toBe('checking');
  await act(async () => finish({...common,data:consent}));
  expect(result.state.activity).toBeNull(); expect(api.tickQuoteAutopilot).not.toHaveBeenCalled();
});

const draftEvent: ConfirmedQuoteActivity = { activityId: 'activity-new', proposalId: 'proposal-new', quoteId: '80000000-0000-4000-8000-000000000001',
  confirmedAt: 1000, kind: 'quote_draft_created', requiresHumanValidation: true };
const draftPage = { organizationId: 'company-a', items: [draftEvent], nextCursor: activityCursor(1) };
it('baselines history before the first production and queues only the new canonical event after it', async () => {
  installFeed([draftEvent]);
  api.readQuoteAutopilotActivity.mockResolvedValueOnce({ ...common, data: { ...draftPage, items: [], nextCursor: activityCursor(0) } });
  api.tickQuoteAutopilot.mockResolvedValue({ ...tick, status: 'progress', counts: { confirmed: 1, held: 0, reviewRequired: 0 } });
  await mount();
  expect(api.readQuoteAutopilotActivity.mock.invocationCallOrder[0]).toBeLessThan(api.tickQuoteAutopilot.mock.invocationCallOrder[0]);
  expect(result.draftNotices).toEqual([draftEvent]);
  await act(async () => { await result.onRefresh(); }); expect(result.draftNotices).toEqual([draftEvent]);
  await act(async () => { expect(result.onDraftNoticeHandled(result.draftNoticeScope!, [draftEvent.activityId])).toBe(true); });
  await act(async () => { await result.onRefresh(); }); expect(result.draftNotices).toEqual([]);
});
it('never announces the initial canonical history, even when the first tick says confirmed', async () => {
  installFeed([draftEvent]);
  api.tickQuoteAutopilot.mockResolvedValue({ ...tick, counts: { confirmed: 1, held: 0, reviewRequired: 0 } });
  await mount(); expect(result.draftNotices).toEqual([]);
});
it('refuses production until the initial canonical read succeeds, then silently baselines history', async () => {
  installFeed([draftEvent]); api.readQuoteAutopilotActivity.mockRejectedValueOnce(Error('temporary read failure'));
  await mount(); expect(api.tickQuoteAutopilot).not.toHaveBeenCalled(); expect(result.draftNotices).toEqual([]);
  await act(async () => { await result.onRefresh(); });
  expect(api.tickQuoteAutopilot).toHaveBeenCalledOnce(); expect(result.draftNotices).toEqual([]);
});
it('retains new IDs through a temporary review failure and pagination without creating additional notices', async () => {
  installFeed([draftEvent]); api.readQuoteAutopilotActivity.mockResolvedValueOnce({ ...common, data: { ...draftPage, items: [], nextCursor: activityCursor(0) } });
  api.tickQuoteAutopilot.mockResolvedValue({ ...tick, counts: { confirmed: 1, held: 0, reviewRequired: 0 } });
  api.readQuoteAutopilotReview.mockResolvedValue({ ...common, data: { organizationId: 'company-a', items: [], nextCursor: 'older' } });
  await mount(); expect(result.draftNotices).toEqual([draftEvent]);
  await act(async () => { await result.onNextReviews(); }); expect(result.draftNotices).toEqual([draftEvent]);
  api.readQuoteAutopilotReview.mockRejectedValueOnce(Error('temporary read failure'));
  await act(async () => { await result.onRefresh(); }); expect(result.state.status).toBe('error'); expect(result.draftNotices).toEqual([draftEvent]);
  await act(async () => { await result.onRefresh(); }); expect(result.draftNotices).toEqual([draftEvent]);
});
it('drops queued notices on disconnect and silently baselines a reconnected session', async () => {
  installFeed([draftEvent]); api.readQuoteAutopilotActivity.mockResolvedValueOnce({ ...common, data: { ...draftPage, items: [], nextCursor: activityCursor(0) } });
  api.tickQuoteAutopilot.mockResolvedValue({ ...tick, counts: { confirmed: 1, held: 0, reviewRequired: 0 } });
  await mount(); expect(result.draftNotices).toEqual([draftEvent]);
  await act(async () => root!.render(<Probe value={null}/>)); expect(result.draftNotices).toEqual([]);
  await act(async () => root!.render(<Probe value={context}/>)); expect(result.draftNotices).toEqual([]);
});
it('uses one initial v2 snapshot for600 historical events, then drains600 new events with the existing worker', async () => {
  const item = (id: number): ConfirmedQuoteActivity => ({ ...draftEvent, activityId: `activity-${id}`, proposalId: `proposal-${id}`,
    quoteId: `80000000-0000-4000-8000-${String(id).padStart(12,'0')}`, confirmedAt: 1000 + id });
  const items = Array.from({ length: 600 }, (_, i) => item(i + 1)); installFeed(items); await mount();
  expect(api.readQuoteAutopilotActivity).toHaveBeenCalledOnce();
  expect(api.readQuoteAutopilotActivity).toHaveBeenCalledWith(origin,{limit:50,cursor:QUOTE_ACTIVITY_LIVE_SELECTOR});
  expect(result.state.activity?.items).toHaveLength(50); expect(result.draftNotices).toEqual([]);
  items.push(...Array.from({ length: 600 }, (_, i) => ({ ...item(i + 601), confirmedAt: i + 1 })));
  const delivered: string[] = [];
  for (let page = 0; page < 12; page++) {
    await act(async () => { await result.onRefresh(); });
    expect(result.draftNotices).toHaveLength(50); delivered.push(...result.draftNotices.map(row => row.activityId));
    await act(async () => { result.onDraftNoticeHandled(result.draftNoticeScope!, result.draftNotices.map(row => row.activityId)); });
  }
  expect(delivered).toHaveLength(600); expect(new Set(delivered).size).toBe(600);
  expect(api.readQuoteAutopilotActivity).toHaveBeenCalledTimes(13);
  expect(result.state.activity?.nextCursor).toBeNull(); expect(result.state.activity?.items[0].activityId).toBe('activity-1151');
});
it('retains the last valid v2 cursor after a foreign cursor failure and resumes without a new baseline', async () => {
  const items = [draftEvent]; installFeed(items); await mount();
  api.readQuoteAutopilotActivity.mockResolvedValueOnce({ ...common, data: { ...draftPage, nextCursor: activityCursor(2,'foreign-user') } });
  await act(async () => { await result.onRefresh(); }); expect(result.state.status).toBe('error');
  items.push({ ...draftEvent, activityId: 'activity-second', proposalId: 'proposal-second', quoteId: '80000000-0000-4000-8000-000000000002' });
  await act(async () => { await result.onRefresh(); });
  expect(api.readQuoteAutopilotActivity).toHaveBeenLastCalledWith(origin,{limit:50,cursor:activityCursor(1)});
  expect(result.draftNotices.map(row=>row.activityId)).toEqual(['activity-second']);
});
it('drains a full v2 batch on the existing scheduled worker without a new timer or manual refresh', async () => {
  const item = (id: number): ConfirmedQuoteActivity => ({ ...draftEvent, activityId: `activity-${id}`, proposalId: `proposal-${id}`,
    quoteId: `80000000-0000-4000-8000-${String(id).padStart(12,'0')}` });
  const items: ConfirmedQuoteActivity[] = []; installFeed(items); await mount();
  items.push(...Array.from({ length: 60 }, (_, i) => item(i + 1)));
  await act(async () => { await result.onRefresh(); }); expect(result.draftNotices).toHaveLength(50);
  await act(async () => { result.onDraftNoticeHandled(result.draftNoticeScope!, result.draftNotices.map(row=>row.activityId)); });
  const reads = api.readQuoteAutopilotActivity.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(14_999); }); expect(api.readQuoteAutopilotActivity).toHaveBeenCalledTimes(reads);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(api.readQuoteAutopilotActivity).toHaveBeenLastCalledWith(origin,{limit:50,cursor:activityCursor(50)});
  expect(result.draftNotices.map(row=>row.activityId)).toEqual(Array.from({length:10},(_,i)=>`activity-${i+51}`));
});
it('keeps production available when pending notices backpressure the change feed, then resumes the same cursor', async () => {
  const items: ConfirmedQuoteActivity[] = []; installFeed(items); await mount();
  items.push(...Array.from({ length: 120 }, (_, i) => ({ ...draftEvent, activityId: `activity-${i+1}`, proposalId: `proposal-${i+1}`,
    quoteId: `80000000-0000-4000-8000-${String(i+1).padStart(12,'0')}` })));
  for (let n=0;n<2;n++) await act(async () => { await result.onRefresh(); });
  expect(result.draftNotices).toHaveLength(100);
  const reads = api.readQuoteAutopilotActivity.mock.calls.length, ticks = api.tickQuoteAutopilot.mock.calls.length;
  await act(async () => { await result.onRefresh(); });
  expect(api.readQuoteAutopilotActivity).toHaveBeenCalledTimes(reads); expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(ticks+1);
  expect(result.state.status).toBe('ready');
  await act(async () => { result.onDraftNoticeHandled(result.draftNoticeScope!, result.draftNotices.slice(0,25).map(row=>row.activityId)); });
  await act(async () => { await result.onRefresh(); });
  expect(api.readQuoteAutopilotActivity).toHaveBeenLastCalledWith(origin,{limit:25,cursor:activityCursor(100)});
  expect(result.draftNotices).toHaveLength(95); expect(result.draftNotices.at(-1)?.activityId).toBe('activity-120');
});
it('preserves the refused producer backoff while an independently authorized change feed has more rows', async () => {
  const items: ConfirmedQuoteActivity[] = []; installFeed(items); await mount();
  items.push(...Array.from({ length: 60 }, (_, i) => ({ ...draftEvent, activityId: `activity-${i+1}`, proposalId: `proposal-${i+1}`,
    quoteId: `80000000-0000-4000-8000-${String(i+1).padStart(12,'0')}` })));
  api.tickQuoteAutopilot.mockResolvedValue({ ...tick, status:'error',code:'forbidden',phase:'none',counts:null });
  await act(async () => { await result.onRefresh(); }); expect(result.draftNotices).toHaveLength(50);
  const ticks = api.tickQuoteAutopilot.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(29_999); }); expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(ticks);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(ticks+1);
  expect(result.draftNotices).toHaveLength(60);
});
