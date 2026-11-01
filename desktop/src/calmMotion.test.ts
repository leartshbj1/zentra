// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { releaseHistory } from './appReleaseNotes';

const key = 'zentra.boot.v1';
const load = async () => { vi.resetModules(); return import('./calmMotion'); };
const saved = () => JSON.parse(localStorage.getItem(key) ?? 'null');
afterEach(() => { localStorage.clear(); vi.useRealTimers(); delete document.documentElement.dataset.calmStart; });

it('starts normally, then clears its mark once the app has stayed open', async () => {
  vi.useFakeTimers();
  const guard = await load();
  expect(guard.unfinishedStarts).toBe(0);
  expect(guard.calmStart).toBe(false);
  guard.installStartupGuard();
  expect(saved()).toMatchObject({ open: true, strikes: 0 });
  vi.advanceTimersByTime(20_000);
  expect(saved()).toMatchObject({ open: false, strikes: 0 });
  expect(document.documentElement.dataset.calmStart).toBeUndefined();
});

it('one start that did not settle is noted but keeps the animations', async () => {
  localStorage.setItem(key, JSON.stringify({ open: true, strikes: 0 }));
  const guard = await load();
  expect(guard.unfinishedStarts).toBe(1);
  expect(guard.calmStart).toBe(false);
});

it('two starts in a row that did not settle make this version calm, even after it settles', async () => {
  vi.useFakeTimers();
  localStorage.setItem(key, JSON.stringify({ open: true, strikes: 1 }));
  const guard = await load();
  expect(guard.unfinishedStarts).toBe(2);
  expect(guard.calmStart).toBe(true);
  expect(guard.plainIntro).toBe(true);
  guard.installStartupGuard();
  expect(document.documentElement.dataset.calmStart).toBe('true');
  vi.advanceTimersByTime(20_000);
  expect(saved()).toMatchObject({ open: false, strikes: 0, calmVersion: releaseHistory[0].version });
  expect((await load()).calmStart).toBe(true);
});

it('a new version gets its animations back', async () => {
  localStorage.setItem(key, JSON.stringify({ open: false, strikes: 0, calmVersion: '0.0.1' }));
  expect((await load()).calmStart).toBe(false);
});

it('works without storage', async () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('Unavailable'); }, setItem: () => { throw Error('Unavailable'); }, clear: () => {} });
  try {
    const guard = await load();
    expect(guard.calmStart).toBe(false);
    expect(() => guard.installStartupGuard()).not.toThrow();
  } finally { vi.unstubAllGlobals(); }
});
