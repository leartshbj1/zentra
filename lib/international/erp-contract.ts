/** JSON-safe shared contract; no database, session, secret or network imports. */
export class ErpError extends Error {
  constructor(public readonly code: string, public readonly status = 422) { super(code); this.name = 'ErpError'; }
}
export function canonicalErpJson(value: unknown): string {
  const canonical = canonicalErpJson;
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '['+Array.from(value,canonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).filter(key=>(value as Record<string,unknown>)[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
