import { expect, it } from 'vitest';
import { firstRowsByKeys, groupRowsByKeys } from './rowIndex';

it('matches strict either-key lookups in source order, including duplicate roles and legacy missing values', () => {
  const rows = [
    { left: 'a', right: 'b', id: 1 },
    { left: 'b', right: 'a', id: 2 },
    { left: 'a', right: 'a', id: 3 },
    { left: undefined, right: null, id: 4 },
    { left: 3, right: '3', id: 5 },
    { left: NaN, right: NaN, id: 6 },
  ];
  const first = firstRowsByKeys(rows, row => [row.left, row.right]);
  const groups = groupRowsByKeys(rows, row => [row.left, row.right]);
  for (const key of ['a', 'b', 'missing', undefined, null, 3, '3', NaN]) {
    expect(first.get(key)).toBe(rows.find(row => row.left === key || row.right === key));
    expect(groups.get(key) ?? []).toEqual(rows.filter(row => row.left === key || row.right === key));
  }
  expect(groups.get('a')).toHaveLength(3);
});
