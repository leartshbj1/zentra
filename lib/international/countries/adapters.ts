import type { CountryCode } from '../types';
import { chStarterChart } from './ch/accounting';
import { usStarterChart } from './us/accounting';
import { canonicalErpJson } from '../erp-contract';

// CH retains its existing assessment identity byte for byte. New US requests
// use canonical JSON because durable JSONB/canonical storage reorders objects;
// property insertion order is not a change to customer or tax facts.
const swissTaxFingerprint = (value: unknown): string => JSON.stringify(value);
const exactTaxFingerprint = (expected: string, stored: string): boolean => expected === stored;
const historicalUsTaxFingerprint = (expected: string, stored: string): boolean => {
  if (expected === stored) return true;
  // Read-only compatibility with the original JSON.stringify US identity.
  // Accept property order only, not duplicate keys, whitespace/escape variants,
  // extra data or a change in location/net/revision/date. Never used for issuing.
  if (typeof stored !== 'string' || stored.length !== expected.length) return false;
  try { const parsed: unknown = JSON.parse(stored); return JSON.stringify(parsed) === stored && canonicalErpJson(parsed) === expected; }
  catch { return false; }
};

const adapters=Object.freeze({
  CH:Object.freeze({country:'CH' as const,taxSystem:'swiss-vat' as const,taxLabel:'TVA',estimateLabel:'Devis',invoiceLabel:'Facture',creditNoteLabel:'Avoir',paymentDocument:'swiss-qr' as const,serializeTaxFingerprint:swissTaxFingerprint,historicalTaxFingerprintMatches:exactTaxFingerprint,acceptedTaxSources:Object.freeze(['swiss-vat','documented-exemption']),starterChart:chStarterChart,banking:Object.freeze({currency:'CHF',methods:Object.freeze(['bank-transfer']),sensitiveDetails:'external-reference-only'})}),
  US:Object.freeze({country:'US' as const,taxSystem:'sales-tax' as const,taxLabel:'Sales tax',estimateLabel:'Estimate',invoiceLabel:'Invoice',creditNoteLabel:'Credit memo',paymentDocument:'us-payment-instructions' as const,serializeTaxFingerprint:canonicalErpJson,historicalTaxFingerprintMatches:historicalUsTaxFingerprint,acceptedTaxSources:Object.freeze(['external-provider','documented-exemption']),starterChart:usStarterChart,banking:Object.freeze({currency:'USD',methods:Object.freeze(['credit-card','ach','bank-transfer']),sensitiveDetails:'external-reference-only'})}),
});
export function nationalAdapter(country:CountryCode) {
  if (!Object.hasOwn(adapters,country)) throw new TypeError('Unsupported national adapter');
  return adapters[country];
}
