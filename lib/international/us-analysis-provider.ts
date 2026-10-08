import { JevDecisionProvider, JEV_MODEL } from '../automation/provider';
import { JEV_ENDPOINT } from '../automation/transport';
import { DecisionFailure, type DecisionProvider } from '../automation/types';

/** One dispatch, one HTTP emission, including body-read deadline. This adapter
 * deliberately disables shared CH retry behavior for providers without a
 * documented idempotency contract. It does not acquire rights by itself. */
export function createUsSingleDispatchProvider(input: Readonly<{
  apiKey: string;
  authorize(): Promise<void>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}>): DecisionProvider {
  const timeoutMs = input.timeoutMs ?? 6000;
  if (!input.apiKey || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new DecisionFailure('configuration');
  let decided = false;
  return { async decide(request) {
    if (decided) throw new DecisionFailure('invalid_request');
    decided = true;
    const controller = new AbortController();
    let emitted = false, timer: ReturnType<typeof setTimeout> | undefined;
    const output: {body:ReadableStream<Uint8Array>|null} = {body:null};
    const fetcher: typeof fetch = async (url, options) => {
      if (emitted || String(url) !== JEV_ENDPOINT || options?.method !== 'POST' || options.redirect !== 'manual') throw new DecisionFailure('invalid_request');
      // Admission can await durable dispatch. No external request precedes it.
      await input.authorize();
      if (controller.signal.aborted) throw new DecisionFailure('timeout');
      emitted = true;
      const response = await (input.fetcher ?? fetch)(url, { ...options, signal: AbortSignal.any([controller.signal, options.signal!]) });
      output.body = response.body;
      return response;
    };
    const provider = new JevDecisionProvider(input.apiKey, fetcher, timeoutMs, async () => {}, { retry: false, expectedModel: JEV_MODEL });
    try {
      const result = await Promise.race([
        provider.decide(request),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DecisionFailure('timeout')); }, timeoutMs); }),
      ]);
      if (result.model !== JEV_MODEL) throw new DecisionFailure('invalid_response');
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      // Abort fetch first. Cancelling a locked reader is best effort only.
      try { void output.body?.cancel().catch(() => {}); } catch { /* No content/error escapes. */ }
    }
  } };
}
