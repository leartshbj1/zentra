import { describe, expect, it } from 'vitest';
import {
  stripeAutomaticTaxRequired,
  stripeTestAccessAllowed,
} from './stripe-test-access';

const ownerOnly = {
  secretKey: 'sk_test_placeholder',
  testMode: 'owner_only',
  ownerAccountUserId: 'owner-user-id',
  ownerEmail: 'owner@zentra.ch',
};

describe('private Stripe test access', () => {
  it('désactive Stripe Tax uniquement dans le test propriétaire explicite', () => {
    expect(stripeAutomaticTaxRequired(ownerOnly)).toBe(false);
    expect(
      stripeAutomaticTaxRequired({
        ...ownerOnly,
        secretKey: 'sk_live_placeholder',
      }),
    ).toBe(true);
    expect(
      stripeAutomaticTaxRequired({ ...ownerOnly, testMode: '' }),
    ).toBe(true);
  });
  it('keeps a live checkout available', () => {
    expect(
      stripeTestAccessAllowed(
        { ...ownerOnly, secretKey: 'sk_live_placeholder', testMode: '' },
        {
          userId: 'client-user-id',
          email: 'client@example.ch',
          emailConfirmed: true,
        },
      ),
    ).toBe(true);
  });

  it('exige aussi un compte confirmé en production', () => {
    expect(
      stripeTestAccessAllowed(
        { ...ownerOnly, secretKey: 'sk_live_placeholder', testMode: '' },
        null,
      ),
    ).toBe(false);
  });

  it('fails closed for a test key unless owner-only mode is exact', () => {
    expect(
      stripeTestAccessAllowed({ ...ownerOnly, testMode: '' }, null),
    ).toBe(false);
    expect(
      stripeTestAccessAllowed(
        { ...ownerOnly, secretKey: '', testMode: 'owner_only' },
        { userId: 'owner-user-id', email: 'owner@zentra.ch', emailConfirmed: true },
      ),
    ).toBe(false);
  });

  it('rejects anonymous and unrelated users in owner-only test mode', () => {
    expect(stripeTestAccessAllowed(ownerOnly, null)).toBe(false);
    expect(
      stripeTestAccessAllowed(ownerOnly, {
        userId: 'someone-else',
        email: 'client@example.ch',
        emailConfirmed: true,
      }),
    ).toBe(false);
  });

  it('accepts the configured owner by stable id or normalized email', () => {
    expect(
      stripeTestAccessAllowed(ownerOnly, {
        userId: 'owner-user-id',
        email: 'different@example.ch',
        emailConfirmed: true,
      }),
    ).toBe(true);
    expect(
      stripeTestAccessAllowed(ownerOnly, {
        userId: 'new-auth-id',
        email: ' OWNER@ZENTRA.CH ',
        emailConfirmed: true,
      }),
    ).toBe(true);
  });

  it('fails closed when owner identifiers are missing', () => {
    expect(
      stripeTestAccessAllowed(
        { ...ownerOnly, ownerAccountUserId: '', ownerEmail: '' },
        { userId: 'owner-user-id', email: 'owner@zentra.ch', emailConfirmed: true },
      ),
    ).toBe(false);
  });

  it('refuse le mode test si l’adresse du propriétaire n’est pas confirmée', () => {
    expect(
      stripeTestAccessAllowed(ownerOnly, {
        userId: 'owner-user-id',
        email: 'owner@zentra.ch',
        emailConfirmed: false,
      }),
    ).toBe(false);
  });
});
