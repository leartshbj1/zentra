import type {Workspace,Payment} from '../src/types';
export function installFinancialDetailFixture(w:Workspace) {
  const base=w.invoices[0],year=new Date().getFullYear();
  const make=(id:string,price:number,extra={})=>({...base,id,number:id,title:`Prestation ${id}`,issueDate:`${year}-09-01`,status:'issued' as const,currency:'CHF',creditedCents:0,lines:[{...base.lines[0],quantity:1,unitPriceCents:price,vatRateBp:810,discountBp:0}],...extra});
  w.invoices=[make('CURRENT',10000,{creditedCents:1081}),make('CREDIT',-1000,{type:'credit_note',originalInvoiceId:'CURRENT'}),make('OLD',20000,{issueDate:`${year-1}-01-01`}),make('EUR',40000,{currency:'EUR'}),make('DRAFT',999999,{status:'draft'}),make('CANCELLED',999999,{status:'cancelled'})];
  w.payments=[{id:'p1',invoiceId:'CURRENT',amountCents:5000},{id:'p2',invoiceId:'CURRENT',amountCents:-500},{id:'p3',invoiceId:'OLD',amountCents:21620}] as Payment[];
}
