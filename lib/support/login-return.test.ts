import { expect, it } from 'vitest';
import { supportLoginReturn } from './login-return';
const company = 'org_5c49fe80-8b5b-4e0c-b948-6e326e88f61d';
const ticket = 'a42d2ba2-5618-4d9b-9292-951943b05d12';
it('preserves the exact company and focused message after sign-in', () => {
  const target = new URL(
    supportLoginReturn(
      `?organizationId=${company}&ticket=${ticket}`,
      'inbox',
      '',
      ticket,
    ),
    'https://zentraapp.ch',
  );
  expect(target.pathname).toBe('/support/espace');
  expect(Object.fromEntries(target.searchParams)).toEqual({
    section: 'inbox',
    organizationId: company,
    ticket,
  });
});
it('keeps company and chosen workspace together for the server to authorize their link', () => {
  const target = new URL(
    supportLoginReturn(
      `?organizationId=${company}`,
      'connections',
      'current_workspace',
      null,
    ),
    'https://zentraapp.ch',
  );
  expect(Object.fromEntries(target.searchParams)).toEqual({
    section: 'connections',
    organizationId: company,
    workspace: 'current_workspace',
  });
});
it('never carries arbitrary return URLs, credentials, duplicate targets or unsafe IDs', () => {
  expect(
    supportLoginReturn(
      '?organizationId=a&organizationId=b&ticket=https://evil.test&token=secret&retour=https://evil.test',
      '//evil.test',
      '',
      null,
    ),
  ).toBe('/support/espace?section=inbox');
  expect(
    supportLoginReturn('?workspace=' + 'x'.repeat(121), 'inbox', '', null),
  ).toBe('/support/espace?section=inbox');
});
