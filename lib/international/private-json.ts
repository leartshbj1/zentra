/** A malformed private RPC projection is an unavailable invariant, never a
 * browser validation error. Do not attach its input or a provider/DB message. */
export class PrivateJsonError extends Error {
  readonly code = 'invalid_private_data';
  readonly status = 503;
  constructor() { super('invalid_private_data'); this.name = 'PrivateJsonError'; }
}

/** Detached, frozen JSON data only. This is a structural snapshot, not an Auth,
 * role, provider verification or authority check. Caller validators still must
 * allowlist fields, identities, revisions and exact canonical bodies.
 * Limits count keys as well as values; PostgreSQL jsonb cannot represent NUL.
 * Capture every caller-owned value synchronously before the first await. */
export function snapshotPrivateJson(input: unknown): unknown {
  let nodes = 0, characters = 0;
  const fail = (): never => { throw new PrivateJsonError(); };
  function string(value: string): string {
    characters += value.length;
    if (value.length > 524_288 || characters > 2_097_152) return fail();
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 0) return fail();
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return fail();
      } else if (code >= 0xdc00 && code <= 0xdfff) return fail();
    }
    return value;
  }
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 50_000 || depth > 20) return fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) return fail(); return value; }
    if (typeof value === 'string') return string(value);
    if (!value || typeof value !== 'object') return fail();
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 1_000 || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== length.value + 1) return fail();
      const copy: unknown[] = [];
      for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail();
        copy.push(visit(descriptor.value, depth + 1));
      }
      return Object.freeze(copy);
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return fail();
      string(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail();
      copy[key] = visit(descriptor.value, depth + 1);
    }
    return Object.freeze(copy);
  }
  try { return visit(input, 0); } catch { return fail(); }
}
