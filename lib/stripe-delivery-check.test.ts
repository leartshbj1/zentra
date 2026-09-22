import { beforeEach, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
vi.mock('@/lib/runtime', () => ({
  runtimeValue: (key: string) =>
    ({
      STRIPE_SECRET_KEY: 'sk_live_fixture',
      STRIPE_WEBHOOK_ENDPOINT_ID: 'we_fixture',
      PUBLIC_SITE_URL: 'https://zentraapp.ch',
    })[key] || '',
}));
import { retryStripeDeliveryCheck } from './stripe-delivery-check';
import { STRIPE_API_VERSION } from './stripe';
const retrieve = vi.fn(),
  list = vi.fn(),
  rawRequest = vi.fn();
const client = {
  webhookEndpoints: { retrieve },
  events: { list },
  rawRequest,
} as unknown as Stripe;
const hook = () => ({
  id: 'we_fixture',
  status: 'enabled',
  livemode: true,
  api_version: STRIPE_API_VERSION,
  url: 'https://zentraapp.ch/api/stripe/webhook',
  enabled_events: ['customer.created'],
});
const event = () => ({
  id: 'evt_fixture1',
  type: 'customer.created',
  livemode: true,
  api_version: STRIPE_API_VERSION,
  created: Math.floor(Date.now() / 1000),
});
beforeEach(() => {
  vi.clearAllMocks();
  retrieve.mockResolvedValue(hook());
  list.mockResolvedValue({ data: [event()] });
  rawRequest.mockResolvedValue({});
});
it('asks Stripe for a genuine delivery without changing any customer or subscription', async () => {
  await expect(retryStripeDeliveryCheck(client)).resolves.toEqual({
    requested: true,
  });
  expect(list).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'customer.created' }),
  );
  expect(rawRequest).toHaveBeenCalledExactlyOnceWith(
    'POST',
    '/v1/events/evt_fixture1/retry',
    { webhook_endpoint: 'we_fixture' },
  );
});
it.each([
  { livemode: false },
  { status: 'disabled' },
  { api_version: 'old' },
  { url: 'https://other.example/hook' },
  { id: 'we_other' },
  { enabled_events: ['invoice.paid'] },
])('refuses a mismatched endpoint %j', async (patch) => {
  retrieve.mockResolvedValue({ ...hook(), ...patch });
  await expect(retryStripeDeliveryCheck(client)).rejects.toMatchObject({
    status: 503,
  });
  expect(list).not.toHaveBeenCalled();
  expect(rawRequest).not.toHaveBeenCalled();
});
it.each([
  { livemode: false },
  { type: 'invoice.paid' },
  { api_version: 'old' },
  { id: 'evt_bad/path' },
  { created: 1 },
])('never resends an incompatible or financial event %j', async (patch) => {
  list.mockResolvedValue({ data: [{ ...event(), ...patch }] });
  await expect(retryStripeDeliveryCheck(client)).rejects.toMatchObject({
    status: 409,
  });
  expect(rawRequest).not.toHaveBeenCalled();
});
