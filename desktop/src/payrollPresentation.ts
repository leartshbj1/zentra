export type PayrollTextValue = string | number | PayrollText | { kind: 'money'; cents: number } | { kind: 'number'; value: number; maximumFractionDigits?: number };
export type PayrollText = { source: string; values?: Record<string, PayrollTextValue> };
export type PayrollPresentationRegistry = Map<string, PayrollText>;
type Translate = (source: string, values: Record<string, string>) => string;

const originalText: Translate = (source, values) => source.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

/** Render only explicit message parameters. Plain strings, including document references, remain literal. */
export function renderPayrollText(message: PayrollText, locale: string, translate: Translate = originalText): string {
  const values = Object.fromEntries(Object.entries(message.values ?? {}).map(([key, value]) => {
    if (typeof value !== 'object') return [key, String(value)];
    if ('source' in value) return [key, renderPayrollText(value, locale, translate)];
    return [key, value.kind === 'money'
      ? (value.cents / 100).toLocaleString(locale, { style: 'currency', currency: 'CHF' })
      : value.value.toLocaleString(locale, value.maximumFractionDigits === undefined ? undefined : { maximumFractionDigits: value.maximumFractionDigits })];
  }));
  return translate(message.source, values);
}

/** Preserve the canonical French diagnostic exactly; its optional presentation is separate from rule evaluation. */
export function payrollMessage(registry: PayrollPresentationRegistry | undefined, source: string, values: Record<string, PayrollTextValue>): string {
  const message = { source, values };
  const original = renderPayrollText(message, 'fr-CH');
  registry?.set(original, message);
  return original;
}

export function payrollText(registry: PayrollPresentationRegistry | undefined, original: string): PayrollText {
  return registry?.get(original) ?? { source: original };
}
