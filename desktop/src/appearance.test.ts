import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => native);
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); native.invoke.mockReset(); });

function environment(saved = 'dark', systemDark = false) {
  const media = Object.assign(new EventTarget(), { matches: systemDark });
  const target = Object.assign(new EventTarget(), { matchMedia: () => media });
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  let stored = saved;
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { documentElement: root, querySelector: () => null });
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_: string, value: string) => { stored = value; } });
  return { root, media, target };
}

describe('appearance restoration', () => {
  it('restores the startup canvas and sends only the latest pending native choice', async () => {
    const { root } = environment();
    let finish!: () => void;
    native.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const { setAppearance } = await import('./appearance');
    setAppearance('light'); setAppearance('dark'); setAppearance('light');
    expect(root.dataset.appTheme).toBe('light');
    expect(root.style.backgroundColor).toBe('#f5f5f7');
    expect(native.invoke).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2));
    expect(native.invoke).toHaveBeenLastCalledWith('set_app_appearance', { appearance: 'light', dark: false });
  });
  it('follows system changes again after storage is cleared', async () => {
    const { root, target, media } = environment();
    native.invoke.mockResolvedValue(undefined);
    await import('./appearance');
    target.dispatchEvent(Object.assign(new Event('storage'), { key: null, newValue: null }));
    expect(root.dataset.appTheme).toBe('light');
    media.matches = true; media.dispatchEvent(new Event('change'));
    expect(root.dataset.appTheme).toBe('dark');
    media.matches = false; media.dispatchEvent(new Event('change'));
    expect(root.style.backgroundColor).toBe('#f5f5f7');
  });
  it('keeps the UI usable if saving or the native command fails', async () => {
    const { root } = environment();
    native.invoke.mockRejectedValue(new Error('Window not ready'));
    const { setAppearance } = await import('./appearance');
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('Storage unavailable'); } });
    expect(setAppearance('light')).toBe(false);
    expect(root.style.backgroundColor).toBe('#f5f5f7');
    await vi.waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith('set_app_appearance', { appearance: 'light', dark: false }));
  });
  it.each([true, false])('uses the system at first paint when storage is blocked (dark=%s)', systemDark => {
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    runInNewContext(readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8'), {
      document: { documentElement: root }, matchMedia: () => ({ matches: systemDark }),
      localStorage: { getItem: () => { throw new Error('Blocked'); } },
    });
    expect(root.dataset.appTheme).toBe(systemDark ? 'dark' : 'light');
    expect(root.style.backgroundColor).toBe(systemDark ? '#141416' : '#f5f5f7');
  });
});
