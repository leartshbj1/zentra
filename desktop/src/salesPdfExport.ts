export type SalesPdfEntity = 'quotes' | 'invoices';

export function pdfDestinationPath(selected: string): string {
  return selected.toLocaleLowerCase('fr-CH').endsWith('.pdf')
    ? selected
    : `${selected}.pdf`;
}

export function salesPdfInvokeInput(
  entity: SalesPdfEntity,
  documentId: string,
  destinationPath: string,
) {
  return {
    input: {
      entity,
      document_id: documentId,
      destination_path: destinationPath,
    },
  };
}

export function salesPdfSuggestedFileName(
  entity: SalesPdfEntity,
  number: string,
  creditNote = false,
): string {
  const prefix =
    entity === 'quotes' ? 'Devis' : creditNote ? 'Avoir' : 'Facture';
  const safeNumber = (number || 'brouillon')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${prefix}_${safeNumber || 'brouillon'}.pdf`;
}
