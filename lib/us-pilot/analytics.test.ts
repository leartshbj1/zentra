import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPilotUuid } from './validation';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function setup(dnt = '0', storageFails = false) {
  const data = new Map<string, string>();
  vi.stubGlobal('window', {
    location: {
      search: '?utm_source=us-test&utm_medium=email&utm_campaign=launch',
    },
  });
  vi.stubGlobal('navigator', { doNotTrack: dnt });
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => {
      if (storageFails) throw new Error();
      return data.get(key);
    },
    setItem: (key: string, value: string) => data.set(key, value),
  });
  return import('./analytics');
}
describe('provider-independent US analytics', () => {
  it('keeps attribution and a stable anonymous visit, without application data', async () => {
    const analytics = await setup();
    const provider = vi.fn();
    analytics.setPilotAnalyticsProvider(provider);
    analytics.trackPilotEvent('page_view');
    analytics.trackPilotEvent('watch_demo', {
      workflow: 'invoice',
      mode: 'manual',
    });
    expect(provider).toHaveBeenCalledTimes(2);
    const first = provider.mock.calls[0][0];
    expect(first.utm_campaign).toBe('launch');
    expect(isPilotUuid(first.visitor_id)).toBe(true);
    expect(provider.mock.calls[1][0].visitor_id).toBe(first.visitor_id);
    expect(first).not.toHaveProperty('email');
  });
  it('honors Do Not Track and never forges client conversion events', async () => {
    const analytics = await setup('1');
    const provider = vi.fn();
    analytics.setPilotAnalyticsProvider(provider);
    analytics.trackPilotEvent('page_view');
    expect(provider).not.toHaveBeenCalled();
  });
  it('survives unavailable storage and provider failures', async () => {
    const analytics = await setup('0', true);
    analytics.setPilotAnalyticsProvider(() => {
      throw new Error('offline');
    });
    expect(() => analytics.trackPilotEvent('page_view')).not.toThrow();
    expect(isPilotUuid(analytics.pilotContext().visitor_id)).toBe(true);
  });
  it('reserves conversion tracking for the server', async () => {
    const analytics = await setup();
    const provider = vi.fn();
    analytics.setPilotAnalyticsProvider(provider);
    analytics.trackPilotEvent('pilot_form_submitted');
    expect(provider).not.toHaveBeenCalled();
  });
});
