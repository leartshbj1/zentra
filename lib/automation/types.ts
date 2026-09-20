export const AUTOMATION_PRODUCT = 'zentra_automation';
export const AUTOMATION_PRICE_CENTS = 1500;
export const POLICY_VERSION = 'automation-2026-09-20-v1';
export const FEATURES = [
  'transaction_classification',
  'document_routing',
  'supplier_routing',
  'agent_routing',
  'anomaly_detection',
  'priority',
  'email_classification',
  'import_mapping',
] as const;
export type Feature = (typeof FEATURES)[number];
export type Mode = 'shadow' | 'suggest';
export type Thresholds = { medium: number; high: number };
export const DEFAULT_THRESHOLDS: Thresholds = { medium: 0.65, high: 0.9 };
export type ChoiceQuestion = {
  instructions: string;
  options: Record<string, string>;
};
export type DecisionInput = {
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
};
export type ChoiceAnswer = {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type ProviderResult = {
  answers: Record<string, ChoiceAnswer>;
  provider: string;
  model: string;
  latencyMs: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
  };
};
export interface DecisionProvider {
  decide(input: DecisionInput): Promise<ProviderResult>;
}
export type FailureCode =
  | 'configuration'
  | 'timeout'
  | 'network'
  | 'authentication'
  | 'rate_limit'
  | 'unavailable'
  | 'invalid_response'
  | 'invalid_request';
export class DecisionFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}
export function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
export function thresholds(input: unknown): Thresholds {
  const v = record(input);
  if (
    typeof v.medium !== 'number' ||
    typeof v.high !== 'number' ||
    !Number.isFinite(v.medium) ||
    !Number.isFinite(v.high) ||
    v.medium < 0.5 ||
    v.medium >= v.high ||
    v.high > 1
  )
    throw new DecisionFailure('invalid_request');
  return { medium: v.medium, high: v.high };
}
export function confidenceBand(confidence: number, limits: Thresholds) {
  return confidence >= limits.high
    ? 'high'
    : confidence >= limits.medium
      ? 'medium'
      : 'low';
}
export function feature(input: unknown): Feature {
  if (
    typeof input !== 'string' ||
    !(FEATURES as readonly string[]).includes(input)
  )
    throw new DecisionFailure('invalid_request');
  return input as Feature;
}
