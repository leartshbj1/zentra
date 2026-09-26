import { expect,it } from 'vitest';
import type { Workspace } from './types';
import { applyInvoiceScan,consistentScanAmounts,type InvoiceScan } from './invoiceScan';
import { purchaseFields,purchaseTotals } from './supplierInvoicePreparation';
const workspace={settings:{organization:{vatRegistered:false},billing:{paymentTermsDays:30,vatRatesBp:[810,260,0]},work:{costCategories:['Fournitures']}},suppliers:[{id:'one',name:'Acme SA',paymentTermsDays:30,archivedAt:null}]} as unknown as Workspace;
const scan:InvoiceScan={kind:'supplier_invoice',supplierName:'ACME SA',reference:'INV-42',invoiceDate:'2026-09-20',dueDate:'2026-10-20',currency:'CHF',netCents:10000,vatCents:810,totalCents:10810,vatBp:810,issues:[],confidence:.99,evidence:{}};
it('prepares reviewed facts and exact amounts without granting input-tax recovery',()=>{
 const fields=applyInvoiceScan(scan,purchaseFields(workspace),workspace);
 expect(fields).toMatchObject({supplierId:'one',reference:'INV-42',vatTreatment:''});
 expect(purchaseTotals(fields.lines)).toEqual({netCents:10000,vatCents:810,totalCents:10810});
 expect(workspace.settings?.organization.vatRegistered).toBe(false);
});
it.each([{vatCents:811},{currency:'EUR'},{vatBp:500},{netCents:-100},{totalCents:null},{netCents:1.5}])('does not silently import inconsistent amounts %j',patch=>{
 const changed={...scan,...patch};expect(consistentScanAmounts(changed)).toBe(false);
 if(changed.currency==='CHF')expect(applyInvoiceScan(changed,purchaseFields(workspace),workspace).lines[0].price).toBe('');
 else expect(()=>applyInvoiceScan(changed,purchaseFields(workspace),workspace)).toThrow();
});
it('keeps missing dates and ambiguous suppliers blank instead of old defaults',()=>{
 const ambiguous={...workspace,suppliers:[...workspace.suppliers,{...workspace.suppliers[0],id:'two'}]};
 expect(applyInvoiceScan({...scan,invoiceDate:null,dueDate:null},purchaseFields(workspace),ambiguous)).toMatchObject({supplierId:'',date:'',dueDate:''});
 expect(()=>applyInvoiceScan({...scan,kind:'other'},purchaseFields(workspace),workspace)).toThrow();
});
