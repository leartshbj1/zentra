import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Execute the real component and its effects without replacing its loaders.
// Children are inert: this suite exercises request ordering, not child layout.
const host = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const slots: Slot[] = [];
  const effects: (() => void)[] = [];
  let cursor = 0, dirty = false;
  const changed = (left?: readonly unknown[], right?: readonly unknown[]) =>
    !left || !right || left.length !== right.length || left.some((value, index) => !Object.is(value, right[index]));
  return {
    slots, effects,
    reset() { slots.length = 0; effects.length = 0; cursor = 0; dirty = false; },
    start() { cursor = 0; dirty = false; },
    get dirty() { return dirty; },
    useState(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next: unknown) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useId() { return `test-${cursor++}`; },
    useCallback(callback: unknown, deps: readonly unknown[]) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(effect: () => undefined | (() => void), deps?: readonly unknown[]) {
      const index = cursor++, previous = slots[index];
      if (!previous || changed(previous.deps, deps)) {
        const next: Slot = { deps }; slots[index] = next;
        effects.push(() => { previous?.cleanup?.(); next.cleanup = effect() || undefined; });
      }
    },
    runEffects() { for (const effect of effects.splice(0)) effect(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
});
vi.mock('react', () => host);
vi.mock('react/jsx-runtime', () => ({ jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }), Fragment: 'fragment' }));
vi.mock('lucide-react', () => Object.fromEntries(['ArrowLeft','ArrowUpRight','BarChart3','CircleHelp','Inbox','Link2','Settings2','ShieldCheck','Search','Users','X','Plus','AlertCircle','CreditCard','Folder','CheckCheck','ChevronDown','Workflow','BellOff','Bell'].map(name => [name, name])));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/tabs', () => ({ Tabs: 'Tabs', TabsList: 'TabsList', TabsTrigger: 'TabsTrigger', TabsContent: 'TabsContent' }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: 'Dialog', DialogContent: 'DialogContent', DialogHeader: 'DialogHeader', DialogTitle: 'DialogTitle', DialogDescription: 'DialogDescription' }));
vi.mock('@/components/brand-mark', () => ({ BrandWordmark: 'BrandWordmark' }));
vi.mock('@/components/support/panels', () => ({ ConnectionsPanel: 'ConnectionsPanel', RoutingPanel: 'RoutingPanel', TeamPanel: 'TeamPanel', InsightsPanel: 'InsightsPanel', ReviewForm: 'ReviewForm' }));
vi.mock('@/components/support/controls', () => ({ Choice: 'Choice', Field: 'Field', formatDate: String }));
vi.mock('@/components/support/billing-panel', () => ({ BillingPanel: 'BillingPanel' }));
vi.mock('@/components/support/quota-notice', () => ({ SupportQuotaNotice: 'SupportQuotaNotice' }));
vi.mock('@/components/support/solicitation-panel', () => ({ SolicitationActions: 'SolicitationActions', SolicitationPreferences: 'SolicitationPreferences', dispositionLabel: String }));
vi.mock('@/components/support/productivity-panel', () => ({ DailyBrief: 'DailyBrief', ConnectionHealth: 'ConnectionHealth', SenderRules: 'SenderRules', MessageProductivity: 'MessageProductivity', BatchSolicitations: 'BatchSolicitations' }));
vi.mock('@/components/automation/company-settings', () => ({ AutomationCompanySettings: 'AutomationCompanySettings' }));

import { SupportWorkspace } from '@/components/support/application';
import { emptyState, type SupportState } from '@/components/support/model';

type Node = { type?: unknown; props?: Record<string, unknown> };
let tree: Node;
const documentEvents = vi.fn<(event: string, callback: () => void) => void>();
function render() { host.start(); tree = SupportWorkspace({ demo: false }) as unknown as Node; host.runEffects(); }
async function settle() {
  for (let turn = 0; turn < 20; turn++) {
    for (let tick = 0; tick < 12; tick++) await Promise.resolve();
    if (!host.dirty) return;
    render();
  }
  throw Error('Component did not settle');
}
function find(predicate: (node: Node) => boolean): Node | undefined {
  function walk(value: unknown): Node | undefined {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) { const found = walk(child); if (found) return found; } return; }
    const node = value as Node;
    if (predicate(node)) return node;
    return walk(node.props?.children);
  }
  return walk(tree);
}
function change(predicate: (node: Node) => boolean, value: unknown) {
  const onChange = find(predicate)?.props?.onChange;
  if (typeof onChange !== 'function') throw Error('Control not found');
  onChange(value);
}
function postedWorkspace(init?: RequestInit) {
  if (typeof init?.body !== 'string') throw Error('JSON request expected');
  return (JSON.parse(init.body) as {workspaceId:string}).workspaceId;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(workspace = 'a', subject = 'Initial', mailbox = false): SupportState {
  return { ...emptyState, user: { name: 'Synthetic', email: 'synthetic@example.test' },
    workspaces: ['a','b'].map(id => ({ id, name: id, role: 'owner' })),
    workspace: { id: workspace, name: workspace, mode: 'suggest', threshold: .8, baselineSeconds: 60, triageContext: '', role: 'owner', canManage: true, aiReady: true },
    connections: mailbox ? [{ id: `mail-${workspace}`, provider: 'infomaniak', label: 'Synthetic mailbox', domain: '', directory: { teams: [], agents: [] }, rules: {}, active: true, hookUrl: '' }] : [],
    tickets: [{ id: subject, connectionId: 'api', externalId: subject, subject, body: 'Synthetic', revision: 1, state: 'review', decision: null, error: null, automatic: false, corrected: false, createdAt: 1, updatedAt: 1, routedAt: null }],
  };
}
// Observe the state passed to the real view, independently of hook ordering.
const data = () => {
  const value = find(node => node.type === 'ConnectionsPanel')?.props?.data;
  if (!value) throw Error('Support view did not receive its state');
  return value as SupportState;
};
beforeEach(() => {
  host.reset(); vi.useFakeTimers();
  documentEvents.mockClear();
  vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('document', { hidden: false, visibilityState: 'visible', addEventListener: documentEvents, removeEventListener: vi.fn() });
});
afterEach(() => { host.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Support workspace request lifecycle', () => {
  it('allows a valid 20-second read to complete instead of restarting it at each polling tick', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(fixture('a', 'Delayed response'))), 20000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    render(); await settle();
    const visible = documentEvents.mock.calls.find(([event]) => event === 'visibilitychange')?.[1];
    if (typeof visible !== 'function') throw Error('Foreground polling callback missing');
    visible(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20000); await settle();
    expect.soft(data().tickets[0]?.subject).toBe('Delayed response');
    expect.soft(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40000); await settle();
    expect.soft(data().tickets[0]?.subject).toBe('Delayed response');
    expect.soft(fetcher.mock.calls.filter(([, init]) => init?.signal?.aborted)).toHaveLength(0);
    expect.soft(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['filter','workspace'] as const)('replaces a slow %s read and ignores its older body after the new response has completed', async (changeKind) => {
    const oldBody = deferred<SupportState>();
    let reads = 0;
    const updatedSubject = changeKind === 'filter' ? 'New filter' : 'New workspace';
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      reads++;
      if (reads === 2) return { ok: true, status: 200, json: () => oldBody.promise };
      return Response.json(fixture(url.includes('workspace=b') ? 'b' : 'a', url.includes('state=review') || url.includes('workspace=b') ? updatedSubject : 'Initial'));
    });
    vi.stubGlobal('fetch', fetcher);
    render(); await settle();
    vi.advanceTimersByTime(15000); await settle(); // Old headers arrive; body remains pending.
    const oldSignal = fetcher.mock.calls[1][1]!.signal!;
    if (changeKind === 'filter') change(node => node.props?.['aria-label'] === 'Filtrer par état', { target: { value: 'review' } });
    else change(node => node.props?.label === 'Votre espace', 'b');
    render(); await settle();
    expect(oldSignal.aborted).toBe(true);
    expect(data().tickets[0].subject).toBe(updatedSubject);
    oldBody.resolve(fixture('a', 'Old body')); await settle();
    expect(data().tickets[0].subject).toBe(updatedSubject);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps the explicit reload after a mutation able to replace a slow read', async () => {
    let reads=0;
    const fetcher=vi.fn(async (_url:string,init?:RequestInit) => {
      if(init?.method==='POST')return Response.json({saved:true});
      reads++;
      if(reads!==2)return Response.json(fixture('a',reads===1?'Initial':'After mutation'));
      return await new Promise<Response>((resolve,reject)=>{
        const timer=setTimeout(()=>resolve(Response.json(fixture('a','Obsolete'))),20000);
        init!.signal!.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});
      });
    });
    vi.stubGlobal('fetch',fetcher);
    render();await settle();
    await vi.advanceTimersByTimeAsync(15000);await settle();
    const oldSignal=fetcher.mock.calls[1][1]!.signal!;
    const mutate=find(node=>node.type==='ConnectionsPanel')?.props?.mutate;
    if(typeof mutate!=='function')throw Error('Mutation callback not found');
    const result=await mutate({action:'settings',name:'Synthetic settings'});await settle();
    expect(result).toEqual({saved:true});
    expect(oldSignal.aborted).toBe(true);
    expect(data().tickets[0].subject).toBe('After mutation');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('keeps one mailbox tick in flight and searches never restart mailbox reception', async () => {
    const mail = deferred<Response>();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? mail.promise : Response.json(fixture('a', 'Search result', true)));
    vi.stubGlobal('fetch', fetcher);
    render(); await settle();
    const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts()).toHaveLength(1);
    for (const term of ['Facture', 'Facture 10', 'Facture 100']) {
      change(node => node.props?.['aria-label'] === 'Rechercher un ticket', { target: { value: term } });
      render(); vi.advanceTimersByTime(250); await settle();
    }
    vi.advanceTimersByTime(60000); await settle();
    expect(posts()).toHaveLength(1);
    mail.resolve(Response.json({ idle: true })); await settle();
    const lastUrl = fetcher.mock.calls.at(-1)![0];
    expect(lastUrl).toContain('search=Facture+100');
    expect(posts()).toHaveLength(1);
  });

  it('aborts the old workspace tick and starts the new one without awaiting its predecessor', async () => {
    const oldMail = deferred<Response>(), newMail = deferred<Response>();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return postedWorkspace(init) === 'a' ? oldMail.promise : newMail.promise;
      return Response.json(fixture(url.includes('workspace=b') ? 'b' : 'a', 'Current', true));
    });
    vi.stubGlobal('fetch', fetcher);
    render(); await settle();
    const oldSignal = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.signal!;
    change(node => node.props?.label === 'Votre espace', 'b');
    render(); await settle();
    expect(oldSignal.aborted).toBe(true);
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([, init]) => postedWorkspace(init))).toEqual(['a','b']);
    const callsBeforeLateResponse = fetcher.mock.calls.length;
    oldMail.resolve(Response.json({ imported: 1 })); await settle();
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeLateResponse);
    expect(data().workspace?.id).toBe('b');
    host.unmount();
    expect(posts[1][1]!.signal!.aborted).toBe(true);
    newMail.resolve(Response.json({ idle: true })); await settle();
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeLateResponse);
  });
});
