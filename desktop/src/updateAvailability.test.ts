import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  getSecureUpdatePolicy: vi.fn(),
  checkSecureUpdate: vi.fn(),
}));
vi.mock('./bridge', () => ({ desktopApi: api }));
const update = {
  version: '1.50.0',
  currentVersion: '1.49.0',
  date: null,
  notes: 'Pension et mises à jour',
};
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10'));
  api.getSecureUpdatePolicy.mockReset().mockResolvedValue({ enabled: true });
  api.checkSecureUpdate.mockReset().mockResolvedValue(update);
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('notification de mise à jour', () => {
  it('partage la recherche entre le menu et le panneau, puis enlève une version retirée', async () => {
    const s = await import('./updateAvailability');
    const listener = vi.fn();
    const stop = s.subscribeToUpdates(listener);
    const one = s.checkUpdateAvailability();
    const two = s.checkUpdateAvailability(true);
    expect(one).toBe(two);
    await one;
    expect(api.checkSecureUpdate).toHaveBeenCalledTimes(1);
    expect(s.getAvailableUpdate()).toEqual(update);
    api.checkSecureUpdate.mockResolvedValue(null);
    await s.checkUpdateAvailability(true);
    expect(s.getAvailableUpdate()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
  it('garde le badge après une panne réseau, sans fabriquer une mise à jour', async () => {
    const s = await import('./updateAvailability');
    api.checkSecureUpdate.mockRejectedValueOnce(new Error('offline'));
    await expect(s.checkUpdateAvailability(true)).rejects.toThrow();
    expect(s.getAvailableUpdate()).toBeNull();
    await s.checkUpdateAvailability(true);
    api.checkSecureUpdate.mockRejectedValueOnce(new Error('offline'));
    await expect(s.checkUpdateAvailability(true)).rejects.toThrow();
    expect(s.getAvailableUpdate()).toEqual(update);
    s.clearAvailableUpdate();
    expect(s.getAvailableUpdate()).toBeNull();
  });
  it('respecte les pauses du panneau et limite les recherches au retour dans la fenêtre', async () => {
    const s = await import('./updateAvailability');
    const resume = s.pauseBackgroundUpdateChecks();
    await s.checkUpdateAvailability();
    expect(api.checkSecureUpdate).not.toHaveBeenCalled();
    await s.checkUpdateAvailability(true);
    expect(api.checkSecureUpdate).toHaveBeenCalledTimes(1);
    resume();
    resume();
    await s.checkUpdateAvailability();
    expect(api.checkSecureUpdate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(s.UPDATE_CHECK_INTERVAL_MS);
    await s.checkUpdateAvailability();
    expect(api.checkSecureUpdate).toHaveBeenCalledTimes(2);
  });
  it('ne recherche pas hors ligne et efface le badge pour un canal désactivé', async () => {
    const s = await import('./updateAvailability');
    vi.stubGlobal('navigator', { onLine: false });
    await s.checkUpdateAvailability();
    expect(api.checkSecureUpdate).not.toHaveBeenCalled();
    await s.checkUpdateAvailability(true);
    api.getSecureUpdatePolicy.mockResolvedValue({ enabled: false });
    await s.checkUpdateAvailability(true);
    expect(s.getAvailableUpdate()).toBeNull();
  });
});
