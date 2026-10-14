import type { ConfirmedQuoteActivityPage } from './confirmedQuoteActivity';
import type { AutopilotReviewPage } from './autopilotReview';

/** Presentation state only; this does not grant native or server permission. */
export type AutopilotView = Readonly<{
  status: 'checking' | 'ready' | 'unavailable' | 'offline' | 'disconnected' | 'error';
  consent: Readonly<{ schemaVersion: 1; enabled: boolean; revision: number; consentVersion: string | null; requiredConsentVersion: string }> | null;
  canManage: boolean;
  saving: boolean;
  error: 'connection' | 'save' | 'context_changed' | 'busy' | 'permission' | 'conflict' | 'rate_limited' | 'quota_exhausted' | null;
  activity: ConfirmedQuoteActivityPage | null;
  reviews: AutopilotReviewPage | null;
  reviewsUnavailable: boolean;
  readingReviews: boolean;
}>;
