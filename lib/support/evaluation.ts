import {
  evaluateTicket,
  canAutomaticallyRoute,
  TRIAGE_POLICY_VERSION,
} from './jev';
import {
  CATEGORIES,
  record,
  SupportError,
  type Decision,
  type Rules,
} from './types';

export type EvaluationTicket = { id: string; subject: string; body: string };

export function evaluationTickets(value: unknown): EvaluationTicket[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    throw new SupportError('Envoyez de 1 à 10 tickets fictifs par lot.');
  const ids = new Set<string>();
  return value.map((input) => {
    const row = record(input);
    if (
      typeof row.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) ||
      ids.has(row.id) ||
      typeof row.subject !== 'string' ||
      !row.subject.trim() ||
      row.subject.length > 300 ||
      typeof row.body !== 'string' ||
      !row.body.trim() ||
      row.body.length > 4000 ||
      Object.keys(row).some((key) => !['id', 'subject', 'body'].includes(key))
    )
      throw new SupportError('Un ticket de test est invalide.');
    ids.add(row.id);
    return { id: row.id, subject: row.subject, body: row.body };
  });
}

// Owner-only diagnostic: the same production classifier and routing gate, with
// synthetic destinations. No workspace, ticket, customer quota or connector write.
export async function evaluateTestBatch(
  key: string,
  tickets: EvaluationTicket[],
  evaluator: (ticket: EvaluationTicket, rules: Rules) => Promise<Decision> = (
    ticket,
    rules,
  ) => evaluateTicket(key, ticket.subject, ticket.body, rules, 85),
) {
  if (!key) throw new SupportError('L’analyse n’est pas configurée.', 503);
  const rules = Object.fromEntries(
    Object.keys(CATEGORIES).map((category) => [
      category,
      { teamId: `evaluation-${category}` },
    ]),
  ) as Rules;
  const results = [];
  for (let offset = 0; offset < tickets.length; offset += 3) {
    results.push(
      ...(await Promise.all(
        tickets.slice(offset, offset + 3).map(async (ticket) => {
          const started = performance.now();
          try {
            const decision = await evaluator(ticket, rules);
            return {
              id: ticket.id,
              decision,
              automatic: canAutomaticallyRoute(decision, 85),
              durationMs: Math.round(performance.now() - started),
            };
          } catch {
            // Never serialize provider errors, credentials or raw responses.
            return {
              id: ticket.id,
              automatic: false,
              error: 'analysis_unavailable',
              durationMs: Math.round(performance.now() - started),
            };
          }
        }),
      )),
    );
  }
  return { policyVersion: TRIAGE_POLICY_VERSION, threshold: 85, results };
}
