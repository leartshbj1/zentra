import type { AccountingFallback, Payslip, Workspace } from './types';
import { payslipTotals } from './utils';

export type PayslipPostingTarget = 'salary' | 'payroll-settings' | 'accounts' | 'periods' | 'list';
export type PayslipPostingProblem = { title: string; text: string; action: string; target: PayslipPostingTarget };
export type PayslipPostingFeedback = { payslipId: string; accountingFallbacks: AccountingFallback[]; recovered: boolean };

export function payslipPostingSummary(payslip: Payslip) {
  const finalized = payslip.status === 'posted' || payslip.status === 'paid';
  const lines = finalized && payslip.snapshot ? payslip.snapshot.items : payslip.lines;
  const period = finalized && payslip.snapshot ? payslip.snapshot.period : payslip.period;
  return { ...payslipTotals({ ...payslip, lines }), lines, period, entryDate: /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? `${period}-01` : '' };
}

export function payslipPostingPreflight(payslip: Payslip, workspace: Pick<Workspace, 'settings'>): PayslipPostingProblem | null {
  if (['posted','paid'].includes(payslip.status)) return null;
  if (payslip.status !== 'validated') return { title: 'Reprenons le contrôle du salaire', text: 'Cette fiche doit d’abord être calculée et validée. Ouvrez-la, vérifiez le net puis enregistrez la validation.', action: 'Contrôler la fiche', target: 'salary' };
  if (!workspace.settings?.payroll.enabled || !workspace.settings.payroll.fiduciaryValidated) return { title: 'Le contrôle des réglages reste à confirmer', text: 'Faites contrôler les réglages de paie par votre fiduciaire, puis confirmez ce contrôle dans les paramètres. Revenez ensuite à cette fiche.', action: 'Ouvrir les paramètres de paie', target: 'payroll-settings' };
  const summary = payslipPostingSummary(payslip);
  if (!summary.entryDate || !summary.lines.length || summary.lines.some(line => !Number.isSafeInteger(line.amountCents) || line.amountCents < 0) || ![summary.earnings,summary.deductions,summary.reimbursements,summary.employer,summary.net].every(Number.isSafeInteger) || summary.earnings <= 0) return { title: 'Un montant ou le mois est à vérifier', text: 'Rouvrez la fiche pour vérifier le mois et les lignes de salaire, puis recalculez le net. Aucun montant ne sera remplacé automatiquement.', action: 'Revoir le salaire', target: 'salary' };
  return null;
}

export function payslipPostingProblem(message: string): PayslipPostingProblem {
  if (/période.*(ferm|clôtur)|exercice.*(ferm|clôtur)|date.*clôtur|closed.period/i.test(message)) return { title: 'L’exercice de ce salaire est fermé', text: 'Consultez l’exercice concerné avec votre fiduciaire. La date comptable est le premier jour du mois de salaire ; ne changez pas le mois simplement pour contourner la clôture.', action: 'Voir les exercices', target: 'periods' };
  if (/fiduciaire|fiduciary|module.*paie.*désactiv|payroll.enabled|payroll.fiduciary/i.test(message)) return { title: 'Vérifions les réglages de paie', text: 'Vérifiez que la paie est activée et que le contrôle de vos réglages a été confirmé. La confirmation doit correspondre à un contrôle réellement effectué.', action: 'Ouvrir les paramètres de paie', target: 'payroll-settings' };
  if (/compte.*(configur|inacti|introuvable|type|manqu|incorrect)|liaison.*compt|comptabilité.*(configur|activ)|wages_|social_|posting_account|expense_account|liability_account/i.test(message)) return { title: 'Un compte de paie est à régler', text: 'Ouvrez « Plan & liaisons » et vérifiez les comptes de salaires et de cotisations. Revenez ensuite ici pour finaliser la même fiche.', action: 'Vérifier les comptes de paie', target: 'accounts' };
  if (/cotisation|recalcul|base|AVS|AI\/APG|LPP|LAA|AANP|CAF|assurance|valide|validée|totaux|employee|collaborateur|historique|payslip.*item|millésime|réglementaire|preuve/i.test(message)) return { title: 'Le salaire doit être revérifié', text: 'Un réglage ou une ligne ne correspond plus au contrôle enregistré. Reprenez cette fiche : le guide indiquera les informations à compléter et recalculera les montants avant une nouvelle validation.', action: 'Reprendre le contrôle du salaire', target: 'salary' };
  return { title: 'La finalisation n’a pas pu être confirmée', text: 'La fiche reste disponible. Consultez le message complet ci-dessous. Vous pouvez réessayer si l’interruption était temporaire ; une fiche déjà comptabilisée ne sera pas comptabilisée une deuxième fois.', action: 'Revenir aux fiches de salaire', target: 'list' };
}
