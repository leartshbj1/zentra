import { database } from '@/lib/runtime';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { automationActor, type AutomationActor } from './access';
import { decisionApiKey, globalFlags, settingsFor } from './config';
import { buildPolicy, safeWorkflow } from './policies';
import { authorizedResources, nativeResources } from './resources';
import { JevDecisionProvider } from './provider';
import { automationEntitlement, requireAutomationEntitlement } from './entitlement';
export { automationEntitlement } from './entitlement';
import { automationFetch, requireAutomationExecution } from './execution';
import {
  POLICY_VERSION,
  DecisionFailure,
  confidenceBand,
  feature,
  record,
  type DecisionProvider,
} from './types';

type AuditRow = {
  id: string;
  user_id: string;
  context_hash: string;
  state: string;
  result: string | null;
  mode: string;
  error_code: string | null;
  options: string;
  feedback: string | null;
  final_choices?: string | null;
  created_at: number;
};
export function publicDecision(row: AuditRow) {
  if (row.state === 'processing')
    return {
      id: row.id,
      status: 'pending',
      message: 'Analyse en cours. Vous pouvez continuer.',
    };
  if (row.state === 'failed')
    return {
      id: row.id,
      status: 'manual',
      message:
        'La suggestion est indisponible. Vous pouvez continuer et choisir vous-même.',
    };
  if (row.mode === 'shadow' && !row.feedback)
    return {
      id: row.id,
      status: 'shadow',
      message: 'Observation enregistrée. Votre choix reste inchangé.',
    };
  const result = record(JSON.parse(row.result || '{}'));
  delete result.observedChoices;
  return {
    id: row.id,
    ...result,
    ...(row.feedback
      ? {
          feedback: row.feedback,
          finalChoices: record(JSON.parse(row.final_choices || '{}')),
        }
      : {}),
  };
}
export async function decideForActor(
  actor: AutomationActor,
  raw: Record<string, unknown>,
  injected?: DecisionProvider,
) {
  actor = await requireAutomationEntitlement(actor);
  const kind = feature(raw.feature);
  if (
    typeof raw.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{16,100}$/.test(raw.requestId)
  )
    throw new AccountPublicError('Relancez la suggestion depuis Zentra.');
  const [settings, flags, active] = await Promise.all([
    settingsFor(actor.organizationId),
    globalFlags(),
    automationEntitlement(actor),
  ]);
  if (!active)
    throw new AccountPublicError(
      'Activez l’option Zentra Automation dans votre compte.',
      402,
    );
  if (
    !settings.enabled ||
    !settings.consent ||
    !settings.flags.includes(kind) ||
    !flags.includes(kind)
  )
    return {
      status: 'disabled',
      message:
        'Cette suggestion n’est pas activée. Le traitement manuel reste disponible.',
    };
  const resources =
    kind === 'supplier_routing'
      ? actor.device
        ? nativeResources(raw.nativeResources, actor.organizationId)
        : await authorizedResources(actor.organizationId)
      : { suppliers: [], projects: [], expenseCategories: [] };
  const policy = buildPolicy(kind, raw.context, resources, actor.role);
  const fingerprint = await sha256Hex(
    JSON.stringify({
      organization: actor.organizationId,
      kind,
      input: policy.input,
      mappings: policy.mappings,
      role: actor.role,
      mode: settings.mode,
      thresholds: settings.thresholds,
      version: POLICY_VERSION,
    }),
  );
  const db = database(),
    now = Math.floor(Date.now() / 1000),
    id = crypto.randomUUID();
  const previous = await db
    .prepare(
      'SELECT * FROM automation_decisions WHERE organization_id=? AND user_id=? AND request_id=?',
    )
    .bind(actor.organizationId, actor.userId, raw.requestId)
    .first<AuditRow>();
  if (previous) {
    if (previous.context_hash !== fingerprint)
      throw new AccountPublicError(
        'Les données ont changé. Relancez une nouvelle suggestion.',
        409,
      );
    if (previous.state === 'processing' && previous.created_at < now - 120) {
      await db
        .prepare(
          "UPDATE automation_decisions SET state='failed',error_code='timeout',completed_at=? WHERE id=? AND state='processing'",
        )
        .bind(now, previous.id)
        .run();
      return publicDecision({ ...previous, state: 'failed' });
    }
    return publicDecision(previous);
  }
  const options = JSON.stringify({
    keys: Object.fromEntries(
      Object.entries(policy.input.questions).map(([k, v]) => [
        k,
        Object.keys(v.options),
      ]),
    ),
    mappings: policy.mappings,
  });
  const reserved = await db
    .prepare(`INSERT INTO automation_decisions(id,organization_id,user_id,request_id,feature,mode,context_hash,options,policy_version,state,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,'processing',? WHERE (SELECT COUNT(*) FROM automation_decisions WHERE organization_id=? AND created_at>=?)<60
    ON CONFLICT(organization_id,user_id,request_id) DO NOTHING`)
    .bind(
      id,
      actor.organizationId,
      actor.userId,
      raw.requestId,
      kind,
      settings.mode,
      fingerprint,
      options,
      POLICY_VERSION,
      now,
      actor.organizationId,
      now - 60,
    )
    .run();
  if (!reserved.meta.changes)
    throw new AccountPublicError(
      'Plusieurs analyses sont en cours. Patientez quelques instants ; le traitement manuel reste disponible.',
      429,
    );
  const started = Date.now();
  try {
    const provider =
      injected ?? new JevDecisionProvider(await decisionApiKey(), automationFetch(actor,kind));
    await requireAutomationExecution(actor,kind);
    const result = await provider.decide(policy.input);
    await requireAutomationExecution(actor,kind);
    const confidence = Math.min(
      ...Object.values(result.answers).map((v) => v.confidence),
    );
    const band = confidenceBand(confidence, settings.thresholds),
      manual = band === 'low';
    const choices: Record<string, string> = Object.fromEntries(
      Object.entries(result.answers).map(([k, v]) => [k, v.choice]),
    );
    const observedChoices = { ...choices };
    // Provider selection never overrides deterministic overdue priority.
    if (policy.minimumPriority && ['normal', 'low'].includes(choices.priority))
      choices.priority = policy.minimumPriority;
    const proposed = {
      status: manual ? 'manual' : 'suggestion',
      confidence,
      band,
      choices: manual ? {} : choices,
      workflow: manual ? null : safeWorkflow(kind, result.answers),
      resourceIds: manual
        ? {}
        : Object.fromEntries(
            Object.entries(policy.mappings).map(([k, mapping]) => [
              k,
              mapping[choices[k]] ?? null,
            ]),
          ),
      requiresConfirmation: true,
      message: manual
        ? 'Choisissez vous-même : les informations ne permettent pas une suggestion fiable.'
        : 'Suggestion Zentra — vérifiez puis confirmez.',
    };
    await db
      .prepare(
        "UPDATE automation_decisions SET state='completed',result=?,confidence=?,provider=?,model=?,latency_ms=?,input_tokens=?,output_tokens=?,cost=?,completed_at=? WHERE id=? AND state='processing'",
      )
      .bind(
        JSON.stringify({ ...proposed, observedChoices }),
        confidence,
        result.provider,
        result.model,
        result.latencyMs,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.cost,
        Math.floor(Date.now() / 1000),
        id,
      )
      .run();
    return settings.mode === 'shadow'
      ? {
          id,
          status: 'shadow',
          message: 'Observation enregistrée. Votre choix reste inchangé.',
        }
      : { id, ...proposed };
  } catch (error) {
    const code = error instanceof DecisionFailure ? error.code : 'unavailable';
    await db
      .prepare(
        "UPDATE automation_decisions SET state='failed',error_code=?,latency_ms=?,completed_at=? WHERE id=? AND state='processing'",
      )
      .bind(code, Date.now() - started, Math.floor(Date.now() / 1000), id)
      .run();
    return {
      id,
      status: 'manual',
      message:
        'La suggestion est indisponible. Vous pouvez continuer et choisir vous-même.',
    };
  }
}
export async function requestDecision(
  request: Request,
  body: Record<string, unknown>,
) {
  return decideForActor(
    await automationActor(request, body.organizationId),
    body,
  );
}

export async function recordFeedback(
  actor: AutomationActor,
  body: Record<string, unknown>,
) {
  actor = await requireAutomationEntitlement(actor);
  if (actor.role === 'read_only')
    throw new AccountPublicError(
      'Votre rôle permet la consultation uniquement.',
      403,
    );
  const db = database(),
    row = await db
      .prepare(
        'SELECT * FROM automation_decisions WHERE id=? AND organization_id=?',
      )
      .bind(String(body.id), actor.organizationId)
      .first<AuditRow>();
  if (!row || row.user_id !== actor.userId)
    throw new AccountPublicError(
      'Cette suggestion ne vous appartient pas.',
      404,
    );
  if (row.state !== 'completed')
    throw new AccountPublicError('Aucune suggestion terminée à évaluer.', 409);
  if (!['accepted', 'modified', 'rejected'].includes(String(body.feedback)))
    throw new AccountPublicError('Choisissez Accepter, Modifier ou Refuser.');
  const options = JSON.parse(row.options) as {
    keys: Record<string, string[]>;
    mappings: Record<string, Record<string, string>>;
  };
  const choices = record(body.choices),
    saved = record(JSON.parse(row.result || '{}')),
    observed = record(saved.observedChoices);
  if (
    Object.keys(options.mappings).length &&
    body.resourceIds &&
    body.feedback !== 'rejected'
  ) {
    const finalIds = record(body.resourceIds);
    for (const [key, mapping] of Object.entries(options.mappings)) {
      const id = finalIds[key];
      const selected =
        id === null || id === ''
          ? 'none'
          : Object.entries(mapping).find(([, value]) => value === id)?.[0];
      if (!selected)
        throw new AccountPublicError(
          'Cette ressource ne faisait pas partie des choix proposés.',
        );
      choices[key] = selected;
    }
  }
  if (
    body.feedback !== 'rejected' &&
    (Object.keys(choices).length !== Object.keys(options.keys).length ||
      Object.entries(options.keys).some(
        ([key, allowed]) =>
          typeof choices[key] !== 'string' ||
          !allowed.includes(choices[key] as string),
      ))
  )
    throw new AccountPublicError(
      'Choisissez uniquement les options proposées.',
    );
  if (Object.keys(options.mappings).length && body.feedback !== 'rejected') {
    const resources = actor.device
      ? nativeResources(body.nativeResources, actor.organizationId)
      : await authorizedResources(actor.organizationId);
    const allowed = new Set(
      [
        ...resources.projects,
        ...resources.suppliers,
        ...resources.expenseCategories,
      ].map((v) => v.id),
    );
    if (
      Object.entries(options.mappings).some(
        ([key, map]) =>
          choices[key] !== 'none' && !allowed.has(map[String(choices[key])]),
      )
    )
      throw new AccountPublicError(
        'Les données de l’entreprise ont changé. Relancez la suggestion.',
        409,
      );
  }
  // Compute agreement server-side; callers cannot inflate acceptance metrics.
  const feedback =
    body.feedback === 'rejected'
      ? 'rejected'
      : Object.entries(observed).every(([k, v]) => choices[k] === v)
        ? 'accepted'
        : 'modified';
  const finalChoices = JSON.stringify(
    body.feedback === 'rejected' ? {} : choices,
  );
  const update = await db
    .prepare(
      'UPDATE automation_decisions SET feedback=?,final_choices=?,reviewed_by=?,reviewed_at=? WHERE id=? AND organization_id=? AND feedback IS NULL',
    )
    .bind(
      feedback,
      finalChoices,
      actor.userId,
      Math.floor(Date.now() / 1000),
      row.id,
      actor.organizationId,
    )
    .run();
  if (!update.meta.changes)
    throw new AccountPublicError('Cette suggestion a déjà été évaluée.', 409);
  return { recorded: true, feedback };
}
