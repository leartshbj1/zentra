import { lineTotals, type Estimate } from './invoicing';
import { validateAddress } from './addresses';
import { validateBrowserUsTaxInvoiceChoices, type BrowserUsTaxCode, type BrowserUsTaxInvoiceChoices } from './browser-us-tax-invoice-session';

export interface BrowserUsTaxLineChoice { readonly code: string; readonly checked: BrowserUsTaxCode | null; readonly confirmed: boolean }
/** Presentation scope only. Never a provider determination or permission. */
export function browserUsTaxEstimateSupported(estimate: Estimate): boolean {
  try {
    if (estimate.currency !== 'USD' || estimate.status !== 'accepted' || !estimate.lines.length || estimate.lines.length > 100) return false;
    let netTotal = BigInt(0);
    for (const line of estimate.lines) {
      const units = BigInt(line.quantityUnits), scale = BigInt(10) ** BigInt(line.quantityScale), net = BigInt(lineTotals(line, 'USD').net.minorUnits);
      if (line.taxTreatment !== 'taxable' || units <= BigInt(0) || units % scale !== BigInt(0) || units / scale > BigInt(Number.MAX_SAFE_INTEGER) || net <= BigInt(0) || net > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      netTotal += net;
    }
    return netTotal <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch { return false; }
}
export function buildBrowserUsTaxInvoiceChoices(estimate: Estimate, lines: Readonly<Record<string, BrowserUsTaxLineChoice>>, taxDateInstant: string, addressSource: string): BrowserUsTaxInvoiceChoices {
  if (!browserUsTaxEstimateSupported(estimate) || !['billing', 'shipping'].includes(addressSource)) throw new TypeError('Unsupported TEST selection');
  validateAddress(addressSource === 'billing' ? estimate.customer.billingAddress : estimate.customer.shippingAddress, 'US');
  return validateBrowserUsTaxInvoiceChoices({ taxDateInstant, addressSource, classifications: estimate.lines.map(line => { const choice = lines[line.id]; if (!choice?.confirmed || !choice.checked || choice.code !== choice.checked.id) throw new TypeError('Confirm the actual service code'); return { lineId: line.id, taxCode: choice.checked.id, confirmedService: true }; }) });
}
