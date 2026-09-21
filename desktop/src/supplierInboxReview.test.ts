import { describe, it, expect } from 'vitest';
import { mailboxInvoiceAmounts, mailboxInvoiceDefaults, canPrepareMailboxSupplier } from './supplierInboxReview';
import type { MailInvoice } from './supplierInbox';
import type { Workspace } from './types';

const invoice = { sender:'factures@vendor.test', extraction: { supplierName:'Atelier Étoile SA', category:'software' } } as MailInvoice;
const workspace = { suppliers:[{id:'s',name:'Atelier Etoile SA',email:invoice.sender,archivedAt:null}], accounts:[{id:'6000',active:true,accountType:'expense'}], supplierInvoices:[{supplierId:'s',documentStatus:'validated',lines:[{category:'Logiciels',postedExpenseAccountId:'6000'}]}] } as unknown as Workspace;
describe('Préparation de la confirmation finale',()=>{
  it('distingue un fournisseur fiable d’une catégorie ou d’une TVA incertaine',()=>{
    const item={...invoice,extraction:{...invoice.extraction,kind:'supplier_invoice',confidence:0,kindConfidence:.99,fieldConfidence:{supplierName:.98,vatCents:0}}};
    expect(canPrepareMailboxSupplier(item)).toBe(true);
    expect(canPrepareMailboxSupplier({...item,extraction:{...item.extraction,fieldConfidence:{supplierName:.7}}})).toBe(false);
    expect(canPrepareMailboxSupplier({...item,extraction:{...item.extraction,kind:'other'}})).toBe(false);
    expect(canPrepareMailboxSupplier({...item,extraction:{...item.extraction,kindConfidence:.8}})).toBe(false);
  });
  it('reconnaît un fournisseur unique même sans adresse e-mail et respecte les doublons',()=>{
    const noMail={...workspace,suppliers:[{...workspace.suppliers[0],email:''}]};
    expect(mailboxInvoiceDefaults(invoice,noMail).supplierId).toBe('s');
    const duplicate={...workspace,suppliers:[...noMail.suppliers,{...workspace.suppliers[0],id:'correct'}]};
    expect(mailboxInvoiceDefaults(invoice,duplicate).supplierId).toBe('correct');
  });
  it('reprend le classement validé du fournisseur identifié par son nom et son adresse',()=>{
    expect(mailboxInvoiceDefaults(invoice,workspace)).toEqual({supplierId:'s',category:'Logiciels',accountId:'6000'});
  });
  it('ne confond pas les fournisseurs utilisant la même adresse de facturation',()=>{
    expect(mailboxInvoiceDefaults({...invoice,extraction:{...invoice.extraction,supplierName:'Autre entreprise'}},workspace).supplierId).toBe('');
    expect(mailboxInvoiceDefaults(invoice,{...workspace,suppliers:[...workspace.suppliers,{...workspace.suppliers[0],id:'duplicate'}]}).supplierId).toBe('');
  });
  it('ne reprend pas un compte historique quand la nature de l’achat change',()=>{
    expect(mailboxInvoiceDefaults({...invoice,extraction:{...invoice.extraction,category:'rent'}},workspace).accountId).toBe('');
  });
  it('réutilise le choix confirmé de cette entreprise même si le nom enregistré diffère',()=>{
    const habit={id:'h',sender:invoice.sender,supplierName:'atelieretoilesa',supplierId:'s',category:'Prestations de services',accountId:'6000',updatedAt:1};
    expect(mailboxInvoiceDefaults(invoice,{...workspace,suppliers:[{...workspace.suppliers[0],name:'Mon prestataire'}]},[habit])).toEqual({supplierId:'s',category:'Prestations de services',accountId:'6000'});
    expect(mailboxInvoiceDefaults(invoice,workspace,[{...habit,sender:'other@test.ch'}]).category).toBe('Logiciels');
    expect(mailboxInvoiceDefaults(invoice,{...workspace,suppliers:[]},[habit]).supplierId).toBe('');
    expect(mailboxInvoiceDefaults(invoice,{...workspace,accounts:[]},[habit]).accountId).toBe('');
  });
  it('écarte les comptes inactifs et les brouillons',()=>{
    expect(mailboxInvoiceDefaults(invoice,{...workspace,accounts:[]}).accountId).toBe('');
    expect(mailboxInvoiceDefaults(invoice,{...workspace,supplierInvoices:[{...workspace.supplierInvoices[0],documentStatus:'draft'}]}).accountId).toBe('');
  });
  it.each(['',' ','1e3','-1','NaN','Infinity','2.345'])('refuse le montant incomplet ou ambigu %s',net=>{
    expect(mailboxInvoiceAmounts(net,'8.1')).toBeNull();
  });
  it('ne transforme pas un taux vide en zéro et arrondit comme le moteur comptable',()=>{
    expect(mailboxInvoiceAmounts('100','')).toBeNull();
    expect(mailboxInvoiceAmounts('100,05','8,1')).toEqual({netCents:10005,vatBp:810,vatCents:810,totalCents:10815});
    expect(mailboxInvoiceAmounts('0.5','1')).toEqual({netCents:50,vatBp:100,vatCents:1,totalCents:51});
  });
});
