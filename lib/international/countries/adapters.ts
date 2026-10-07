import type { CountryCode } from '../types';
import { chStarterChart } from './ch/accounting';
import { usStarterChart } from './us/accounting';

const adapters=Object.freeze({
  CH:Object.freeze({country:'CH' as const,taxSystem:'swiss-vat' as const,taxLabel:'TVA',estimateLabel:'Devis',invoiceLabel:'Facture',creditNoteLabel:'Avoir',paymentDocument:'swiss-qr' as const,acceptedTaxSources:Object.freeze(['swiss-vat','documented-exemption']),starterChart:chStarterChart,banking:Object.freeze({currency:'CHF',methods:Object.freeze(['bank-transfer']),sensitiveDetails:'external-reference-only'})}),
  US:Object.freeze({country:'US' as const,taxSystem:'sales-tax' as const,taxLabel:'Sales tax',estimateLabel:'Estimate',invoiceLabel:'Invoice',creditNoteLabel:'Credit memo',paymentDocument:'us-payment-instructions' as const,acceptedTaxSources:Object.freeze(['external-provider','documented-exemption']),starterChart:usStarterChart,banking:Object.freeze({currency:'USD',methods:Object.freeze(['credit-card','ach','bank-transfer']),sensitiveDetails:'external-reference-only'})}),
});
export function nationalAdapter(country:CountryCode) {
  if (!Object.hasOwn(adapters,country)) throw new TypeError('Unsupported national adapter');
  return adapters[country];
}
