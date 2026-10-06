import { describe, expect, it } from 'vitest';
import { automationPaymentUrl, completePaymentUrl } from './client-payment-url';

const origin = 'https://zentraapp.ch';
const org = 'entreprise-équipe';
describe('payment navigation boundaries', () => {
  it('accepts the completed Automation receipt for the selected enterprise', () => {
    const receipt = `${origin}/compte/automation?entreprise=${encodeURIComponent(org)}`;
    expect(automationPaymentUrl(receipt, origin, org)?.href).toBe(receipt);
  });
  it('accepts the completed pack receipt and the existing Stripe checkout', () => {
    expect(completePaymentUrl(`${origin}/compte`, origin)?.href).toBe(
      `${origin}/compte`,
    );
    expect(
      completePaymentUrl('https://checkout.stripe.com/c/pay/cs_test', origin)
        ?.hostname,
    ).toBe('checkout.stripe.com');
  });
  it('keeps the existing Automation billing portal', () => {
    expect(
      automationPaymentUrl(
        'https://billing.stripe.com/p/session/test',
        origin,
        org,
      )?.hostname,
    ).toBe('billing.stripe.com');
    expect(
      completePaymentUrl('https://billing.stripe.com/p/session/test', origin),
    ).toBeNull();
  });
  it('supports a same-origin local preview without accepting another port', () => {
    expect(completePaymentUrl('/compte', 'http://localhost:5352')?.href).toBe(
      'http://localhost:5352/compte',
    );
    expect(
      completePaymentUrl(
        'http://localhost:5353/compte',
        'http://localhost:5352',
      ),
    ).toBeNull();
  });
  it.each([
    'javascript:alert(1)',
    'http://checkout.stripe.com/c/pay/test',
    'https://checkout.stripe.com.evil.test/c/pay/test',
    'https://checkout.stripe.com:8443/c/pay/test',
    'https://user:secret@checkout.stripe.com/c/pay/test',
    'https://evil.test/compte',
    '//evil.test/compte',
    'https://user:secret@zentraapp.ch/compte',
    '/connexion?retour=https://evil.test',
  ])('rejects an untrusted destination %s for both products', (raw) => {
    expect(completePaymentUrl(raw, origin)).toBeNull();
    expect(automationPaymentUrl(raw, origin, org)).toBeNull();
  });
  it.each([
    '/compte/automation?entreprise=another',
    '/compte/automation?entreprise=entreprise-%C3%A9quipe&entreprise=another',
    '/compte/automation?entreprise=entreprise-%C3%A9quipe&retour=https://evil.test',
    '/compte/automation?entreprise=entreprise-%C3%A9quipe#redirect',
    '/compte/automation',
    '/compte',
  ])(
    'rejects an Automation receipt outside the selected enterprise %s',
    (raw) => {
      expect(automationPaymentUrl(raw, origin, org)).toBeNull();
    },
  );
  it.each([
    '/compte?retour=/support',
    '/compte#redirect',
    '/compte/automation',
    '/compte/',
  ])('restricts the pack receipt to the exact account page %s', (raw) => {
    expect(completePaymentUrl(raw, origin)).toBeNull();
  });
});
