import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ready: vi.fn(), price: vi.fn(), portal: vi.fn() }));
vi.mock('@/lib/runtime', () => ({}));
vi.mock('@/lib/stripe-readiness', () => ({ assertStripeCheckoutReady: mocks.ready }));
vi.mock('./stripe', () => ({ ensureCompletePrice: mocks.price, ensureCompletePortalConfiguration: mocks.portal }));
import { prepareCompleteCatalog } from './catalog-admin';
import { PublicError } from '@/lib/stripe';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.price.mockImplementation(async plan => ({ id: `price_${plan.id}` }));
});
it('prepares exactly the approved catalog after real readiness checks, then the portal', async () => {
  const result = await prepareCompleteCatalog();
  expect(mocks.ready.mock.calls.map(c => c[0])).toEqual(['solo','start','pro']);
  expect(mocks.price.mock.calls.map(c => [c[0].id,c[0].priceChfCents])).toEqual([['solo',7900],['team',9900],['pro',16900]]);
  expect(result.checks.map(c => [c.plan,c.ready])).toEqual([['Complet Solo',true],['Complet Équipe',true],['Complet Pro',true],['Portail du pack',true]]);
  expect(mocks.portal).toHaveBeenCalledOnce();
});
it('does not create a price whose readiness failed or claim all packs are ready', async () => {
  mocks.ready.mockRejectedValueOnce(new PublicError('Vérifiez la réception Stripe.',503));
  const result = await prepareCompleteCatalog();
  expect(mocks.price.mock.calls.map(c => c[0].id)).toEqual(['team','pro']);
  expect(result.checks[0]).toMatchObject({ready:false,message:'Vérifiez la réception Stripe.'});
  expect(mocks.portal).not.toHaveBeenCalled();
});
it('reports catalog or portal errors without disclosing provider details', async () => {
  mocks.price.mockRejectedValueOnce(new Error('secret-provider-response'));
  expect(JSON.stringify(await prepareCompleteCatalog())).not.toContain('secret-provider-response');
  mocks.portal.mockRejectedValueOnce(new Error('secret-portal-response'));
  const result = await prepareCompleteCatalog();
  expect(result.checks.at(-1)).toMatchObject({plan:'Portail du pack',ready:false});
  expect(JSON.stringify(result)).not.toContain('secret-portal-response');
});
