import { usSupportMailboxEnabled, usSupportMailboxMember } from './us-support-mailbox-bindings';
import { d1UsMailboxStore } from './us-support-mailbox-d1';
import { d1UsSupportTriageStore } from './us-support-triage-d1';
import { parseUsSupportTriagePolicy } from './us-support-triage-policy';
import { createUsSupportTriageMessageReader, createUsSupportTriageClassifier } from './us-support-triage-provider';
import { UsSupportTriageError } from './us-support-triage-contract';
import { createUsSupportTriageHandlers } from './us-support-triage-server';

export async function usSupportTriageEnabled(): Promise<boolean> {
  try {
    if (!await usSupportMailboxEnabled()) return false;
    const {env} = await import('cloudflare:workers');
    return (env as unknown as Record<string,string|undefined>).INTERNATIONAL_US_SUPPORT_TRIAGE_ENABLED === 'true' && await usSupportMailboxEnabled();
  } catch { return false; }
}
export const usSupportTriageHandlers = createUsSupportTriageHandlers({
  enabled:usSupportTriageEnabled,now:() => Math.floor(Date.now()/1000),member:usSupportMailboxMember,
  async store() { return d1UsSupportTriageStore((await import('../runtime')).database()); },
  async mailboxStore() { return d1UsMailboxStore((await import('../runtime')).database()); },
  async policy() {
    const {env} = await import('cloudflare:workers');
    return parseUsSupportTriagePolicy((env as unknown as Record<string,string|undefined>).INTERNATIONAL_US_SUPPORT_TRIAGE_POLICY_JSON);
  },
  async encryptionKey() { return (await import('../runtime')).runtimeValue('SUPPORT_ENCRYPTION_KEY'); },
  async providerReady() { return Boolean(await (await import('../automation/config')).decisionApiKey()); },
  message:createUsSupportTriageMessageReader(),
  async classify(message,grant,check) {
    await check(); const key = await (await import('../automation/config')).decisionApiKey(); await check();
    if (!key) throw new UsSupportTriageError('triage_provider_unavailable',503);
    return createUsSupportTriageClassifier(key)(message,grant,check);
  },
  async rateLimit(request,operation,key) { await (await import('../account')).enforceAccountRateLimit(request,'international-us-support-triage-'+operation,key,operation === 'read' ? 600 : 30); },
  diagnostic(event) { console.warn('zentra.international.us-support-triage',event); },
});
