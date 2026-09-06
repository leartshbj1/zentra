import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
const invokeMock=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class {},invoke:invokeMock}));
import { desktopApi } from './bridge';
import { CustomerCreditAccountingIssues } from './CustomerCreditAccountingIssues';
import type { CustomerCreditAccountingIssue } from './types';
afterEach(()=>invokeMock.mockReset());
const issue:CustomerCreditAccountingIssue={kind:'missing_posting',settlementId:'event',creditNoteId:'credit',creditNoteNumber:'AVO-2026-001',journalEntryId:null,journalNumber:'',journalAvailable:false,date:'2026-03-01',reference:'Compensation documentée',closedPeriod:true,reason:'Une reprise est requise.'};
describe('contrôles comptables des avoirs clients',()=>{
  it('transmet les preuves et l’état fermé sans perdre les liens du journal',async()=>{
    invokeMock.mockResolvedValue({missing_customer_credit_settlements:2,customer_credit_issues:[{kind:'orphan_journal',settlement_id:null,credit_note_id:null,credit_note_number:null,journal_entry_id:'journal',journal_number:'J-2026-005',journal_available:1,date:'2026-03-10',reference:'Écriture à vérifier',closed_period:1,reason:'Lien absent.'}]});
    const result=await desktopApi.getAccountingContinuity();
    expect(result.missingCustomerCreditSettlements).toBe(2);
    expect(result.customerCreditIssues).toEqual([{kind:'orphan_journal',settlementId:null,creditNoteId:null,creditNoteNumber:'',journalEntryId:'journal',journalNumber:'J-2026-005',journalAvailable:true,date:'2026-03-10',reference:'Écriture à vérifier',closedPeriod:true,reason:'Lien absent.'}]);
  });
  it('affiche une preuve absente sans proposer d’ouvrir une écriture inexistante',()=>{
    const html=renderToStaticMarkup(<CustomerCreditAccountingIssues issues={[issue,{...issue,kind:'invalid_posting',journalEntryId:'missing'}]} busy={false} onOpenJournal={vi.fn()}/>);
    expect(html).toContain('Reprise historique à valider');expect(html).toContain('Preuve à vérifier');expect(html).not.toContain('Voir l’écriture');
  });
  it('limite la première vue et privilégie les dates récentes',()=>{
    const rows=Array.from({length:10},(_,i)=>({...issue,settlementId:String(i),date:`2026-03-${String(i+1).padStart(2,'0')}`,reference:`REF-${i}`}));
    const html=renderToStaticMarkup(<CustomerCreditAccountingIssues issues={rows} busy={false} onOpenJournal={vi.fn()}/>);
    expect(html).toContain('REF-9');expect(html).not.toContain('REF-0');expect(html).toContain('Afficher les 2 suivants');
  });
  it('identifie la preuve bancaire sans proposer une seconde comptabilisation',()=>{
    const html=renderToStaticMarkup(<CustomerCreditAccountingIssues issues={[{...issue,kind:'bank_refund_proof',reason:'Vérifiez le rapprochement dans Banque.'}]} busy={false} onOpenJournal={vi.fn()}/>);
    expect(html).toContain('Preuve bancaire à vérifier');expect(html).toContain('Vérifiez le rapprochement dans Banque.');expect(html).not.toContain('Reprise historique à valider');
  });
});
