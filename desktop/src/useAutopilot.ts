import { useLayoutEffect, useRef, useState } from 'react';
import { desktopApi, type QuoteAutopilotOrigin } from './bridge';
import { createAutopilotSession, type AutopilotCycleGuard, type AutopilotCycleResult } from './autopilotSession';
import { autopilotBudget } from './autopilotBudget';
import { normalizeConfirmedQuoteActivityPage } from './confirmedQuoteActivity';
import { normalizeAutopilotReviewPage } from './autopilotReview';
import type { AutopilotView } from './autopilotView';
import { classifyDiagnosticError, recordDiagnostic } from './diagnostics';

export type AutopilotContext = Readonly<{ organizationId: string; origin: QuoteAutopilotOrigin; readOnly: boolean }>;
type ScopedReply = { schemaVersion: number; status: string; code: string; organizationId: string | null;
  workspaceScope: string | null; memberContextNonce: string | null };
type BoundState = { key: string | null; state: AutopilotView };
const empty = (status: AutopilotView['status']): AutopilotView => ({ status, consent: null, canManage: false,
  saving: false, error: null, activity: null, reviews: null, reviewsUnavailable: false, readingReviews: false });
const keyFor = (context: AutopilotContext | null) => context ? JSON.stringify([context.organizationId,
  context.origin.expectedWorkspaceScope, context.origin.expectedMemberContextNonce, context.readOnly]) : null;
const closedGate = (reply: ScopedReply) => reply.schemaVersion === 1 && reply.status === 'unavailable'
  && reply.code === 'product_gate_closed' && reply.organizationId === null && reply.workspaceScope === null && reply.memberContextNonce === null;
const scoped = (reply: ScopedReply, context: AutopilotContext) => reply.schemaVersion === 1
  && reply.organizationId === context.organizationId && reply.workspaceScope === context.origin.expectedWorkspaceScope
  && reply.memberContextNonce === context.origin.expectedMemberContextNonce;
const problem = (reply: ScopedReply): NonNullable<AutopilotView['error']> => reply.status === 'context_changed' || reply.code === 'context_changed' ? 'context_changed'
  : reply.code === 'forbidden' ? 'permission' : ['conflict','revision_conflict'].includes(reply.code) ? 'conflict'
    : reply.code === 'rate_limited' ? 'rate_limited' : reply.code === 'quota_exhausted' ? 'quota_exhausted' : 'connection';
function consentData(raw: unknown): AutopilotView['consent'] {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as NonNullable<AutopilotView['consent']>;
  if (Object.keys(value).sort().join('|') !== ['schemaVersion','enabled','revision','consentVersion','requiredConsentVersion'].sort().join('|')
    || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.requiredConsentVersion !== 'string' || value.requiredConsentVersion.length < 1 || value.requiredConsentVersion.length > 160
    || value.consentVersion !== null && (typeof value.consentVersion !== 'string' || value.consentVersion.length > 160)) return null;
  return Object.freeze({ ...value });
}

/** One foreground worker per opened workspace, mounted outside the current tab.
 * Native owns the opaque round, durable recovery, subscription and permission
 * checks. The UI never submits a proposal, provider result or retry override. */
export function useAutopilot(context: AutopilotContext | null, onWorkspaceChanged: () => void) {
  const key = keyFor(context);
  const [bound, setBound] = useState<BoundState>(() => ({ key, state: empty(key ? 'checking' : 'disconnected') }));
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const current = useRef({ context, key, state: bound, onWorkspaceChanged });
  current.current = { context, key, state: bound, onWorkspaceChanged };
  const timings = useRef({ key, consentAt: 0, feedAt: 0, reviewCursor: null as string | null, refreshVersion: 0, providerRetryAt: 0 });
  if (timings.current.key !== key) timings.current = { key, consentAt: 0, feedAt: 0, reviewCursor: null, refreshVersion: 0, providerRetryAt: 0 };
  const publish = (guard: AutopilotCycleGuard, next: AutopilotView) => {
    if (!guard.current() || current.current.key !== guard.scope) return;
    // These are bounded, normalized DTOs. Do not re-render the entire workspace
    // on an idle polling cycle or an unchanged canonical-history response.
    if (current.current.state.key === guard.scope && JSON.stringify(current.current.state.state) === JSON.stringify(next)) return;
    const updated = { key: guard.scope, state: next };
    current.current.state = updated;
    setBound(updated);
  };
  const fail = (guard: AutopilotCycleGuard, error: AutopilotView['error'] = 'connection') => publish(guard, { ...empty('error'), error });
  const pauseQuota = (guard: AutopilotCycleGuard, captured: AutopilotContext, reply?: ScopedReply) => {
    if (reply?.code === 'rate_limited') autopilotBudget.rateLimited(captured.organizationId);
    const previous = current.current.state;
    publish(guard, { ...(previous.key === guard.scope && previous.state.status === 'ready' ? previous.state : empty('error')), error: 'rate_limited' });
    return 'rate_limited' as const;
  };
  const [session] = useState(() => createAutopilotSession({
    perform: async guard => {
      const captured = current.current.context;
      if (!captured || current.current.key !== guard.scope || !guard.current()) return 'blocked';
      const freshness = timings.current.refreshVersion;
      const admitted = await desktopApi.getQuoteAutopilotState(captured.origin);
      if (!guard.current()) return 'blocked';
      if (closedGate(admitted)) { publish(guard, empty('unavailable')); return 'blocked'; }
      if (admitted.status !== 'available' || !scoped(admitted, captured)) { fail(guard, problem(admitted)); return 'blocked'; }
      let previous = current.current.state.key === guard.scope ? current.current.state.state : empty('checking');
      let consent = admitted.canManage ? previous.consent : null;
      // Consent management is owner/admin-only. Other admitted members read
      // shared history separately; their native tick checks both saved consents
      // on the server and never activates or simulates an authorization.
      if (admitted.canManage && (!consent || Date.now() - timings.current.consentAt >= 90_000)) {
        if (!autopilotBudget.reserve(captured.organizationId, 'consent')) return pauseQuota(guard, captured);
        const reply = await desktopApi.readQuoteAutopilotConsent(captured.origin);
        if (!guard.current()) return 'blocked';
        if (closedGate(reply)) { publish(guard, empty('unavailable')); return 'blocked'; }
        if (reply.code === 'rate_limited') return pauseQuota(guard, captured, reply);
        consent = reply.status === 'available' && scoped(reply, captured) ? consentData(reply.data) : null;
        if (!consent) { fail(guard, problem(reply)); return 'blocked'; }
        timings.current.consentAt = timings.current.refreshVersion === freshness ? Date.now() : 0;
      }
      let next: AutopilotView = { ...previous, status: 'ready', consent, canManage: admitted.canManage && !captured.readOnly,
        error: null, saving: false };
      let result: AutopilotCycleResult = 'idle', changed = false, reviewChanged = false;
      if (Date.now() < timings.current.providerRetryAt) next = { ...next, error: 'quota_exhausted' };
      if (Date.now() >= timings.current.providerRetryAt && !captured.readOnly && (!admitted.canManage || consent?.enabled && consent.consentVersion === consent.requiredConsentVersion)) {
        const charge = autopilotBudget.reserve(captured.organizationId, 'tick');
        if (!charge) {
          // A full execution budget pauses the producer, not separately
          // authorized activity/review reads from the other collaborators.
          next = { ...next, error: 'rate_limited' }; result = 'blocked';
        } else {
          const tick = await desktopApi.tickQuoteAutopilot(captured.origin).finally(() => charge.finish());
          if (!guard.current()) return 'blocked';
          if (closedGate(tick)) { publish(guard, empty('unavailable')); return 'blocked'; }
          const refused = tick.organizationId === null && tick.workspaceScope === null && tick.memberContextNonce === null;
          if (tick.status === 'error' && (refused || scoped(tick, captured)) && ['forbidden','conflict','revision_conflict','rate_limited','quota_exhausted'].includes(tick.code)) {
            if (tick.code === 'rate_limited') return pauseQuota(guard, captured, tick);
            if (tick.code === 'quota_exhausted') timings.current.providerRetryAt = Date.now() + 900_000;
            next = { ...next, error: problem(tick) }; result = 'blocked';
          } else {
            if (!scoped(tick, captured) || tick.status === 'context_changed') { fail(guard, 'context_changed'); return 'blocked'; }
            if (tick.status === 'error') throw new Error('AUTOPILOT_NATIVE_CYCLE_UNAVAILABLE');
            if (!['idle','progress','needs_review','held','busy'].includes(tick.status)) { fail(guard, problem(tick)); return 'blocked'; }
            charge.settleTick(tick);
            changed = (tick.counts?.confirmed ?? 0) > 0;
            reviewChanged = (tick.counts?.reviewRequired ?? 0) > 0 || tick.status === 'needs_review';
            result = tick.hasMore ? 'more' : ['held','needs_review'].includes(tick.status) ? 'blocked' : 'idle';
            if (changed && guard.current()) current.current.onWorkspaceChanged();
          }
        }
      }
      // Read actual canonical events. Tick counters only signal a refresh and
      // are never converted into activity rows, quotes or financial totals.
      if (!next.activity || !next.reviews || changed || reviewChanged || Date.now() - timings.current.feedAt >= 45_000) {
        if (!autopilotBudget.reserve(captured.organizationId, 'activity')) return pauseQuota(guard, captured);
        const activity = await desktopApi.readQuoteAutopilotActivity(captured.origin, { limit: 50, cursor: null });
        if (!guard.current()) return 'blocked';
        if (closedGate(activity)) { publish(guard, empty('unavailable')); return 'blocked'; }
        if (activity.code === 'rate_limited') return pauseQuota(guard, captured, activity);
        const activityPage = activity.status === 'available' && scoped(activity, captured)
          ? normalizeConfirmedQuoteActivityPage(activity.data, captured.organizationId) : null;
        if (!autopilotBudget.reserve(captured.organizationId, 'review')) return pauseQuota(guard, captured);
        const reviews = await desktopApi.readQuoteAutopilotReview(captured.origin, { limit: 20, cursor: timings.current.reviewCursor });
        if (!guard.current()) return 'blocked';
        if (closedGate(reviews)) { publish(guard, empty('unavailable')); return 'blocked'; }
        if (reviews.code === 'rate_limited') return pauseQuota(guard, captured, reviews);
        const reviewPage = reviews.status === 'available' && scoped(reviews, captured)
          ? normalizeAutopilotReviewPage(reviews.data, captured.organizationId) : null;
        if (!activityPage || !reviewPage) { fail(guard, problem(!activityPage ? activity : reviews)); return 'blocked'; }
        next = { ...next, activity: activityPage, reviews: reviewPage, reviewsUnavailable: false, readingReviews: false };
        // A user refresh made during this request must still cause a newer
        // read. Its cursor and freshness cannot be overwritten by this reply.
        timings.current.feedAt = timings.current.refreshVersion === freshness ? Date.now() : 0;
      }
      publish(guard, next);
      return result;
    },
    onError: (guard, error) => {
      fail(guard);
      recordDiagnostic({ area: 'command', operation: 'autopilot.cycle', phase: 'failure', errorCode: classifyDiagnosticError(error) });
    },
  }));
  useLayoutEffect(() => {
    const resume = () => {
      const connected = navigator.onLine !== false;
      setOnline(connected);
      session.update({ scope: current.current.key, available: current.current.context !== null,
        visible: document.visibilityState !== 'hidden', online: connected });
    };
    resume(); session.start();
    window.addEventListener('online', resume); window.addEventListener('offline', resume); window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => { session.stop(); window.removeEventListener('online', resume); window.removeEventListener('offline', resume);
      window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, [session]);
  useLayoutEffect(() => {
    session.update({ scope: key, available: context !== null, visible: document.visibilityState !== 'hidden', online: navigator.onLine !== false });
  }, [session, key]);

  const onConsent = async (enabled: boolean) => {
    const originalKey = current.current.key, captured = current.current.context;
    const previous = current.current.state.key === originalKey ? current.current.state.state : null;
    if (!originalKey || !captured || !previous?.consent || previous.status !== 'ready' || !previous.canManage) return;
    const change = await session.exclusive(async guard => {
      if (!autopilotBudget.reserve(captured.organizationId, 'consent')) { pauseQuota(guard, captured); return; }
      publish(guard, { ...previous, saving: true, error: null });
      try {
        const reply = await desktopApi.setQuoteAutopilotConsent(captured.origin, { schemaVersion: 1, enabled,
          consentVersion: enabled ? previous.consent!.requiredConsentVersion : null, expectedRevision: previous.consent!.revision });
        if (!guard.current()) return;
        if (reply.code === 'rate_limited') { pauseQuota(guard, captured, reply); return; }
        const consent = reply.status === 'available' && scoped(reply, captured) ? consentData(reply.data) : null;
        if (!consent || consent.enabled !== enabled) {
          timings.current.consentAt = 0;
          publish(guard, { ...empty(closedGate(reply) ? 'unavailable' : 'error'), error: closedGate(reply) ? null : 'save' }); return;
        }
        timings.current.consentAt = Date.now();
        publish(guard, { ...previous, consent, saving: false, error: null });
      } catch (error) {
        if (!guard.current()) return;
        timings.current.consentAt = 0;
        publish(guard, { ...empty('error'), error: 'save' });
        recordDiagnostic({ area: 'command', operation: 'autopilot.consent', phase: 'failure', errorCode: classifyDiagnosticError(error) });
      }
    });
    if (change.status === 'busy' && current.current.key === originalKey && current.current.state.key === originalKey)
      setBound({ key: originalKey, state: { ...current.current.state.state, error: 'busy' } });
  };
  const onNextReviews = async () => {
    const captured = current.current.context, previous = current.current.state;
    const freshness = timings.current.refreshVersion;
    const cursor = previous.key === current.current.key ? previous.state.reviews?.nextCursor : null;
    if (!captured || !cursor) return;
    const read = await session.exclusive(async guard => {
      if (!autopilotBudget.reserve(captured.organizationId, 'review')) { pauseQuota(guard, captured); return; }
      publish(guard, { ...previous.state, readingReviews: true });
      try {
        const reply = await desktopApi.readQuoteAutopilotReview(captured.origin, { limit: 20, cursor });
        if (!guard.current() || timings.current.refreshVersion !== freshness) return;
        if (reply.code === 'rate_limited') { pauseQuota(guard, captured, reply); return; }
        const reviews = reply.status === 'available' && scoped(reply, captured) ? normalizeAutopilotReviewPage(reply.data, captured.organizationId) : null;
        if (!reviews) { publish(guard, { ...previous.state, readingReviews: false, reviewsUnavailable: true }); return; }
        timings.current.reviewCursor = cursor;
        publish(guard, { ...previous.state, readingReviews: false, reviewsUnavailable: false, reviews });
      } catch { if (guard.current() && timings.current.refreshVersion === freshness)
        publish(guard, { ...previous.state, readingReviews: false, reviewsUnavailable: true }); }
    });
    if (read.status === 'busy' && current.current.key === previous.key && current.current.state.key === previous.key)
      setBound({ key: previous.key, state: { ...current.current.state.state, error: 'busy' } });
  };
  const onRefresh = async () => { timings.current.feedAt = 0; timings.current.consentAt = 0; timings.current.providerRetryAt = 0;
    timings.current.reviewCursor = null; timings.current.refreshVersion++; await session.refresh(); };
  const effective = bound.key === key ? bound.state : empty(key ? 'checking' : 'disconnected');
  return { state: !online && key ? { ...effective, status: 'offline' as const, canManage: false } : effective,
    onConsent, onRefresh, onNextReviews };
}
