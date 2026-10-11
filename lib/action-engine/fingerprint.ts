import type { QuotePlan } from './types';
import { captureQuotePlan } from './validation';

/** Canonical capture detaches caller-owned fields before the digest's await. */
export async function quotePlanFingerprint(raw: QuotePlan): Promise<string> {
  const plan = captureQuotePlan(raw);
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
