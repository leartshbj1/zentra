import { describe, expect, it } from 'vitest';
import {
  originalPurchasePath,
  postFinanceHostedUrl,
  postFinancePurchasePath,
  validPostFinanceTargetId,
} from './postfinance-client-navigation';

describe('Swiss payment client navigation', () => {
  it('preserves the exact Support workspace when returning to its existing payment', () => {
    const url = new URL(
      originalPurchasePath('support:team', 'company-a', 'space-b'),
      'https://zentra.example.test',
    );
    expect(url.pathname).toBe('/support/espace');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      section: 'billing',
      workspace: 'space-b',
    });
  });
  it('encodes owned targets instead of allowing them to add query fields', () => {
    const url = new URL(
      postFinancePurchasePath('complet:team', 'company&a', 'space?x=1'),
      'https://zentra.example.test',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      produit: 'complet:team',
      entreprise: 'company&a',
      espace: 'space?x=1',
    });
    expect(originalPurchasePath('complet:team', 'company&a')).toBe(
      '/complet/abonnement?formule=team&organizationId=company%26a',
    );
  });
  it.each([
    'http://checkout.postfinance.ch/p',
    'https://checkout.postfinance.ch.evil.test/p',
    'https://checkout.postfinance.ch@evil.test/p',
    'https://evil.test/p',
    'javascript:alert(1)',
    'https://app-wallee.com:8080/p',
    'https://checkout.postfinance.ch/p#token',
    '/compte',
    null,
  ])('refuses an unsafe merchant link %s', (value) => {
    expect(postFinanceHostedUrl(value)).toBeNull();
  });
  it.each([
    'https://checkout.postfinance.ch/payment/123',
    'https://app-wallee.com/payment/123',
  ])('accepts only the configured provider origins %s', (value) => {
    expect(postFinanceHostedUrl(value)?.href).toBe(value);
  });
  it.each([undefined, null, [], '', 'a'.repeat(181), 'id\n', 'id\u007f'])(
    'rejects an invalid target %s',
    (value) => {
      expect(validPostFinanceTargetId(value)).toBe(false);
    },
  );
  it('does not silently select another product or company', () => {
    expect(originalPurchasePath('unknown')).toBe('/compte');
    expect(originalPurchasePath('automation', 'company-b')).toBe(
      '/compte/automation?organizationId=company-b',
    );
    expect(originalPurchasePath('gestion:solo')).toBe('/pricing?formule=solo');
  });
});
