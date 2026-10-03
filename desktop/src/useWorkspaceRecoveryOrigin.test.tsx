/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceRecovery } from './useWorkspaceRecovery';
import { assertWorkspaceOrigin, WorkspaceOriginChangedError } from './workspaceOrigin';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
import type { Workspace } from './types';

const workspace = (scope: string) => ({ workNotesScope: scope }) as Workspace;
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useWorkspaceRecovery>;
const load = vi.fn<() => Promise<Workspace>>();
function Harness() {
  current = useWorkspaceRecovery(load);
  return <div data-pending={String(current.isPending())}>{current.reason}</div>;
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  load.mockReset();
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove(); vi.unstubAllGlobals();
});

it.each([false, true])('ends the old wait on a foreign retry, ACK wrapper=%s', async wrapped => {
  const validate = (value: Workspace) => {
    try { assertWorkspaceOrigin(value, 'scope-A'); }
    catch (reason) { throw wrapped ? new WorkspaceRefreshAfterMutationError(reason) : reason; }
  };
  let result!: Promise<unknown>;
  await act(async () => { result = current.waitForRefresh(Error('Synthetic read unavailable'), true, validate).catch(reason => reason); });
  expect(current.isPending()).toBe(true);
  load.mockResolvedValue(workspace('scope-B'));
  await act(async () => { await current.retry(); });
  expect(await result).toBeInstanceOf(WorkspaceOriginChangedError);
  expect(current.isPending()).toBe(false);
  expect(current.reason).toBe(null);
  expect(current.checkingCreation).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
  // A cancelled old recovery must not reserve the next user's action forever.
  let next!: Promise<Workspace | null>;
  await act(async () => { next = current.waitForRefresh(Error('Another read'), false, value => assertWorkspaceOrigin(value, 'scope-A')); });
  load.mockResolvedValue(workspace('scope-A'));
  await act(async () => { await current.retry(); });
  expect((await next)?.workNotesScope).toBe('scope-A');
});

it('keeps unreadable ordinary retries pending without resolving the outcome', async () => {
  const resolved = vi.fn();
  await act(async () => { void current.waitForRefresh(Error('Initial failure')).then(resolved); });
  load.mockRejectedValue(Error('Synthetic network remains unavailable'));
  await act(async () => { await expect(current.retry()).rejects.toThrow('remains unavailable'); });
  expect(current.isPending()).toBe(true);
  expect(resolved).not.toHaveBeenCalled();
  load.mockResolvedValue(workspace('scope-A'));
  await act(async () => { await current.retry(); });
  expect(resolved).toHaveBeenCalledExactlyOnceWith(workspace('scope-A'));
});

it('keeps an ordinary validation failure pending for a later authoritative read', async () => {
  const resolved = vi.fn();
  await act(async () => { void current.waitForRefresh(Error('Initial failure'), true, value => { if (value.workNotesScope === 'unreadable') throw Error('Synthetic validation failure'); }).then(resolved); });
  load.mockResolvedValue(workspace('unreadable'));
  await act(async () => { await expect(current.retry()).rejects.toThrow('validation failure'); });
  expect(current.isPending()).toBe(true); expect(resolved).not.toHaveBeenCalled();
  load.mockResolvedValue(workspace('scope-A'));
  await act(async () => { await current.retry(); });
  expect(resolved).toHaveBeenCalledTimes(1);
});
