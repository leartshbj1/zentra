import {
  jsonError,
  noStoreHeaders,
  persistStripeEvent,
  PublicError,
  recordVerifiedStripeWebhook,
  verifyStripeEvent,
} from '@/lib/stripe';
import { readTextBodyWithinLimit } from '@/lib/request-body';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const signature = request.headers.get('Stripe-Signature');
    if (!signature) throw new PublicError('Signature Stripe absente.', 400);
    const rawBody = await readTextBodyWithinLimit(request, 1_048_576);
    const event = await verifyStripeEvent(rawBody, signature);
    await recordVerifiedStripeWebhook(event);
    await persistStripeEvent(event);
    return Response.json({ received: true }, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
