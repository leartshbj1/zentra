import { JevDecisionProvider, JEV_MODEL } from '@/lib/automation/provider';
import {
  DecisionFailure,
  type DecisionInput,
  type DecisionProvider,
} from '@/lib/automation/types';

/**
 * Private server factory, one decision per durable intake attempt. The caller
 * must commit intake.start BEFORE decide and keep ambiguous attempts held.
 * No retries, key fallback, model fallback or caller-selected endpoint.
 */
export function createQuoteDecisionProvider(
  apiKey: string,
  requireCurrentAuthorization: () => Promise<void>,
  options: Readonly<{ fetcher?: typeof fetch; timeoutMs?: number }> = {},
): DecisionProvider {
  const authorize = requireCurrentAuthorization,
    fetcher = options.fetcher ?? fetch,
    timeoutMs = options.timeoutMs ?? 6000;
  if (
    typeof apiKey !== 'string' ||
    !apiKey ||
    apiKey.length > 4096 ||
    /\s/.test(apiKey) ||
    typeof authorize !== 'function' ||
    typeof fetcher !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 6000
  )
    throw new DecisionFailure('configuration');
  return Object.freeze({
    async decide(input: DecisionInput) {
      // Per decision, even an accidental shared-transport retry cannot issue a
      // second HTTP request. The durable store guards separate worker calls.
      let attempted = false;
      const guardedFetch: typeof fetch = async (...args) => {
        if (attempted) throw new DecisionFailure('unavailable');
        attempted = true;
        const signal = args[1]?.signal ?? AbortSignal.timeout(timeoutMs);
        signal.throwIfAborted();
        // The transport's signal also bounds admission. A stalled database
        // authorization must not keep this started attempt pending forever,
        // nor send HTTP when that authorization eventually resolves late.
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(signal.reason);
          signal.addEventListener('abort', aborted, { once: true });
          Promise.resolve()
            .then(authorize)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', aborted));
        });
        signal.throwIfAborted();
        return fetcher(...args);
      };
      return new JevDecisionProvider(
        apiKey,
        guardedFetch,
        timeoutMs,
        async () => undefined,
        { retry: false, expectedModel: JEV_MODEL },
      ).decide(input);
    },
  });
}
