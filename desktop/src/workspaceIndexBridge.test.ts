import { expect, it, vi } from 'vitest';
import { runtimeVolumeFixture } from '../tests/runtime-volume-fixture';
const invoke = vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke}));
import { desktopApi } from './bridge';

it('keeps every document line ordered and isolated during reloads and company changes', async()=>{
  let raw=runtimeVolumeFixture(8);
  invoke.mockImplementation(async command=>command==='get_app_state'?{onboarding_completed:true}:raw);
  // Interleave source records and add an orphan; source order must stay untouched.
  for(const key of ['quote_items','invoice_items','payslip_items','supplier_invoice_items','sales_order_lines','delivery_note_lines','supplier_order_lines','supplier_receipt_lines','supplier_credit_note_items']) raw[key].reverse();
  raw.invoice_items.push({id:'orphan',invoice_id:'missing',position:0});
  const before=JSON.stringify(raw);
  const workspace=await desktopApi.loadWorkspace();
  for(const key of ['quotes','invoices','payslips','supplierInvoices','salesOrders','deliveryNotes','supplierOrders','supplierReceipts','supplierCreditNotes'] as const) {
    for(const [index,document] of workspace[key].entries()) {
      const lines='lines' in document?document.lines:document.items;
      expect(lines.map(line=>line.id)).toEqual(Array.from({length:8},(_,position)=>`${document.id}-line-${7-position}`));
      expect(document.id.endsWith(`-${index}`)).toBe(true);
    }
  }
  expect(JSON.stringify(raw)).toBe(before);
  raw=runtimeVolumeFixture(1);
  raw.invoice_items[0].description='Nouvel espace';
  raw.invoice_items[0].unit_price_cents=12345;
  const next=await desktopApi.loadWorkspace();
  expect(next.invoices).toHaveLength(1);
  expect(next.invoices[0].lines[7]).toMatchObject({description:'Nouvel espace',unitPriceCents:12345});
  expect(workspace.invoices).toHaveLength(8);
  expect(workspace.invoices[0].lines[7].unitPriceCents).toBe(10000);
});
