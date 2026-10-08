import { describe, expect, it, vi } from 'vitest';
import { PrivateJsonError, snapshotPrivateJson } from './private-json';

function unavailable(input: unknown): void {
  expect(() => snapshotPrivateJson(input)).toThrowError(PrivateJsonError);
  try { snapshotPrivateJson(input); } catch (error) {
    expect(error).toMatchObject({ code: 'invalid_private_data', status: 503, message: 'invalid_private_data' });
    expect(error).not.toHaveProperty('cause');
  }
}
function nested(depth: number): unknown { let value: unknown = null; for (let index = 0; index < depth; index++) value = [value]; return value; }

describe('private own-data JSON snapshots', () => {
  it('preserves JSON scalars and Unicode pairs without claiming an authority', () => {
    const input = { schemaVersion: 1, trusted: false, empty: null, value: 'TEST 🧪', amount: 1.25 };
    expect(snapshotPrivateJson(input)).toEqual(input);
    expect(snapshotPrivateJson(true)).toBe(true); expect(snapshotPrivateJson(null)).toBeNull();
    // Arbitrary data is copied, never accepted as a verified grant by this helper.
    expect(snapshotPrivateJson({ canIssue: true })).toEqual({ canIssue: true });
  });
  it('deeply detaches and freezes profiles, body arrays and aliased references', () => {
    const profile = { label: 'Private', address: { city: 'TEST' } }, input = { profile, profiles: [profile] };
    const result = snapshotPrivateJson(input) as typeof input;
    profile.address.city = 'Changed'; input.profiles.push(profile);
    expect(result.profile.address.city).toBe('TEST'); expect(result.profiles).toHaveLength(1);
    expect(result.profile).not.toBe(result.profiles[0]);
    for (const part of [result, result.profile, result.profile.address, result.profiles, result.profiles[0]]) expect(Object.isFrozen(part)).toBe(true);
    expect(() => { result.profile.address.city = 'Tampered'; }).toThrow(TypeError);
  });
  it('keeps plain and null-prototype data safe even with a JSON __proto__ key', () => {
    const result = snapshotPrivateJson(JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBeNull(); expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(snapshotPrivateJson(Object.assign(Object.create(null), { field: 'valid' }))).toEqual({ field: 'valid' });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('refuses object getters and setters without executing them', () => {
    const getter = vi.fn(() => 'Private'), setter = vi.fn();
    for (const descriptor of [{ get: getter }, { set: setter }]) unavailable(Object.defineProperty({}, 'private', { ...descriptor, enumerable: true }));
    expect(getter).not.toHaveBeenCalled(); expect(setter).not.toHaveBeenCalled();
  });
  it('refuses array getters without executing them', () => {
    const getter = vi.fn(() => 'Private'), value = ['safe']; Object.defineProperty(value, '0', { enumerable: true, get: getter });
    unavailable(value); expect(getter).not.toHaveBeenCalled();
  });
  it('reads array length and elements from descriptors without property access', () => {
    const get = vi.fn(() => { throw new Error('Must not read caller properties'); });
    expect(snapshotPrivateJson(new Proxy(['safe'], { get }))).toEqual(['safe']); expect(get).not.toHaveBeenCalled();
  });
  it('refuses callable toJSON without executing it', () => {
    const toJSON = vi.fn(() => ({ grant: true })); unavailable({ toJSON }); expect(toJSON).not.toHaveBeenCalled();
  });
  it('refuses unknown prototypes, built-ins and array subclasses', () => {
    class CustomArray extends Array<unknown> {}
    for (const value of [Object.create({ inherited: true }), new Date(), new Map(), new Set(), new String('private'), new CustomArray()]) unavailable(value);
  });
  it('refuses symbols and non-enumerable object data', () => {
    unavailable({ [Symbol('private')]: 'value' }); unavailable(Object.defineProperty({}, 'private', { value: 'hidden' }));
  });
  it('refuses sparse arrays, extra properties, hidden indices and symbol indices', () => {
    const hidden = ['value']; Object.defineProperty(hidden, '0', { value: 'value', enumerable: false });
    const hole = Array(2); hole[1] = 'value';
    for (const value of [Array(1), hole, Object.assign([], { extra: 'private' }), Object.assign([], { [Symbol('private')]: 'value' }), hidden]) unavailable(value);
  });
  it('refuses unsupported scalars without stringifying them', () => {
    const fn = vi.fn(); for (const value of [undefined, BigInt(1), Symbol('private'), fn, Number.NaN, Infinity, -Infinity, { omitted: undefined }]) unavailable(value);
    expect(fn).not.toHaveBeenCalled();
  });
  it('refuses isolated Unicode and NUL in both keys and values', () => {
    for (const text of ['\ud800', '\udc00', 'a\ud800b', 'a\udc00b', 'private\u0000data']) { unavailable(text); unavailable({ [text]: 'data' }); }
    expect(snapshotPrivateJson({ '🧪': 'Valid \ud83e\uddea' })).toEqual({ '🧪': 'Valid 🧪' });
  });
  it('bounds array length without rejecting its exact maximum', () => {
    expect(snapshotPrivateJson(Array(1_000).fill(null))).toHaveLength(1_000); unavailable(Array(1_001).fill(null));
  });
  it('bounds depth without rejecting its exact maximum', () => {
    expect(snapshotPrivateJson(nested(20))).toEqual(nested(20)); unavailable(nested(21));
  });
  it('refuses cycles without an uncontrolled stack overflow', () => {
    const object: Record<string, unknown> = {}; object.self = object; const array: unknown[] = []; array.push(array);
    unavailable(object); unavailable(array);
  });
  it('bounds node count without rejecting its exact maximum', () => {
    const nodes = Array.from({ length: 50 }, (_unused, index) => Array(index === 49 ? 998 : 999).fill(null));
    expect(snapshotPrivateJson(nodes)).toHaveLength(50); nodes[49].push(null); unavailable(nodes);
  });
  it('bounds each string, including keys, without a smaller RPC-body limit', () => {
    const body = 'a'.repeat(524_288); expect(snapshotPrivateJson(body)).toBe(body); unavailable(body + 'a');
    expect(Object.keys(snapshotPrivateJson({ [body]: null }) as object)).toEqual([body]); unavailable({ [body + 'a']: null });
  });
  it('bounds aggregate text across duplicated RPC bodies and keys', () => {
    const body = 'a'.repeat(524_288), duplicated = [body, body, body, body];
    expect(snapshotPrivateJson(duplicated)).toEqual(duplicated); unavailable([...duplicated, 'x']);
    const keys = Object.fromEntries(['a', 'b', 'c', 'd'].map(end => ['k'.repeat(524_287) + end, null]));
    expect(Object.keys(snapshotPrivateJson(keys) as object)).toHaveLength(4); unavailable({ ...keys, extra: null });
  });
  it('normalizes reflective failures without exposing private exception text', () => {
    const trapped = new Proxy({}, { getPrototypeOf() { throw new Error('SECRET DB/provider detail'); } });
    unavailable(trapped);
    const proxy = Proxy.revocable({}, {}); proxy.revoke(); unavailable(proxy.proxy);
  });
});
