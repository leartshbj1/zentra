import { beforeEach, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
const env = vi.hoisted(() => ({
  STRIPE_SECRET_KEY: 'sk_live_fixture',
  STRIPE_WEBHOOK_ENDPOINT_ID: 'we_existing',
  PUBLIC_SITE_URL: 'https://zentraapp.ch',
}));
vi.mock('@/lib/runtime', () => ({
  runtimeValue: (key: keyof typeof env) => env[key] || '',
  stripeConfiguration: () => ({ secretKey: env.STRIPE_SECRET_KEY }),
}));
import { configureAutomationWebhook } from './billing';
import {
  REQUIRED_STRIPE_WEBHOOK_EVENTS,
  STRIPE_API_VERSION,
} from '@/lib/stripe';
const retrieve = vi.fn(),
  update = vi.fn();
const stripe = { webhookEndpoints: { retrieve, update } } as unknown as Stripe;
const hook = () => ({
  id: 'we_existing',
  url: 'https://zentraapp.ch/api/stripe/webhook',
  status: 'enabled',
  livemode: true,
  api_version: STRIPE_API_VERSION,
  enabled_events: ['invoice.paid', 'payment_intent.succeeded'],
});
beforeEach(() => {
  vi.clearAllMocks();
  retrieve.mockResolvedValue(hook());
  update.mockImplementation(async (_id, input) => ({ ...hook(), ...input }));
});
it('adds required events on the verified existing endpoint and preserves its other events', async () => {
  await configureAutomationWebhook(stripe);
  expect(update).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledWith('we_existing', {
    enabled_events: expect.arrayContaining([
      ...REQUIRED_STRIPE_WEBHOOK_EVENTS,
      'payment_intent.succeeded',
    ]),
  });
  expect(Object.keys(update.mock.calls[0][1])).toEqual(['enabled_events']);
});
it.each([
  { enabled_events: ['*'] },
  { enabled_events: [...REQUIRED_STRIPE_WEBHOOK_EVENTS] },
])('does not mutate an already complete endpoint', async (patch) => {
  retrieve.mockResolvedValue({ ...hook(), ...patch });
  await configureAutomationWebhook(stripe);
  expect(update).not.toHaveBeenCalled();
});
it.each([
  { id: 'we_other' },
  { url: 'https://other.example/webhook' },
  { status: 'disabled' },
  { livemode: false },
  { api_version: 'older' },
])('refuses to modify a mismatched endpoint %j', async (patch) => {
  retrieve.mockResolvedValue({ ...hook(), ...patch });
  await expect(configureAutomationWebhook(stripe)).rejects.toMatchObject({
    status: 503,
  });
  expect(update).not.toHaveBeenCalled();
});
it('does not claim success when the refund notification was not saved', async () => {
  update.mockResolvedValue(hook());
  await expect(configureAutomationWebhook(stripe)).rejects.toMatchObject({
    status: 503,
  });
});
