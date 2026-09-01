import {
  jsonError,
  noStoreHeaders,
  persistStripeEvent,
  PublicError,
  verifyStripeEvent,
} from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const signature = request.headers.get('Stripe-Signature');
    if (!signature) throw new PublicError('Signature Stripe absente.', 400);
    const rawBody = await request.text();
    const event = await verifyStripeEvent(rawBody, signature);
    await persistStripeEvent(event);
    return Response.json({ received: true }, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
