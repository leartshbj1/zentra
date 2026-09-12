import { describe, expect, it } from 'vitest';
import { payslipPostingPreflight, payslipPostingProblem, payslipPostingSummary } from './payslipPosting';
import type { Payslip, Workspace } from './types';

const salary: Payslip = { id:'salary', employeeId:'person', period:'2026-09', status:'validated', paymentDate:'2026-09-30', notes:'', createdAt:'2026-09-01', lines:[{id:'gross',label:'Salaire',kind:'earning',amountCents:500000},{id:'deduction',label:'Retenues',kind:'deduction',amountCents:62000},{id:'refund',label:'Frais',kind:'reimbursement',amountCents:12345},{id:'employer',label:'Charges employeur',kind:'employer',amountCents:77000}] };
const workspace = { settings: { payroll: { enabled:true, fiduciaryValidated:true } } } as Workspace;
describe('vérification lisible avant comptabilisation du salaire', () => {
  it('distingue le salaire net, les remboursements et les charges de l’employeur', () => {
    expect(payslipPostingSummary(salary)).toMatchObject({ earnings:500000,deductions:62000,reimbursements:12345,employer:77000,net:450345,entryDate:'2026-09-01' });
    expect(payslipPostingPreflight(salary,workspace)).toBeNull();
  });
  it('utilise les lignes et le mois figés après comptabilisation', () => {
    const posted = { ...salary, status:'posted', period:'2026-10', lines:[], snapshot:{ period:'2026-09',items:salary.lines } } as unknown as Payslip;
    expect(payslipPostingSummary(posted)).toMatchObject({ net:450345,period:'2026-09',entryDate:'2026-09-01' });
    expect(payslipPostingPreflight(posted,{ settings:null })).toBeNull();
  });
  it.each(['draft','incomplete'] as const)('la fiche %s doit être contrôlée', status => expect(payslipPostingPreflight({...salary,status},workspace)?.target).toBe('salary'));
  it.each([{ enabled:false,fiduciaryValidated:true },{enabled:true,fiduciaryValidated:false}])('respecte le contrôle de configuration %j', payroll => expect(payslipPostingPreflight(salary,{settings:{payroll} as Workspace['settings']})?.target).toBe('payroll-settings'));
  it.each(['2026-00','2026-13','2026-9',''])('un mois %s invalide renvoie à la fiche', period => expect(payslipPostingPreflight({...salary,period},workspace)?.target).toBe('salary'));
  it.each([NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])('un montant %s invalide reste à corriger', amountCents => expect(payslipPostingPreflight({...salary,lines:[{...salary.lines[0],amountCents}]},workspace)?.target).toBe('salary'));
  it.each([
    ['La période comptable est fermée.','periods'],
    ['La comptabilité doit être configurée et activée avant de comptabiliser une fiche de salaire.','accounts'],
    ['Le compte de charges salariales doit être configuré.','accounts'],
    ['Compte actif introuvable : 2270','accounts'],
    ['wages_payable_account_id manquant','accounts'],
    ['La cotisation figée ne correspond plus au recalcul.','salary'],
    ['Le salaire annuel LPP doit être renseigné.','salary'],
    ['Seule une fiche au statut valide peut être comptabilisée.','salary'],
    ['Faites valider les réglages par votre fiduciaire.','payroll-settings'],
    ['Interruption de la réponse.','list'],
  ])('guide le refus : %s', (message,target) => expect(payslipPostingProblem(message).target).toBe(target));
});
