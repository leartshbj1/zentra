import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { balanceSqlPredicates } from './business-sync-sql-balance';
import { nativeGuardContract } from './business-sync-native-guard-contract';
const operands = (sql: string) =>
  sql.match(
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|[A-Za-z_]\w*|[0-9]+(?:\.[0-9]+)?|[^\s()]/g,
  );
it('only reassociates parentheses without altering any operand of the complete native catalog', () => {
  for (const g of nativeGuardContract.guards)
    expect(operands(balanceSqlPredicates(g.condition)), g.name).toEqual(
      operands(g.condition),
    );
});
it.each([
  'a AND b AND c OR a AND c',
  'a OR b AND c OR a IS NULL',
  'NOT (a OR b) AND c AND a IS NOT NULL',
  'a BETWEEN b AND c AND b IS NULL OR c=1',
  'CASE WHEN a AND b THEN c ELSE a OR b END AND c',
  "COALESCE(a AND b,c,0) OR 'x AND (OR)'='x AND (OR)'",
  'EXISTS(SELECT 1 WHERE a AND b AND c OR a IS NULL)',
  'EXISTS(SELECT 1 WHERE a=1 AND b=1 /* AND ( */ AND c=1)',
])('preserves SQLite null/false/true semantics for %s', (expression) => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const a of [null, 0, 1])
      for (const b of [null, 0, 1])
        for (const c of [null, 0, 1]) {
          const query = `WITH v(a,b,c) AS (VALUES(?,?,?)) SELECT (${expression}) result FROM v`;
          expect(db.prepare(balanceSqlPredicates(query)).get(a, b, c)).toEqual(
            db.prepare(query).get(a, b, c),
          );
        }
  } finally {
    db.close();
  }
});
it('keeps grouping, ordering, limits, quoted names and nested SELECT scopes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE t(a,b); INSERT INTO t VALUES(1,2),(1,3),(2,4),(NULL,5)',
    );
    const queries = [
      'SELECT a,COUNT(*) n FROM t WHERE b>0 AND b<9 AND a IS NOT NULL GROUP BY a HAVING COUNT(*)>0 AND SUM(b)>0 ORDER BY n DESC LIMIT 2',
      "SELECT a FROM t WHERE b BETWEEN 1 AND 5 AND EXISTS(SELECT 1 FROM t x WHERE x.a=t.a AND x.b>0 AND x.b<8) AND 'it''s (AND)'<>'OR' ORDER BY b",
      `SELECT a FROM t WHERE ${Array(180).fill('(a IS NULL OR a>=0)').join(' AND ')} ORDER BY b`,
    ];
    for (const query of queries)
      expect(db.prepare(balanceSqlPredicates(query)).all()).toEqual(
        db.prepare(query).all(),
      );
  } finally {
    db.close();
  }
});
