import { expect, it } from 'vitest';
import { memberFullName } from './member-name';
it('keeps international and compound names while normalizing surrounding spaces', () => {
  expect(memberFullName('  Anne-Marie ', ' de   La Tour ')).toBe(
    'Anne-Marie de La Tour',
  );
  expect(memberFullName('Le\u0301a', 'D’Angelo')).toBe('Léa D’Angelo');
  expect(memberFullName('李', '王')).toBe('李 王');
});
it.each([
  [undefined, 'Martin'],
  ['Camille', ''],
  ['mail@example.test', 'Martin'],
  ['Camille\n', 'Martin'],
  ['a'.repeat(71), 'Martin'],
])('requires both name fields, not an email or control text', (first, last) => {
  expect(() => memberFullName(first, last)).toThrow();
});
