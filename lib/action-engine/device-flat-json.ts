import { RequestBodyError } from '@/lib/request-body';

const stringToken =
  // eslint-disable-next-line no-control-regex -- JSON string literals exclude U+0000 through U+001F.
  /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const primitiveToken =
  /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
function invalid(): never {
  throw new RequestBodyError('La demande Automation est invalide.', 400);
}

/** Shared private flat JSON syntax, not a business DTO or authorization.
 * Each handler retains its own byte bound and closed operation codec.
 * Decoded duplicate keys are rejected before JSON.parse can overwrite them. */
export function parseFlatDeviceJson(text: string): unknown {
  let at = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(text[at] ?? '\0')) at++;
  };
  const take = (expected: string) => {
    whitespace();
    if (text[at++] !== expected) invalid();
  };
  const token = (pattern: RegExp): string => {
    whitespace();
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) return invalid();
    at = pattern.lastIndex;
    return match[0];
  };
  const values: Record<string, unknown> = Object.create(null);
  take('{');
  whitespace();
  if (text[at] !== '}') {
    for (;;) {
      const key: string = JSON.parse(token(stringToken));
      if (Object.hasOwn(values, key)) invalid();
      take(':');
      whitespace();
      values[key] = JSON.parse(
        token(text[at] === '"' ? stringToken : primitiveToken),
      );
      whitespace();
      if (text[at] !== ',') break;
      at++;
    }
  }
  take('}');
  whitespace();
  if (at !== text.length) invalid();
  return values;
}
