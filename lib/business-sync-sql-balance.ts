// SQLite associates long AND/OR chains to the left. Reassociating the same
// operands keeps SQL's three-valued truth table while reducing D1 tree depth.
// Literals, CASE bodies, BETWEEN bounds and nested SELECT clauses stay scoped.
type Token = { value: string; start: number; end: number };
function tokens(sql: string): Token[] {
  const result: Token[] = [];
  let i = 0,
    depth = 0;
  while (i < sql.length) {
    const start = i,
      ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const end = ch === '[' ? ']' : ch;
      i++;
      while (i < sql.length) {
        if (sql[i++] === end) {
          if (sql[i] === end && ch !== '[') i++;
          else break;
        }
      }
      continue;
    }
    if (sql.slice(i, i + 2) === '--') {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.slice(i, i + 2) === '/*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unclosed trusted SQL comment');
      i = end + 2;
      continue;
    }
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      i++;
      while (i < sql.length && /[A-Za-z_0-9]/.test(sql[i])) i++;
      if (depth === 0)
        result.push({
          value: sql.slice(start, i).toUpperCase(),
          start,
          end: i,
        });
    } else {
      if (depth === 0 && ch === ',')
        result.push({ value: ',', start, end: i + 1 });
      i++;
    }
  }
  return result;
}
function scoped(sql: string) {
  let cases = 0,
    between = false;
  return tokens(sql).filter((t) => {
    if (t.value === 'CASE') {
      cases++;
      return false;
    }
    if (t.value === 'END' && cases) {
      cases--;
      return false;
    }
    if (cases) return false;
    if (t.value === 'BETWEEN') {
      between = true;
      return false;
    }
    if (t.value === 'AND' && between) {
      between = false;
      return false;
    }
    return true;
  });
}
function tree(parts: string[], op: string): string {
  if (parts.length === 1) return parts[0];
  const half = Math.floor(parts.length / 2);
  return `(${tree(parts.slice(0, half), op)} ${op} ${tree(parts.slice(half), op)})`;
}
function split(sql: string, at: Token[]) {
  let start = 0;
  const parts = at.map((t) => {
    const part = sql.slice(start, t.start).trim();
    start = t.end;
    return part;
  });
  parts.push(sql.slice(start).trim());
  return parts;
}
function boolean(sql: string): string {
  const words = scoped(sql);
  for (const op of ['OR', 'AND']) {
    const at = words.filter((t) => t.value === op);
    if (at.length)
      return tree(
        split(sql, at).map((p) => boolean(p)),
        op,
      );
  }
  return sql;
}
function segment(sql: string): string {
  const words = scoped(sql);
  if (words[0]?.value === 'SELECT' || words[0]?.value === 'WITH') {
    const clauses = words.filter((t) => ['WHERE', 'HAVING'].includes(t.value));
    for (const clause of clauses.reverse()) {
      const end =
        words.find(
          (t) =>
            t.start > clause.end &&
            [
              'GROUP',
              'ORDER',
              'LIMIT',
              'UNION',
              'INTERSECT',
              'EXCEPT',
              'WINDOW',
              'HAVING',
            ].includes(t.value),
        )?.start ?? sql.length;
      sql =
        sql.slice(0, clause.end) +
        ' ' +
        boolean(sql.slice(clause.end, end).trim()) +
        ' ' +
        sql.slice(end);
    }
    return sql;
  }
  const commas = words.filter((t) => t.value === ',');
  if (commas.length) return split(sql, commas).map(segment).join(',');
  // CAST(... AS ...) and FROM/JOIN fragments are not Boolean expressions.
  if (words.some((t) => ['AS', 'FROM', 'JOIN'].includes(t.value))) return sql;
  return boolean(sql);
}
export function balanceSqlPredicates(sql: string): string {
  let output = '',
    i = 0,
    start = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const end = ch === '[' ? ']' : ch;
      i++;
      while (i < sql.length)
        if (sql[i++] === end) {
          if (sql[i] === end && ch !== '[') i++;
          else break;
        }
      continue;
    }
    if (sql.slice(i, i + 2) === '--') {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.slice(i, i + 2) === '/*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unclosed trusted SQL comment');
      i = end + 2;
      continue;
    }
    if (ch === '(') {
      output += sql.slice(start, i) + '(';
      const begin = ++i;
      let depth = 1;
      // Reuse a lexical scan to find the matching delimiter without treating
      // parentheses inside quoted payload paths or comments as syntax.
      while (i < sql.length && depth) {
        const c = sql[i];
        if (c === "'" || c === '"' || c === '`' || c === '[') {
          const end = c === '[' ? ']' : c;
          i++;
          while (i < sql.length)
            if (sql[i++] === end) {
              if (sql[i] === end && c !== '[') i++;
              else break;
            }
        } else if (sql.slice(i, i + 2) === '--') {
          const end = sql.indexOf('\n', i + 2);
          i = end < 0 ? sql.length : end + 1;
        } else if (sql.slice(i, i + 2) === '/*') {
          const end = sql.indexOf('*/', i + 2);
          if (end < 0) throw new Error('Unclosed trusted SQL comment');
          i = end + 2;
        } else {
          if (c === '(') depth++;
          if (c === ')') depth--;
          i++;
        }
      }
      if (depth) throw new Error('Unclosed trusted SQL expression');
      output += balanceSqlPredicates(sql.slice(begin, i - 1)) + ')';
      start = i;
    } else i++;
  }
  return segment(output + sql.slice(start));
}
