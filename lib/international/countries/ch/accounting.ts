import type { Account } from '../../accounting/ledger';

/** New-core starter only. Never replaces or remaps an existing Swiss ledger. */
export const chStarterChart: readonly Account[] = Object.freeze([
  {id:'cash',code:'1020',name:'Banque',type:'asset',cash:true},
  {id:'receivables',code:'1100',name:'Créances clients',type:'asset'},
  {id:'input-tax',code:'1170',name:'Impôt préalable',type:'asset'},
  {id:'inventory',code:'1200',name:'Stock',type:'asset'},
  {id:'fixed-assets',code:'1500',name:'Immobilisations',type:'asset'},
  {id:'payables',code:'2000',name:'Dettes fournisseurs',type:'liability'},
  {id:'tax-payable',code:'2200',name:'TVA due',type:'liability'},
  {id:'deposits',code:'2300',name:'Acomptes clients',type:'liability'},
  {id:'equity',code:'2800',name:'Capital',type:'equity'},
  {id:'sales',code:'3000',name:'Produits des ventes',type:'income'},
  {id:'purchases',code:'5000',name:'Achats et charges',type:'expense'},
  {id:'bank-fees',code:'6940',name:'Frais bancaires',type:'expense'},
].map(account=>Object.freeze(account as Account)));
