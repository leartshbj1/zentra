import {
  DecisionFailure,
  record,
  type ChoiceAnswer,
  type DecisionInput,
  type DecisionProvider,
  type ProviderResult,
} from './types';
import { sanitizeState, sanitizeText } from './sanitize';

import { jevRequest, readJevResponse } from './transport';
export { JEV_ENDPOINT } from './transport';
export const JEV_MODEL = 'jev-1.13.0';
const unit = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export function parseProviderResult(
  value: unknown,
  input: DecisionInput,
  latencyMs: number,
): ProviderResult {
  const result = record(value),
    answers = record(result.answers),
    parsed: Record<string, ChoiceAnswer> = {};
  for (const [id, question] of Object.entries(input.questions)) {
    const answer = record(answers[id]),
      probabilities = record(answer.probabilities),
      keys = Object.keys(question.options);
    if (
      answer.type !== 'choice' ||
      typeof answer.choice !== 'string' ||
      !Object.hasOwn(question.options, answer.choice) ||
      !unit(answer.confidence) ||
      Object.keys(probabilities).length !== keys.length ||
      !keys.every((k) => unit(probabilities[k]))
    )
      throw new DecisionFailure('invalid_response');
    const total = keys.reduce((s, k) => s + Number(probabilities[k]), 0);
    if (
      Math.abs(total - 1) > 0.02 ||
      keys.some(
        (k) =>
          Number(probabilities[k]) >
          Number(probabilities[String(answer.choice)]) + 0.001,
      )
    )
      throw new DecisionFailure('invalid_response');
    parsed[id] = {
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: probabilities as Record<string, number>,
    };
  }
  if (Object.keys(answers).length !== Object.keys(input.questions).length)
    throw new DecisionFailure('invalid_response');
  const usage = record(result.usage);
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1e7
      ? v
      : null;
  return {
    answers: parsed,
    provider: 'typesafe',
    model:
      typeof result.model === 'string' &&
      /^[a-z0-9/_.-]{1,100}$/i.test(result.model)
        ? result.model
        : JEV_MODEL,
    latencyMs,
    usage: {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cost:
        typeof usage.cost === 'number' &&
        Number.isFinite(usage.cost) &&
        usage.cost >= 0
          ? usage.cost
          : null,
    },
  };
}
export class JevDecisionProvider implements DecisionProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 6000,
    private readonly sleep = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms)),
  ) {}
  async decide(input: DecisionInput): Promise<ProviderResult> {
    if (!this.apiKey) throw new DecisionFailure('configuration');
    const questions = Object.entries(input.questions);
    if (
      !questions.length ||
      questions.length > 24 ||
      questions.some(
        ([id, q]) =>
          !/^[a-z0-9_]{1,50}$/.test(id) ||
          Object.keys(q.options).length < 2 ||
          Object.keys(q.options).length > 200 ||
          Object.keys(q.options).some((k) => !/^[a-z0-9_]{1,80}$/i.test(k)),
      )
    )
      throw new DecisionFailure('invalid_request');
    const body = JSON.stringify({
      model: JEV_MODEL,
      state: sanitizeState(input.state),
      questions: Object.fromEntries(
        questions.map(([id, q]) => [
          id,
          {
            type: 'choice',
            instructions: q.instructions,
            criteria: Object.fromEntries(
              Object.entries(q.options).map(([k, v]) => [
                k,
                sanitizeText(v, 400),
              ]),
            ),
          },
        ]),
      ),
    });
    if (body.length > 32000) throw new DecisionFailure('invalid_request');
    const started = Date.now();
    try {
      const response = await jevRequest(this.apiKey, body, {
        fetcher: this.fetcher,
        timeoutMs: this.timeoutMs,
        retry: true,
        sleep: this.sleep,
      });
      if (!response.ok) {
        throw new DecisionFailure(
          [401, 403].includes(response.status)
            ? 'authentication'
            : response.status === 429
              ? 'rate_limit'
              : [400, 422].includes(response.status)
                ? 'invalid_request'
                : 'unavailable',
        );
      }
      let text: string;
      try {
        text = await readJevResponse(response);
      } catch (error) {
        if (
          error instanceof Error &&
          ['empty_response', 'oversized_response'].includes(error.message)
        )
          throw new DecisionFailure('invalid_response');
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DecisionFailure('invalid_response');
      }
      return parseProviderResult(parsed, input, Date.now() - started);
    } catch (error) {
      if (error instanceof DecisionFailure) throw error;
      if (
        error instanceof Error &&
        ['TimeoutError', 'AbortError'].includes(error.name)
      )
        throw new DecisionFailure('timeout');
      // Do not retry ambiguous network timeouts: the provider may have processed the call.
      throw new DecisionFailure('network');
    }
  }
}
