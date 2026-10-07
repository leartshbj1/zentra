'use client';
import {
  isPilotUuid,
  attribution,
  type Attribution,
  type PilotEventName,
} from './validation';

type AnalyticsEvent = {
  id: string;
  visitor_id: string;
  event_name: PilotEventName;
  page: '/us';
  properties: Record<string, string>;
} & Attribution;
export type PilotAnalyticsProvider = (
  event: AnalyticsEvent,
) => void | Promise<void>;
let provider: PilotAnalyticsProvider = (event) =>
  fetch('/api/us-pilot/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    keepalive: true,
  }).then(() => undefined);
let context: { visitor_id: string; attribution: Attribution } | null = null;
/** Optional future provider; the page depends only on this adapter. Never send form values. */
export function setPilotAnalyticsProvider(next: PilotAnalyticsProvider) {
  provider = next;
}
export function pilotContext() {
  if (context) return context;
  let visitor_id = crypto.randomUUID();
  let campaign = attribution(
    Object.fromEntries(new URLSearchParams(window.location.search)),
  );
  try {
    const previous = JSON.parse(
      sessionStorage.getItem('zentra:us:visit') || 'null',
    );
    if (previous && isPilotUuid(previous.visitor_id))
      visitor_id = previous.visitor_id;
    if (
      !campaign.utm_source &&
      !campaign.utm_medium &&
      !campaign.utm_campaign &&
      previous
    )
      campaign = attribution(previous);
    sessionStorage.setItem(
      'zentra:us:visit',
      JSON.stringify({ visitor_id, ...campaign }),
    );
  } catch {
    /* Storage can be disabled; the in-memory context still works. */
  }
  context = { visitor_id, attribution: campaign };
  return context;
}
export function pilotMeasurementAllowed() {
  return (
    navigator.doNotTrack !== '1' &&
    !(navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl
  );
}
export function trackPilotEvent(
  event_name: PilotEventName,
  properties: Record<string, string> = {},
) {
  if (!pilotMeasurementAllowed() || event_name === 'pilot_form_submitted')
    return;
  const visit = pilotContext();
  try {
    void Promise.resolve(
      provider({
        id: crypto.randomUUID(),
        visitor_id: visit.visitor_id,
        ...visit.attribution,
        event_name,
        page: '/us',
        properties,
      }),
    ).catch(() => undefined);
  } catch {
    /* Analytics must not block reading, demonstrations, or applications. */
  }
}
