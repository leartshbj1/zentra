// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAutopilot, type AutopilotContext } from './useAutopilot';
const api = vi.hoisted(() => ({ getQuoteAutopilotState: vi.fn(), readQuoteAutopilotConsent: vi.fn(),
  setQuoteAutopilotConsent: vi.fn(), tickQuoteAutopilot: vi.fn(), readQuoteAutopilotActivity: vi.fn(), readQuoteAutopilotReview: vi.fn() }));
vi.mock('./bridge', () => ({ desktopApi: api }));
vi.mock('./diagnostics', () => ({ classifyDiagnosticError: () => 'NETWORK', recordDiagnostic: vi.fn() }));
const origin = { expectedWorkspaceScope: 'workspace-a', expectedMemberContextNonce: 'a'.repeat(32) };
const context: AutopilotContext = { organizationId: 'company-a', origin, readOnly: false };
const common = { schemaVersion: 1, status: 'available', code: 'none', organizationId: 'company-a', workspaceScope: 'workspace-a', memberContextNonce: 'a'.repeat(32) };
const consent = { schemaVersion: 1, enabled: true, revision: 2, consentVersion: 'version', requiredConsentVersion: 'version' };
const closed = { schemaVersion: 1, status: 'unavailable', code: 'product_gate_closed', organizationId: null, workspaceScope: null, memberContextNonce: null };
const tick = { ...common,status:'idle',phase:'page',counts:{confirmed:0,held:0,reviewRequired:0},roundComplete:true,hasMore:false,pendingRecovery:false };
let result: ReturnType<typeof useAutopilot>, root: Root | null = null, host: HTMLDivElement | null = null, renders = 0;
const changed = vi.fn();
function Probe({value}:{value:AutopilotContext|null}) { renders++; result=useAutopilot(value,changed); return <div>{result.state.status}</div>; }
async function mount(value: AutopilotContext|null = context) { host=document.createElement('div'); document.body.append(host); root=createRoot(host);
  await act(async () => root!.render(<Probe value={value}/>)); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); vi.clearAllMocks(); renders=0;
  vi.spyOn(navigator,'onLine','get').mockReturnValue(true); vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  api.getQuoteAutopilotState.mockResolvedValue({...common,canManage:true}); api.readQuoteAutopilotConsent.mockResolvedValue({...common,data:consent});
  api.tickQuoteAutopilot.mockResolvedValue(tick);
  api.readQuoteAutopilotActivity.mockResolvedValue({...common,data:{organizationId:'company-a',items:[],nextCursor:null}});
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
it('does not re-render the workspace for an unchanged idle background cycle', async () => {
  await mount(); const before=renders;
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(api.tickQuoteAutopilot).toHaveBeenCalledTimes(2); expect(renders).toBe(before);
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
