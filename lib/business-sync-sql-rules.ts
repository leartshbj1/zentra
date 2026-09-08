// This parser reads checked-in SQLite DDL only. Uploaded data never becomes SQL.
type Token = {
  value: string;
  kind: 'word' | 'quoted' | 'string' | 'symbol';
  start: number;
  end: number;
};

function tokens(sql: string): Token[] {
  const result: Token[] = [];
  let at = 0;
  while (at < sql.length) {
    if (/\s/.test(sql[at])) {
      at++;
      continue;
    }
    if (sql.startsWith('--', at)) {
      const end = sql.indexOf('\n', at);
      at = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', at)) {
      const end = sql.indexOf('*/', at + 2);
      if (end < 0) throw new Error('Unclosed trusted SQL comment');
      at = end + 2;
      continue;
    }
    const start = at;
    const character = sql[at++];
    if (["'", '"', '`', '['].includes(character)) {
      const close = character === '[' ? ']' : character;
      let value = '';
      let closed = false;
      while (at < sql.length) {
        const next = sql[at++];
        if (next !== close) {
          value += next;
          continue;
        }
        if (character !== '[' && sql[at] === close) {
          value += close;
          at++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error('Unclosed trusted SQL literal');
      result.push({
        value,
        kind: character === "'" ? 'string' : 'quoted',
        start,
        end: at,
      });
    } else if (/[a-z_]/i.test(character)) {
      while (at < sql.length && /[a-z0-9_$]/i.test(sql[at])) at++;
      result.push({
        value: sql.slice(start, at),
        kind: 'word',
        start,
        end: at,
      });
    } else result.push({ value: character, kind: 'symbol', start, end: at });
  }
  return result;
}

function closeParenthesis(list: Token[], start: number): number {
  if (list[start]?.kind !== 'symbol' || list[start].value !== '(')
    throw new Error('Expected trusted SQL parenthesis');
  let depth = 0;
  for (let at = start; at < list.length; at++) {
    if (list[at].kind !== 'symbol') continue;
    if (list[at].value === '(') depth++;
    if (list[at].value === ')' && --depth === 0) return at;
  }
  throw new Error('Unclosed trusted SQL expression');
}

export function sqlIdentifiers(sql: string): string[] {
  return tokens(sql)
    .filter((t) => t.kind === 'word' || t.kind === 'quoted')
    .map((t) => t.value.toLowerCase());
}

export function sqlChecks(sql: string): string[] {
  const list = tokens(sql);
  const checks: string[] = [];
  for (let at = 0; at < list.length; at++) {
    if (list[at].kind === 'word' && list[at].value.toUpperCase() === 'CHECK') {
      const end = closeParenthesis(list, at + 1);
      checks.push(sql.slice(list[at + 1].end, list[end].start));
      at = end;
    }
  }
  return checks;
}

export function sqlUniqueIndex(sql: string): {
  expressions: string[];
  where: string | null;
} {
  const list = tokens(sql);
  const on = list.findIndex(
    (t) => t.kind === 'word' && t.value.toUpperCase() === 'ON',
  );
  if (on < 0 || !['word', 'quoted'].includes(list[on + 1]?.kind))
    throw new Error('Invalid trusted unique index');
  const open = on + 2;
  const close = closeParenthesis(list, open);
  let depth = 0;
  let start = list[open].end;
  const expressions: string[] = [];
  const add = (end: number) => {
    const expression = sql.slice(start, end).trim();
    const pieces = tokens(expression);
    const last = pieces.at(-1);
    expressions.push(
      last?.kind === 'word' &&
        ['ASC', 'DESC'].includes(last.value.toUpperCase())
        ? expression.slice(0, last.start).trim()
        : expression,
    );
  };
  for (let at = open + 1; at < close; at++) {
    if (list[at].kind !== 'symbol') continue;
    if (list[at].value === '(') depth++;
    if (list[at].value === ')') depth--;
    if (list[at].value === ',' && depth === 0) {
      add(list[at].start);
      start = list[at].end;
    }
  }
  add(list[close].start);
  const trailing = list.slice(close + 1).filter((t) => t.value !== ';');
  let where: string | null = null;
  if (trailing.length) {
    if (
      trailing[0].kind !== 'word' ||
      trailing[0].value.toUpperCase() !== 'WHERE'
    )
      throw new Error('Unsupported trusted index suffix');
    where = sql.slice(trailing[0].end, trailing.at(-1)!.end).trim();
  }
  if (expressions.some((e) => !e) || where === '')
    throw new Error('Empty trusted index expression');
  return { expressions, where };
}
