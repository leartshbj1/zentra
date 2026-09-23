import { accountJsonError, accountNoStoreHeaders, enforceAccountRateLimit } from '@/lib/account';
import { requireAutomationFounder } from '@/lib/automation/access';
import {
  globalFlags,
  decisionApiKey,
  saveDecisionApiKey,
  setGlobalFlags,
} from '@/lib/automation/config';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { database, runtimeValue } from '@/lib/runtime';
import { AccountPublicError } from '@/lib/account-security';
import { SupportError } from '@/lib/support/types';
import { assertStripeCheckoutReady } from '@/lib/stripe-readiness';
import { retryStripeDeliveryCheck } from '@/lib/stripe-delivery-check';
import { PublicError } from '@/lib/stripe';
import { ZENTRA_PLANS } from '@/lib/plans';
import { prepareCompleteCatalog } from '@/lib/complete/catalog-admin';
import { JevDecisionProvider } from '@/lib/automation/provider';
import { buildPolicy } from '@/lib/automation/policies';
import {
  provisionAutomationBilling,
  automationBillingConfig,
  automationStripe,
} from '@/lib/automation/billing';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const user = await requireAutomationFounder(request),
      body = await readJsonObjectWithinLimit(request, 12000);
    if (body.action === 'complete_catalog') {
      await enforceAccountRateLimit(request, 'complete-catalog', user.userId, 5);
      return Response.json(await prepareCompleteCatalog(), { headers: accountNoStoreHeaders() });
    }
    if (body.action === 'billing_delivery') {
      return Response.json(await retryStripeDeliveryCheck(automationStripe()), {
        headers: accountNoStoreHeaders(),
      });
    }
    if (body.action === 'billing_check') {
      const checks = await Promise.all(
        ZENTRA_PLANS.map(async (plan) => {
          try {
            await assertStripeCheckoutReady(plan.id);
            return { plan: plan.name, ready: true, message: 'Prêt' };
          } catch (error) {
            return {
              plan: plan.name,
              ready: false,
              message:
                error instanceof PublicError
                  ? error.message
                  : 'La configuration serveur du paiement doit être vérifiée.',
            };
          }
        }),
      );
      return Response.json({ checks }, { headers: accountNoStoreHeaders() });
    }
    if (body.action === 'test') {
      const policy = buildPolicy(
        'transaction_classification',
        {
          text: 'Achat de matériel : vis, boulons et outils pour un projet.',
          amountCents: 18500,
          currency: 'CHF',
          direction: 'outgoing',
        },
        { suppliers: [], projects: [], expenseCategories: [] },
        'owner',
      );
      const result = await new JevDecisionProvider(
        await decisionApiKey(),
      ).decide(policy.input);
      return Response.json(
        {
          verified: true,
          latencyMs: result.latencyMs,
          category: result.answers.category.choice,
          confidence: result.answers.category.confidence,
        },
        { headers: accountNoStoreHeaders() },
      );
    }
    if (body.action === 'billing')
      return Response.json(await provisionAutomationBilling(user.userId), {
        headers: accountNoStoreHeaders(),
      });
    if (body.action === 'key')
      return Response.json(await saveDecisionApiKey(body.apiKey, user.userId), {
        headers: accountNoStoreHeaders(),
      });
    if (body.action === 'flags') await setGlobalFlags(body.flags, user.userId);
    else if (body.action !== 'state')
      throw new AccountPublicError('Cette action n’est pas disponible.');
    const db = database();
    const key = await db
      .prepare(
        "SELECT updated_at FROM support_platform_secrets WHERE id='typesafe'",
      )
      .first<{ updated_at: number }>();
    const metrics = await db
      .prepare(
        `SELECT COUNT(*) AS volume,SUM(state='failed') AS errors,AVG(CASE WHEN state='completed' THEN confidence END) AS averageConfidence,AVG(CASE WHEN completed_at IS NOT NULL THEN latency_ms END) AS averageLatencyMs,SUM(feedback='accepted') AS accepted,SUM(feedback='modified') AS corrected,SUM(feedback='rejected') AS rejected,SUM(feedback IS NOT NULL) AS reviewed,SUM(input_tokens) AS inputTokens FROM automation_decisions WHERE created_at>=?`,
      )
      .bind(Math.floor(Date.now() / 1000) - 30 * 86400)
      .first();
    return Response.json(
      {
        configured: !!key || !!runtimeValue('TYPESAFE_API_KEY'),
        billingReady: !!(await automationBillingConfig()),
        updatedAt: key?.updated_at ?? null,
        flags: await globalFlags(),
        metrics,
      },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(
      error instanceof SupportError || error instanceof PublicError
        ? new AccountPublicError(error.message, error.status)
        : error,
    );
  }
}
