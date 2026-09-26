import { database } from '@/lib/runtime';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { extractInvoice } from '@/lib/supplier-inbox/extraction';
import type { AutomationActor } from './access';
import { requireAutomationExecution, automationFetch } from './execution';
import { decisionApiKey } from './config';
import { JevDecisionProvider } from './provider';
import type { DecisionProvider, ProviderResult } from './types';

const policy = 'invoice-scan-2026-09-26-v1';
/** A scan prepares facts, never a posting, payment or claim to input-tax recovery. */
export async function scanInvoice(actor: AutomationActor, raw: Record<string, unknown>, injected?: DecisionProvider) {
  if (!['owner', 'admin', 'accountant', 'member'].includes(actor.role))
    throw new AccountPublicError('Votre rôle permet la consultation uniquement.', 403);
  const { settings } = await requireAutomationExecution(actor, 'supplier_routing');
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text.length < 40 || text.length > 40000 || new TextEncoder().encode(text).length > 80000)
    throw new AccountPublicError('Choisissez une facture lisible de 12 pages maximum.');
  if (typeof raw.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(raw.requestId))
    throw new AccountPublicError('Relancez la lecture de la facture.');
  const db = database();
  const company = await db.prepare('SELECT name FROM organizations WHERE organization_id=?').bind(actor.organizationId).first<{name: string}>();
  if (!company) throw new AccountPublicError('Cette entreprise n’est plus disponible.', 403);
  const fingerprint = await sha256Hex(JSON.stringify([policy, actor.organizationId, actor.role, settings.mode, company.name, text]));
  const now = Math.floor(Date.now() / 1000);
  const prior = await db.prepare('SELECT id,context_hash,state,result,created_at FROM automation_decisions WHERE organization_id=? AND user_id=? AND request_id=?')
    .bind(actor.organizationId, actor.userId, raw.requestId).first<{id:string;context_hash:string;state:string;result:string|null;created_at:number}>();
  if (prior) {
    if (prior.context_hash !== fingerprint) throw new AccountPublicError('Le document a changé. Lancez une nouvelle lecture.', 409);
    if (prior.state === 'completed') return { id: prior.id, ...JSON.parse(prior.result || '{}') };
    throw new AccountPublicError(prior.state === 'processing' && prior.created_at > now - 120 ? 'Lecture en cours. Patientez quelques instants.' : 'La lecture a échoué. Vous pouvez la relancer ou saisir la facture.', 409);
  }
  const id = crypto.randomUUID();
  const reserved = await db.prepare(`INSERT INTO automation_decisions(id,organization_id,user_id,request_id,feature,mode,context_hash,options,policy_version,state,created_at)
    SELECT ?,?,?,?,'supplier_routing',?,?,'{}',?,'processing',? WHERE (SELECT COUNT(*) FROM automation_decisions WHERE organization_id=? AND created_at>=?)<60
    ON CONFLICT(organization_id,user_id,request_id) DO NOTHING`)
    .bind(id, actor.organizationId, actor.userId, raw.requestId, settings.mode, fingerprint, policy, now, actor.organizationId, now - 60).run();
  if (!reserved.meta.changes) throw new AccountPublicError('Plusieurs lectures sont en cours. Réessayez dans une minute.', 429);
  try {
    const provider = injected ?? new JevDecisionProvider(await decisionApiKey(), automationFetch(actor, 'supplier_routing'));
    let proof: ProviderResult | undefined;
    const extraction = await extractInvoice(text, company.name, { decide: async input => {
      await requireAutomationExecution(actor, 'supplier_routing');
      proof = await provider.decide(input);
      return proof;
    } });
    await requireAutomationExecution(actor, 'supplier_routing');
    const result = settings.mode === 'shadow'
      ? { status: 'shadow', requiresConfirmation: true, message: 'Automation est en mode observation. Activez les suggestions dans ses réglages pour préparer vos factures.' }
      : { status: 'suggestion', requiresConfirmation: true, extraction, message: 'Comparez les informations avec l’original avant de les utiliser.' };
    await db.prepare("UPDATE automation_decisions SET state='completed',result=?,confidence=?,provider=?,model=?,latency_ms=?,input_tokens=?,output_tokens=?,cost=?,completed_at=? WHERE id=? AND state='processing'")
      .bind(JSON.stringify(result), extraction.confidence, proof?.provider ?? null, proof?.model ?? null, proof?.latencyMs ?? 0, proof?.usage.inputTokens ?? null, proof?.usage.outputTokens ?? null, proof?.usage.cost ?? null, Math.floor(Date.now()/1000), id).run();
    return { id, ...result };
  } catch (error) {
    await db.prepare("UPDATE automation_decisions SET state='failed',error_code='scan_unavailable',completed_at=? WHERE id=? AND state='processing'").bind(Math.floor(Date.now()/1000), id).run();
    if (error instanceof AccountPublicError) throw error;
    throw new AccountPublicError('La lecture n’a pas abouti. Réessayez ou remplissez la facture manuellement.', 503);
  }
}
