import { usSupportMailboxMember } from './us-support-mailbox-bindings';
import { usSupportTriageEnabled } from './us-support-triage-bindings';
import { usSupportTicketsEnabled, recordUsSupportTicketCompletion } from './us-support-ticket-bindings';
import { d1UsSupportWorkerStore } from './us-support-worker-d1';
import { readUsSupportExecutionMailbox } from './us-support-execution-d1';
import { parseUsSaasPolicy } from './saas-authority-d1';
import { parseUsSupportTriagePolicy, createUsSupportTriageGrant } from './us-support-triage-policy';
import { d1UsSupportTriageStore } from './us-support-triage-d1';
import { createUsSupportTriageMessageReader, createUsSupportTriageClassifier } from './us-support-triage-provider';
import { createUsSupportTriageService } from './us-support-triage-service';
import { UsSupportTriageError } from './us-support-triage-contract';
import { createUsSupportIntakeProvider } from './us-support-intake-provider';
import { createUsSupportWorkerHandlers } from './us-support-worker-server';
import { createUsSupportWorker } from './us-support-worker';
import { assertDeploymentRuntime, deploymentBindingReader } from '../deployment-contract';

const now = () => Math.floor(Date.now() / 1000);
async function flags(): Promise<Record<string, string | undefined>> { return (await import('cloudflare:workers')).env as unknown as Record<string, string | undefined>; }
export async function usSupportWorkerEnabled(): Promise<boolean> {
  try { return (await flags()).INTERNATIONAL_US_SUPPORT_WORKER_ENABLED === 'true' && await usSupportTriageEnabled() && await usSupportTicketsEnabled() && (await flags()).INTERNATIONAL_US_SUPPORT_WORKER_ENABLED === 'true'; }
  catch { return false; }
}
async function store() {
  return d1UsSupportWorkerStore((await import('../runtime')).database(), { now, policy: async () => parseUsSaasPolicy(await flags(), now()), triagePolicy: async () => parseUsSupportTriagePolicy((await flags()).INTERNATIONAL_US_SUPPORT_TRIAGE_POLICY_JSON) });
}
export const usSupportWorkerHandlers = createUsSupportWorkerHandlers({
  enabled: usSupportWorkerEnabled, now, member: usSupportMailboxMember, store,
  async rateLimit(request, operation, key) { await (await import('../account')).enforceAccountRateLimit(request, 'international-us-support-worker-' + operation, key, operation === 'read' ? 600 : 30); },
  diagnostic(event) { console.warn('zentra.international.us-support-worker', event); },
});
const intake = createUsSupportIntakeProvider();
const service = createUsSupportTriageService({
  now,
  async store() { return d1UsSupportTriageStore((await import('../runtime')).database()); },
  async mailbox(context) { return readUsSupportExecutionMailbox((await import('../runtime')).database(), context); },
  async policy() { return parseUsSupportTriagePolicy((await flags()).INTERNATIONAL_US_SUPPORT_TRIAGE_POLICY_JSON); },
  async providerReady() { return Boolean(await (await import('../automation/config')).decisionApiKey()); },
  async encryptionKey() { return (await import('../runtime')).runtimeValue('SUPPORT_ENCRYPTION_KEY'); },
  message: createUsSupportTriageMessageReader(),
  async classify(message, grant, check) {
    await check(); const key = await (await import('../automation/config')).decisionApiKey(); await check();
    if (!key) throw new UsSupportTriageError('triage_provider_unavailable', 503);
    return createUsSupportTriageClassifier(key)(message, grant, check);
  },
  recordTicket: recordUsSupportTicketCompletion,
});
const worker = createUsSupportWorker({
  enabled: usSupportWorkerEnabled, now, store,
  async mailbox(context) { return readUsSupportExecutionMailbox((await import('../runtime')).database(), context); },
  async encryptionKey() { return (await import('../runtime')).runtimeValue('SUPPORT_ENCRYPTION_KEY'); },
  discover: (connection, token, scan, check) => intake.discover(connection, token, scan, check),
  resolveVersion: (connection, token, uid, check) => intake.resolveVersion(connection, token, uid, check),
  triage: (context, request, check) => service.triage(context, request, check),
  async processingPolicyVersion(context) { return createUsSupportTriageGrant(context, parseUsSupportTriagePolicy((await flags()).INTERNATIONAL_US_SUPPORT_TRIAGE_POLICY_JSON)).processingPolicyVersion; },
  diagnostic(event) { console.warn('zentra.international.us-support-intake', event); },
});
export const US_SUPPORT_WORKER_CRON = '* * * * *';
/** A deployed cron is deliberately NOT configured by this patch. This handler
 * activates only after the migration, exact gates and schedule are approved. */
export async function runUsSupportScheduled(controller: Pick<ScheduledController, 'cron'>, bindings: unknown) {
  assertDeploymentRuntime(deploymentBindingReader(bindings));
  if (controller.cron !== US_SUPPORT_WORKER_CRON || !await usSupportWorkerEnabled()) return { acquired: 0, ticketed: 0, outcomes: [] };
  return worker.tick();
}
