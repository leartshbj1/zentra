import type { VatReturnPreview } from '../src/types';

/** Synthetic UI counterpart of the native three-rate settlement scenarios. */
export function seedReceivedCreditPreview(preview: VatReturnPreview) {
  const gross = [5405, 5130, 5190];
  const vat = [405, 130, 190];
  const invoiceReference = 'FA-2026-COMPENSATION-FOURNITURES-ET-SERVICES';
  const creditReference = 'AV-2026-RETOUR-DE-MARCHANDISES';
  const descriptions = ['Panneaux acoustiques', 'Livres et documentation', 'Hébergement'];
  const allocations: NonNullable<VatReturnPreview['receivedAllocations']> = [];
  for (const reverse of [false, true]) for (const credit of [false, true]) {
    for (let index = 0; index < 3; index++) {
      const sign = (credit ? -1 : 1) * (reverse ? -1 : 1);
      allocations.push({ sourceType: credit ? 'supplier_credit_note_item' : 'supplier_invoice_item', sourceId: `${credit ? 'credit' : 'invoice'}-line-${index}`, parentId: credit ? 'credit' : 'invoice', description: `${credit ? creditReference : invoiceReference} · ${descriptions[index]}`, currency: 'CHF', paymentId: reverse ? 'settlement-reverse' : 'settlement-apply', date: reverse ? '2026-03-25' : '2026-03-20', grossCents: sign * gross[index], vatCents: sign * vat[index], netCents: sign * (gross[index] - vat[index]), settlement: { kind: reverse ? 'credit_reversal' : 'credit_application', counterpartId: credit ? 'invoice' : 'credit', counterpartReference: credit ? invoiceReference : creditReference, reversesAllocationId: reverse ? 'settlement-apply' : null } });
    }
  }
  for (let index = 0; index < 3; index++) allocations.push({ sourceType: 'supplier_invoice_item', sourceId: `invoice-line-${index}`, parentId: 'invoice', description: `${invoiceReference} · ${descriptions[index]}`, currency: 'CHF', paymentId: 'cash-payment', date: '2026-03-28', grossCents: gross[index], vatCents: vat[index], netCents: gross[index] - vat[index] });
  preview.receivedAllocations = allocations;
  preview.preClosingSources = [];
  preview.classifiedSources = [...new Set(allocations.map((row) => row.sourceId))].map((id) => {
    const rows = allocations.filter((row) => row.sourceId === id);
    const latest = [...rows].sort((left, right) => right.date.localeCompare(left.date))[0];
    const index = Number(id.at(-1));
    return { sourceType: latest.sourceType, sourceId: id, parentId: latest.parentId, occurrenceDate: latest.date, description: latest.description, amountCents: rows.reduce((sum, row) => sum + row.netCents, 0), vatCents: rows.reduce((sum, row) => sum + row.vatCents, 0), vatRateBp: [810, 260, 380][index], treatment: index === 1 ? 'input_investments' : index === 2 ? 'non_deductible' : 'input_materials', currency: 'CHF' };
  });
  preview.sourceCount = 6;
  preview.turnoverComputation.totalConsiderationCents = 0;
  preview.turnoverComputation.taxableTurnoverCents = 0;
  preview.payableTaxCents = -535;
  preview.effectiveReportingMethod!.inputTaxMaterialAndServicesCents = 405;
  preview.effectiveReportingMethod!.inputTaxInvestmentsCents = 130;
  preview.effectiveReportingMethod!.outputTaxCents = 0;
  preview.effectiveReportingMethod!.suppliesPerTaxRate = [];
}
