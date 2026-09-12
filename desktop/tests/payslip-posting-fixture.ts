import { desktopApi } from '../src/bridge';
import { PayslipPostingRefreshError } from '../src/payrollMutation';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import type { Payslip, Workspace } from '../src/types';

export function installPayslipPostingFixture(data: Workspace) {
  const previous = sessionStorage.getItem('qa-posting-store');
  if (previous) Object.assign(data, JSON.parse(previous));
  else data.payslips = ['main','lost','refresh'].map((key,index): Payslip => ({ id:`posting-${key}`,employeeId:index===1?'jean':'elodie',period:`2026-${String(9+index).padStart(2,'0')}`,status:'validated',paymentDate:`2026-${String(9+index).padStart(2,'0')}-28`,notes:'Salaire de recette uniquement',createdAt:'2026-09-13T10:00:00Z',lines:[{id:`gross-${key}`,label:'Salaire mensuel',kind:'earning',amountCents:500000},{id:`deduct-${key}`,label:'Cotisations du collaborateur',kind:'deduction',amountCents:62000},{id:`refund-${key}`,label:'Remboursement de frais',kind:'reimbursement',amountCents:12345},{id:`employer-${key}`,label:'Cotisations de l’entreprise',kind:'employer',amountCents:77000}] }));
  const stored = structuredClone(data);
  stored.accounts = [{id:'social-qa',code:'2270',name:'Cotisations à payer',accountType:'liability',normalBalance:'credit',reportSection:'short_term_liabilities',active:true}];
  desktopApi.getLedger = async accountId => ({ account:(await desktopApi.listAccounts()).find(account=>account.id===accountId)!,lines:[],currency:(await desktopApi.getJournal({})).currency,openingDebitCents:0,openingCreditCents:0,openingDebitBalanceCents:0,openingCreditBalanceCents:0,openingNetDebitCents:0,debitCents:0,creditCents:0,movementNetDebitCents:0,netDebitCents:0,closingDebitBalanceCents:0,closingCreditBalanceCents:0 });
  const record = (key: string, value: unknown) => sessionStorage.setItem(`qa-posting-${key}`, JSON.stringify([...JSON.parse(sessionStorage.getItem(`qa-posting-${key}`) || '[]'),value]));
  const persist = () => sessionStorage.setItem('qa-posting-store',JSON.stringify(stored)); persist();
  desktopApi.loadWorkspace = async () => {
    if (sessionStorage.getItem('qa-posting-block-reads')) throw new Error('Lecture momentanément interrompue.');
    return structuredClone(stored);
  };
  desktopApi.postPayslip = async id => {
    record('attempts',{id});
    if (sessionStorage.getItem('qa-posting-hold')) {
      sessionStorage.setItem('qa-posting-waiting','1');
      while (sessionStorage.getItem('qa-posting-hold')) await new Promise(resolve=>setTimeout(resolve,20));
      sessionStorage.removeItem('qa-posting-waiting');
    }
    const failure=sessionStorage.getItem('qa-posting-refusal'); sessionStorage.removeItem('qa-posting-refusal');
    if (failure) throw new Error(failure);
    const salary=stored.payslips.find(item=>item.id===id)!;
    if (!salary || !['validated','posted'].includes(salary.status)) throw new Error('Seule une fiche validée peut être comptabilisée.');
    if (salary.status==='validated') {
      salary.status='posted';
      salary.snapshot={ capturedAt:'2026-09-13T10:00:00Z',contributionDate:salary.paymentDate,period:salary.period,paymentDate:salary.paymentDate,notes:salary.notes,items:structuredClone(salary.lines),contributions:[],employee:structuredClone(stored.employees.find(item=>item.id===salary.employeeId)!),issuer:structuredClone(stored.settings!.organization) } as Payslip['snapshot'];
      record('writes',{id}); persist();
    }
    const mode=sessionStorage.getItem('qa-posting-mode'); sessionStorage.removeItem('qa-posting-mode');
    if (mode==='lost') throw new Error('Réponse de comptabilisation interrompue.');
    const accountingFallbacks=[{contribution:'Cotisations de recette',field:'liability_account_id',accountId:'social-qa',reason:'Compte général utilisé'}];
    if (mode==='refresh') sessionStorage.setItem('qa-posting-block-reads','1');
    try { return {workspace:await desktopApi.loadWorkspace(),accountingFallbacks}; }
    catch (reason) { throw new PayslipPostingRefreshError(reason,accountingFallbacks); }
  };
  desktopApi.payPayslip=async (id,paymentDate,reference)=>{
    record('payment-attempts',{id,paymentDate,reference});
    const salary=stored.payslips.find(item=>item.id===id)!;
    if(salary.status!=='posted') throw new Error('La fiche doit être comptabilisée avant le paiement.');
    salary.status='paid'; salary.paymentDate=paymentDate || ''; salary.paymentReference=reference; salary.paymentJournalEntryId=`journal-${id}`;
    record('payments',{id,paymentDate,reference}); persist();
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
  Object.assign(window,{__qaPosting:{stored,persist}});
}
