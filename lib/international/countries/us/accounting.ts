import type { Account } from '../../accounting/ledger';

/** Starter chart, not a mandated chart or an assertion of US GAAP certification. */
export const usStarterChart: readonly Account[] = Object.freeze([
  {id:'cash',code:'1000',name:'Cash and bank',type:'asset',cash:true},
  {id:'receivables',code:'1100',name:'Accounts receivable',type:'asset'},
  {id:'inventory',code:'1200',name:'Inventory',type:'asset'},
  {id:'fixed-assets',code:'1500',name:'Property and equipment',type:'asset'},
  {id:'payables',code:'2000',name:'Accounts payable',type:'liability'},
  {id:'tax-payable',code:'2100',name:'Sales tax payable',type:'liability'},
  {id:'deposits',code:'2300',name:'Customer deposits',type:'liability'},
  {id:'equity',code:'3000',name:'Owner equity',type:'equity'},
  {id:'sales',code:'4000',name:'Sales revenue',type:'income'},
  {id:'purchases',code:'5000',name:'Purchases and operating expenses',type:'expense'},
  {id:'bank-fees',code:'6100',name:'Bank and payment fees',type:'expense'},
].map(account=>Object.freeze(account as Account)));
