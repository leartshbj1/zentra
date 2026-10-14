/** Volatile, conservative client pacing. Server quotas and authority remain
 * decisive. A failed/uncertain tick keeps its entire possible HTTP cost. */
export type AutopilotBudgetKind = 'tick' | 'consent' | 'activity' | 'review';
const HOUR = 3_600_000;
const LIMITS = { work: 400, execution: 400, consent: 50, activity: 100, review: 100 } as const;
type Usage = { work: number; execution: number; consent: number; activity: number; review: number };
type Charge = { at: number; pending: boolean; usage: Usage };
type CompanyBudget = { charges: Charge[]; blockedUntil: number };
type TickUsage = { status: string; phase: string; counts: { confirmed: number; held: number; reviewRequired: number } | null };
const zero = (): Usage => ({ work: 0, execution: 0, consent: 0, activity: 0, review: 0 });

export function createAutopilotBudget(clock = () => Date.now()) {
  const companies = new Map<string, CompanyBudget>();
  function company(organizationId: string, now: number) {
    if (!organizationId || organizationId.length > 160 || !Number.isSafeInteger(now) || now < 0) return null;
    let saved = companies.get(organizationId);
    if (!saved) {
      // Do not evict a live company's quota on account/workspace transitions.
      if (companies.size >= 128) return null;
      saved = { charges: [], blockedUntil: 0 }; companies.set(organizationId, saved);
    }
    saved.charges = saved.charges.filter(charge => charge.pending || charge.at > now - HOUR);
    return saved;
  }
  return {
    reserve(organizationId: string, kind: AutopilotBudgetKind) {
      const now = clock(), saved = company(organizationId, now);
      if (!saved || now < saved.blockedUntil) return null;
      const usage = zero();
      // Native advance is one discovery + up to 20 preparations and up to
      // 20 reserve/confirm pairs. Recovery may also run 20 execution pairs.
      if (kind === 'tick') { usage.work = 21; usage.execution = 40; }
      else usage[kind] = 1;
      const used = saved.charges.reduce((total, charge) => {
        for (const key of Object.keys(LIMITS) as (keyof Usage)[]) total[key] += charge.usage[key];
        return total;
      }, zero());
      if ((Object.keys(LIMITS) as (keyof Usage)[]).some(key => used[key] + usage[key] > LIMITS[key])) return null;
      const charge = { at: now, pending: kind === 'tick', usage };
      saved.charges.push(charge);
      let settled = false, finished = false;
      const finish = () => {
        if (finished) return;
        finished = true; charge.pending = false; charge.at = clock();
      };
      return {
        // Count a long/failed tick through its completion, not just its start.
        // A pending native operation cannot expire while it still sends HTTP.
        finish,
        settleTick(reply: TickUsage) {
          if (kind !== 'tick' || settled) return;
          settled = true;
          finish();
          if (!['idle', 'progress', 'needs_review', 'held'].includes(reply.status) || !reply.counts) return;
          const { confirmed, held, reviewRequired } = reply.counts;
          if (![confirmed, held, reviewRequired].every(value => Number.isSafeInteger(value) && value >= 0)
            || confirmed + held + reviewRequired > 20) return;
          if (reply.phase === 'page') {
            usage.work = 1 + confirmed + held + reviewRequired;
            usage.execution = 2 * (confirmed + held);
          } else if (reply.phase === 'recovery') {
            // Recovery counts omit held selections; retain all 40 execution
            // requests rather than treating confirmed as the whole batch.
            usage.work = 0;
          }
        },
      };
    },
    rateLimited(organizationId: string) {
      const now = clock(), saved = company(organizationId, now);
      // The server's counters use a UTC hour. Do not hammer a consumed quota
      // after refresh/focus/reconnect; allow five seconds for clock boundaries.
      if (saved) saved.blockedUntil = Math.max(saved.blockedUntil, Math.floor(now / HOUR) * HOUR + HOUR + 5_000);
    },
  };
}

// One foreground application instance shares pacing across hook remounts and
// member nonce changes. No session, token, document or business data is stored.
export const autopilotBudget = createAutopilotBudget();
