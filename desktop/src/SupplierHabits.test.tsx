import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from './types';

// Hook host exercises the actual effect and handlers without a DOM dependency.
// Real React/DOM scheduling is also checked by the isolated browser fixture.
const host = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const index = host.cursor++;
    if (!(index in host.values)) host.values[index] = initial;
    return [host.values[index], (next: unknown) => {
      host.values[index] = typeof next === 'function' ? next(host.values[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    const index = host.cursor++;
    if (!(index in host.values)) host.values[index] = { current: initial };
    return host.values[index];
  },
  useEffect(effect: () => (() => void), deps: unknown[]) {
    const index = host.cursor++;
    const previous = host.values[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      const entry = { deps, cleanup: undefined as (() => void) | undefined };
      host.values[index] = entry;
      host.effects.push(() => { previous?.cleanup?.(); entry.cleanup = effect(); });
    }
  },
}));
vi.mock('./language', () => ({ useAppLanguage: () => 'fr', t: (source: string) => source }));
vi.mock('./supplierInbox', () => ({ inboxRequest: vi.fn() }));
vi.mock('./ui', () => ({ Button: () => null }));
import { SupplierHabits } from './SupplierHabits';
import { inboxRequest, type SupplierInboxState } from './supplierInbox';
import { Button } from './ui';

function deferred() {
  let resolve!: (value: SupplierInboxState) => void, reject!: (error: Error) => void;
  const promise = new Promise<SupplierInboxState>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tasks: ReturnType<typeof deferred>[] = [];
const request = vi.mocked(inboxRequest);
const state = (sender = 'Newest habit', org = 'synthetic-org', empty = false) => ({
  organizationId: org, habits: empty ? [] : [{ id: 'habit-1', sender, supplierId: 'synthetic-supplier', category: 'Synthetic category' }],
} as SupplierInboxState);
function render(org = 'synthetic-org', scope = 'scope-a', manage = true) {
  host.cursor = 0;
  const tree = SupplierHabits({ org, workspace: { workNotesScope: scope, suppliers: [] } as unknown as Workspace, manage });
  for (const effect of host.effects.splice(0)) effect();
  return tree;
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object' && 'props' in node) return text((node as ReactElement<{ children?: ReactNode }>).props.children);
  return '';
}
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...elements(element.props.children)];
}
function forget(tree: ReactNode) {
  const button = elements(tree).find(element => element.type === Button)!;
  return (button.props as { onClick: () => Promise<void> }).onClick();
}
function event(type = 'focus') { window.dispatchEvent(new Event(type)); }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function unmount() {
  for (const value of host.values) (value as { cleanup?: () => void } | undefined)?.cleanup?.();
}
beforeEach(() => {
  host.values = []; host.cursor = 0; host.effects = []; tasks.length = 0;
  vi.stubGlobal('window', new EventTarget());
  request.mockReset().mockImplementation(() => { const task = deferred(); tasks.push(task); return task.promise; });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('supplier habits scoped read admission', () => {
  it('coalesces event bursts into one fresh read and never publishes the outdated snapshot', async () => {
    render();
    for (let i = 0; i < 20; i++) { event(); event('zentra-automation-updated'); }
    expect(request).toHaveBeenCalledTimes(1);
    tasks[0].resolve(state('Old habit')); await settle();
    expect(text(render())).not.toContain('Old habit');
    expect(request).toHaveBeenCalledTimes(2);
    tasks[1].resolve(state()); await settle();
    expect(text(render())).toContain('Newest habit');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('retires a pending read on a local scope change in the same organization', async () => {
    render(); render('synthetic-org', 'scope-b');
    expect(request).toHaveBeenCalledTimes(2);
    tasks[1].resolve(state('Current scope habit')); await settle();
    tasks[0].resolve(state('Old scope habit')); await settle();
    const content = text(render('synthetic-org', 'scope-b'));
    expect(content).toContain('Current scope habit'); expect(content).not.toContain('Old scope habit');
  });
  it.each(['success', 'failure'])('does not publish a late %s or request another read after unmount', async outcome => {
    render(); event(); unmount();
    if (outcome === 'success') tasks[0].resolve(state()); else tasks[0].reject(Error('Synthetic outage'));
    await settle(); event();
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.values[0]).toEqual([]); expect(host.values[1]).toBe('');
  });
  it('keeps the displayed snapshot on failure and permits one explicit retry without an automatic loop', async () => {
    render(); tasks[0].resolve(state('Kept habit')); await settle(); event();
    tasks[1].reject(Error('Synthetic unavailable')); await settle();
    expect(text(render())).toContain('Kept habit'); expect(text(render())).toContain('temporairement indisponibles');
    expect(request).toHaveBeenCalledTimes(2);
    event('zentra-automation-updated'); tasks[2].resolve(state()); await settle();
    expect(text(render())).toContain('Newest habit'); expect(text(render())).not.toContain('temporairement indisponibles');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('does not resurrect a confirmed forgotten habit from a pending GET or repeat the POST', async () => {
    render(); tasks[0].resolve(state('Habit to forget')); await settle(); event();
    const done = forget(render()); tasks[2].resolve(state()); await done; await settle();
    expect(text(render())).not.toContain('Habit to forget');
    tasks[1].resolve(state('Forgotten old habit')); await settle();
    expect(text(render())).not.toContain('Forgotten old habit');
    tasks[3].resolve(state('', 'synthetic-org', true)); await settle();
    expect(request.mock.calls.filter(([data]) => data !== undefined)).toEqual([[{ action: 'forgetHabit', id: 'habit-1' }]]);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it.each(['success', 'failure'])('ignores an old forget %s after switching company', async outcome => {
    render(); tasks[0].resolve(state('Old account habit')); await settle();
    const done = forget(render());
    render('synthetic-other', 'scope-b'); tasks[2].resolve(state('Current account habit', 'synthetic-other')); await settle();
    if (outcome === 'success') tasks[1].resolve(state()); else tasks[1].reject(Error('Synthetic old account refusal'));
    await done; await settle();
    expect(text(render('synthetic-other', 'scope-b'))).toContain('Current account habit');
    expect(text(render('synthetic-other', 'scope-b'))).not.toContain('old account refusal');
    expect(request.mock.calls.filter(([data]) => data !== undefined)).toHaveLength(1);
  });
  it('uses current permission before accepting a stale forget callback', async () => {
    render(); tasks[0].resolve(state()); await settle(); const oldTree = render();
    render('synthetic-org', 'scope-a', false);
    await forget(oldTree);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('submits a forget mutation only once on two immediate clicks', async () => {
    render(); tasks[0].resolve(state()); await settle(); const tree = render();
    const first = forget(tree), second = forget(tree);
    expect(request.mock.calls.filter(([data]) => data !== undefined)).toHaveLength(1);
    tasks[1].resolve(state()); await first; await second; await settle();
    expect(request.mock.calls.filter(([data]) => data !== undefined)).toHaveLength(1);
    tasks[2].resolve(state('', 'synthetic-org', true)); await settle();
  });
  it('allows read-only consultation without exposing a forget action', async () => {
    render('synthetic-org', 'scope-a', false); tasks[0].resolve(state()); await settle();
    const tree = render('synthetic-org', 'scope-a', false);
    expect(text(tree)).toContain('Newest habit');
    expect(elements(tree).some(element => element.type === Button)).toBe(false);
    expect(request).toHaveBeenCalledExactlyOnceWith();
  });
});
