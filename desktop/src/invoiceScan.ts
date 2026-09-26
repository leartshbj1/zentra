import type { Workspace } from './types';
import { newPurchaseLine, type PurchaseFields } from './supplierInvoicePreparation';
import { isSalesDate } from './salesFormValidation';

export type InvoiceScan = {
  kind: 'supplier_invoice' | 'other' | 'unknown'; supplierName: string | null;
  reference: string | null; invoiceDate: string | null; dueDate: string | null;
  currency: string | null; netCents: number | null; vatCents: number | null; totalCents: number | null; vatBp: number | null;
  issues: string[]; confidence: number; evidence: Record<string,string>;
};
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 1e9;
export function consistentScanAmounts(scan: InvoiceScan) {
  const { netCents:n, vatCents:v, totalCents:t, vatBp:bp } = scan;
  return scan.currency === 'CHF' && integer(n) && n > 0 && integer(v) && integer(t) && integer(bp) && [0,260,380,810].includes(bp)
    && n+v === t && Number((BigInt(n)*BigInt(bp)+5000n)/10000n) === v;
}
export function applyInvoiceScan(scan: InvoiceScan, previous: PurchaseFields, workspace: Workspace): PurchaseFields {
  if (scan.kind !== 'supplier_invoice') throw Error('Ce document n’est pas identifié comme une facture fournisseur. Saisissez-le manuellement.');
  if (scan.currency !== 'CHF') throw Error('Vérifiez la devise et saisissez manuellement les montants en francs.');
  const name = (v: string) => v.trim().normalize('NFKC').toLocaleLowerCase('fr-CH').replace(/\s+/g,' ');
  const suppliers = workspace.suppliers.filter(s=>!s.archivedAt && scan.supplierName && name(s.name)===name(scan.supplierName));
  const line = newPurchaseLine(workspace);
  return {...previous,
    supplierId: suppliers.length === 1 ? suppliers[0].id : '',
    reference: scan.reference?.slice(0,200) || '',
    date: scan.invoiceDate && isSalesDate(scan.invoiceDate) ? scan.invoiceDate : '',
    dueDate: scan.dueDate && isSalesDate(scan.dueDate) ? scan.dueDate : '',
    // Never infer deductibility from a printed tax rate. The purchase/VAT engine decides.
    vatTreatment: '',
    lines: consistentScanAmounts(scan) ? [{...line,description:`Facture ${scan.reference || ''}`.trim(),quantity:'1',unit:'forfait',price:(scan.netCents! / 100).toFixed(2),vatBp:scan.vatBp!}] : [{...line,price:''}],
  };
}

export async function readInvoiceText(file: File, progress: (text:string)=>void) {
  if (!file.size || file.size > 20 * 1024 * 1024) throw Error('Choisissez un PDF ou une photo de moins de 20 Mo.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '', images: string[] = [];
  if (/\.pdf$/i.test(file.name)) {
    const { extractPayrollPdfTextByPage } = await import('./payrollPdfText');
    const parsed=await extractPayrollPdfTextByPage(bytes.slice(),12);
    if (parsed.pageCount>12) throw Error('Cette facture dépasse 12 pages. Saisissez-la manuellement.');
    if (parsed.pages.every(page=>page.replace(/\s/g,'').length>=40)) text=parsed.pages.join('\n');
    else {
      if(parsed.pageCount>4) throw Error('Ce PDF scanné dépasse 4 pages. Choisissez une version avec du texte ou saisissez les informations.');
      progress('Lecture des pages…');
      const { renderPdfPages }=await import('./localPdfPreview');
      images=(await renderPdfPages(bytes.slice(),4)).pages;
    }
  } else if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
    const { prepareImageForAnalysis }=await import('./localPdfPreview');
    const url=URL.createObjectURL(file);
    try { images=[await prepareImageForAnalysis(url)]; } finally { URL.revokeObjectURL(url); }
  } else throw Error('Choisissez un PDF ou une photo PNG, JPEG ou WebP.');
  if(images.length){
    progress('Lecture de la photo…');
    const { readPayslipImages }=await import('./payrollOcr');
    text=(await readPayslipImages(images,new URL('.',document.baseURI).href,()=>{})).text;
  }
  if(text.trim().length<40) throw Error('Le document est trop peu lisible. Prenez une photo plus nette ou saisissez les informations.');
  if(text.length>40000 || text.split('\n').length>1000 || new TextEncoder().encode(text).length>80000) throw Error('Ce document contient trop de texte. Choisissez une facture plus courte ou saisissez-la manuellement.');
  return text;
}
