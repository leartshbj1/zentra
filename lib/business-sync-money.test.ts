import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  boundedPositiveSum,
  roundedProportionCtes,
} from './business-sync-money';
let db: DatabaseSync;
const sql = `WITH RECURSIVE ${roundedProportionCtes('inputs', 'proportions')} SELECT id,amount FROM proportions ORDER BY id`;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE inputs(id INTEGER PRIMARY KEY,amount,numerator,denominator)',
  );
});
afterEach(() => db.close());
function insert(
  id: number,
  amount: bigint | number | null,
  numerator: bigint | number | null,
  denominator: bigint | number | null,
) {
  db.prepare('INSERT INTO inputs VALUES(?,?,?,?)').run(
    id,
    amount,
    numerator,
    denominator,
  );
}
function result() {
  const query = db.prepare(sql);
  query.setReadBigInts(true);
  return query.all() as { id: bigint; amount: bigint | null }[];
}
it('matches exact i128-style arithmetic at i64 boundaries and rounding ties', () => {
  const max = BigInt('9223372036854775807');
  const cases = [
    [BigInt('0'), max, max],
    [max, BigInt('0'), max],
    [max, max, max],
    [max, max - BigInt('1'), max],
    [max, BigInt('1'), BigInt('2')],
    [max, BigInt('2'), BigInt('3')],
    [BigInt('1'), BigInt('1'), BigInt('2')],
    [BigInt('1'), BigInt('1'), BigInt('3')],
    [BigInt('81'), BigInt('333'), BigInt('1081')],
    [max, BigInt('1'), max],
    [max, BigInt('7'), BigInt('9')],
    [BigInt('18'), BigInt('8'), BigInt('9')],
  ];
  cases.forEach(([a, n, d], id) => insert(id, a, n, d));
  expect(result().map((r) => r.amount)).toEqual(
    cases.map(([a, n, d]) => (a * n + d / BigInt('2')) / d),
  );
});
it('matches deterministic large random products without floating-point intermediates', () => {
  const mask = BigInt('9223372036854775807');
  let state = BigInt('764912');
  const random = () => {
    state = (state * BigInt('6364136223846793005') + BigInt('1442695040888963407')) & mask;
    return state;
  };
  const expected: bigint[] = [];
  for (let id = 0; id < 500; id++) {
    const a = random(),
      d = random() + BigInt('1'),
      n = random() % d;
    insert(id, a, n, d);
    expected.push((a * n + d / BigInt('2')) / d);
  }
  expect(result().map((r) => r.amount)).toEqual(expected);
});
it('returns no amount for invalid domains instead of dividing by zero or accepting REAL values', () => {
  const cases = [
    [BigInt('1'), BigInt('1'), BigInt('0')],
    [BigInt('1'), BigInt('2'), BigInt('1')],
    [-BigInt('1'), BigInt('1'), BigInt('2')],
    [BigInt('1'), -BigInt('1'), BigInt('2')],
    [1.5, BigInt('1'), BigInt('2')],
    [BigInt('1'), null, BigInt('2')],
  ];
  cases.forEach(([a, n, d], id) => insert(id, a, n, d));
  expect(result().every((r) => r.amount === null)).toBe(true);
});
it('bounds positive sums without overflowing before the limit check', () => {
  const sum = db.prepare(
    `SELECT ${boundedPositiveSum('amount')} amount FROM inputs`,
  );
  sum.setReadBigInts(true);
  insert(0, BigInt('9223372036854775806'), BigInt('0'), BigInt('1'));
  insert(1, BigInt('1'), BigInt('0'), BigInt('1'));
  expect(sum.get()!.amount).toBe(BigInt('9223372036854775807'));
  insert(2, BigInt('1'), BigInt('0'), BigInt('1'));
  expect(sum.get()!.amount).toBeNull();
  db.exec('DELETE FROM inputs');
  insert(0, -BigInt('1'), BigInt('0'), BigInt('1'));
  expect(sum.get()!.amount).toBeNull();
});
