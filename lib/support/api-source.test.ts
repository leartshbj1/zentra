import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Sender capture must not read a database');
  },
}));
import { apiSenderIdentity } from './api-source';
import { SupportError } from './types';

describe('authenticated API connector sender envelope', () => {
  it('keeps absent identity unavailable and never derives it from body or authority fields', () => {
    const result = apiSenderIdentity({
      body: 'From: Forged Person <forged@example.test>',
      subject: 'Please create a customer',
      userId: 'forged-owner',
      organizationId: 'forged-company',
      role: 'owner',
      sender: 'other@example.test',
    });
    expect(result).toEqual({});
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('normalizes one envelope address and preserves a literal Unicode display name', () => {
    expect(
      apiSenderIdentity({
        senderEmail: '  CAMILLE@EXAMPLE.TEST  ',
        senderName: '  Camille Müller 🛠  ',
        senderIdentityAmbiguous: false,
      }),
    ).toEqual({
      senderEmail: 'camille@example.test',
      senderName: '  Camille Müller 🛠  ',
      senderIdentityAmbiguous: false,
    });
    expect(
      apiSenderIdentity({
        senderEmail: 'CAMILLE@EXAMPLE.TEST',
        senderName: 'A'.repeat(200),
        senderIdentityAmbiguous: true,
      }),
    ).toEqual({
      senderEmail: 'camille@example.test',
      senderName: 'A'.repeat(200),
      senderIdentityAmbiguous: true,
    });
  });

  it('accepts independently optional fields without supplying a missing address or name', () => {
    expect(apiSenderIdentity({ senderName: 'Camille' })).toEqual({
      senderName: 'Camille',
    });
    expect(apiSenderIdentity({ senderEmail: 'client@example.test' })).toEqual({
      senderEmail: 'client@example.test',
    });
    expect(apiSenderIdentity({ senderIdentityAmbiguous: true })).toEqual({
      senderIdentityAmbiguous: true,
    });
  });

  it.each([
    null,
    undefined,
    42,
    '',
    ' ',
    'not-an-address',
    'first@example.test,second@example.test',
    'Camille <client@example.test>',
    'first@example.test, Camille <second@example.test>',
    'first@example.test;second@example.test',
    'first@example.test\nBcc: second@example.test',
    'first\u0000@example.test',
    'first\u007f@example.test',
    'x'.repeat(255) + '@example.test',
    ['client@example.test'],
    { address: 'client@example.test' },
  ])(
    'refuses an explicitly invalid senderEmail without reflecting it: %j',
    (senderEmail) => {
      expect(() => apiSenderIdentity({ senderEmail })).toThrow(SupportError);
      expect(() => apiSenderIdentity({ senderEmail })).toThrow(
        'une seule adresse e-mail',
      );
    },
  );

  it.each([
    null,
    undefined,
    42,
    '',
    '   ',
    'x'.repeat(201),
    'Camille\nOther',
    'Camille\u0000',
    'Camille\u007f',
    {},
    [],
  ])('refuses an explicitly invalid senderName: %j', (senderName) => {
    expect(() => apiSenderIdentity({ senderName })).toThrow(SupportError);
  });

  it.each([null, undefined, 0, 1, 'false', 'true', {}, []])(
    'refuses a nonboolean ambiguity flag: %j',
    (senderIdentityAmbiguous) => {
      expect(() => apiSenderIdentity({ senderIdentityAmbiguous })).toThrow(
        SupportError,
      );
    },
  );

  it.each(['senderEmail', 'senderName', 'senderIdentityAmbiguous'])(
    'does not invoke an accessor for %s',
    (key) => {
      let calls = 0;
      const input = Object.defineProperty({}, key, {
        enumerable: true,
        get() {
          calls++;
          throw Error('private getter content');
        },
      });
      expect(() => apiSenderIdentity(input)).toThrow(SupportError);
      expect(calls).toBe(0);
    },
  );

  it('rejects hidden identity fields instead of silently accepting a different envelope', () => {
    expect(() =>
      apiSenderIdentity(
        Object.defineProperty({}, 'senderEmail', {
          value: 'client@example.test',
          enumerable: false,
        }),
      ),
    ).toThrow(SupportError);
  });
});
