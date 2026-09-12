import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileText, LockKeyhole } from 'lucide-react';
import type { Payslip, Workspace } from './types';
import { Button, Modal } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import { payslipPostingPreflight, payslipPostingProblem, payslipPostingSummary, type PayslipPostingFeedback, type PayslipPostingTarget } from './payslipPosting';
import './payslip-posting.css';

export function PayslipPostingDialog({ payslip, workspace, busy, readOnly, close, onConfirm, onResolve, onPayment, onPreview, feedback }: {
  payslip: Payslip; workspace: Workspace; busy: boolean; readOnly: boolean; close: () => void;
  onConfirm: (payslip: Payslip) => Promise<void>; feedback: PayslipPostingFeedback | null;
  onResolve: (target: PayslipPostingTarget) => void; onPayment: () => void; onPreview: () => void;
}) {
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const fallbacks = feedback?.payslipId === payslip.id ? feedback.accountingFallbacks : [];
  const accountLabel = (id: string) => { const account = workspace.accounts.find(item => item.id === id); return account ? `${account.code} · ${account.name}` : 'compte général à retrouver dans les liaisons'; };
  const inFlight = useRef(false), problemRef = useRef<HTMLDivElement>(null);
  const locked = busy || saving;
  const complete = payslip.status === 'posted' || payslip.status === 'paid';
  const preflight = payslipPostingPreflight(payslip, workspace);
  const problem = preflight || (error && !complete ? payslipPostingProblem(error) : null);
  const summary = payslipPostingSummary(payslip);
  const employee = complete && payslip.snapshot ? payslip.snapshot.employee : workspace.employees.find(person => person.id === payslip.employeeId);
  const periodLabel = summary.entryDate ? new Intl.DateTimeFormat('fr-CH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${summary.entryDate}T12:00:00Z`)) : summary.period;
  useEffect(() => {
    if (!error || locked || !problemRef.current) return;
    const node = problemRef.current, actions = node.closest('form')?.querySelector('.form-actions');
    node.style.scrollMarginBlockEnd = `${(actions?.getBoundingClientRect().height || 0) + 20}px`;
    node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'center' });
  }, [error, locked]);
  return <Modal title={complete ? 'La fiche est en comptabilité' : 'Finaliser la fiche'} description={`${employee?.name || 'Collaborateur'} · ${periodLabel}`} onClose={close} dismissible={!locked} className="payslip-posting-modal">
    <form className="payslip-posting" onSubmit={async event => {
      event.preventDefault();
      if (locked || readOnly || complete || preflight || inFlight.current) return;
      inFlight.current = true; setSaving(true); setError('');
      try { await onConfirm(payslip); }
      catch (reason) { setError(errorMessage(reason, 'La finalisation n’a pas pu être confirmée.')); }
      finally { inFlight.current = false; setSaving(false); }
    }}>
      {problem && <div className="payslip-posting__problem" role="alert" tabIndex={-1} ref={problemRef}><strong>{problem.title}</strong><p>{problem.text}</p><Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve(problem.target)}>{problem.action}</Button>{error && <details><summary>Voir le message complet</summary><p>{error}</p></details>}</div>}
      <div className="payslip-posting__net"><span>{payslip.status === 'paid' ? 'Net enregistré comme payé' : 'Net à verser au collaborateur'}</span><strong>{formatMoney(summary.net)}</strong><p>Le brut, moins les retenues, plus les remboursements éventuels.</p></div>
      <dl className="payslip-posting__summary">
        <div><dt>Salaire brut</dt><dd>{formatMoney(summary.earnings)}</dd></div>
        <div><dt>Retenues sur le salaire</dt><dd>− {formatMoney(summary.deductions)}</dd></div>
        <div><dt>Remboursements de frais</dt><dd>+ {formatMoney(summary.reimbursements)}</dd></div>
        <div><dt>Charges de l’employeur</dt><dd>{formatMoney(summary.employer)}</dd></div>
        {!complete && <div><dt>Date comptable</dt><dd>{summary.entryDate ? formatDate(summary.entryDate) : 'Mois à vérifier'}</dd></div>}
        <div><dt>{payslip.status === 'paid' ? 'Date du paiement enregistré' : 'Date de paiement prévue'}</dt><dd>{payslip.paymentDate ? formatDate(payslip.paymentDate) : 'À renseigner lors du paiement'}</dd></div>
      </dl>
      <details className="payslip-posting__lines"><summary>Relire les lignes du salaire ({summary.lines.length})</summary><ul>{summary.lines.map(line => <li key={line.id}><span>{line.label}<small>{line.kind === 'employer' ? 'À la charge de l’entreprise' : line.kind === 'deduction' ? 'Retenue sur le salaire' : line.kind === 'reimbursement' ? 'Remboursement' : 'Salaire'}</small></span><strong>{formatMoney(line.amountCents)}</strong></li>)}</ul></details>
      {complete ? <div className="payslip-posting__result" role="status"><CheckCircle2 size={22} /><div><strong>{payslip.status === 'paid' ? 'Le paiement est déjà enregistré.' : 'Le salaire est enregistré et verrouillé.'}</strong><p>{payslip.status === 'paid' ? 'Vous pouvez consulter la fiche et son PDF.' : 'Effectuez le virement depuis votre banque. Une fois le paiement réalisé, indiquez sa date dans Zentra.'}</p></div></div> : <div className="payslip-posting__explanation"><LockKeyhole size={22} /><div><strong>Ce que fait la confirmation</strong><p>Zentra enregistre le salaire et les cotisations en comptabilité, puis verrouille cette fiche. Aucun virement bancaire n’est envoyé.</p><p>Les charges de l’employeur sont comptabilisées séparément : elles ne diminuent pas le net du collaborateur.</p></div></div>}
      {complete && fallbacks.length > 0 && <div className="payslip-posting__problem" role="status"><strong>Des comptes généraux ont été utilisés</strong><p>Le salaire est enregistré. Vérifiez ces liaisons dans la comptabilité :</p><ul>{fallbacks.map((fallback, index) => <li key={index}>{fallback.contribution || 'Cotisation'} : {accountLabel(fallback.accountId)}{fallback.reason ? ` — ${fallback.reason}` : ''}</li>)}</ul><Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve('accounts')}>Vérifier les comptes de paie</Button></div>}
      {complete && feedback?.payslipId === payslip.id && feedback.recovered && <div className="payslip-posting__problem" role="status"><strong>L’enregistrement a été retrouvé</strong><p>La réponse initiale s’est interrompue, mais la fiche est bien en comptabilité. Consultez l’écriture pour vérifier les comptes utilisés.</p><Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve('accounts')}>Vérifier les comptes de paie</Button></div>}
      {readOnly && !complete && <p className="payslip-posting__readonly">Vous pouvez relire la fiche. Un accès en écriture est nécessaire pour la finaliser.</p>}
      <div className="form-actions">
        <Button type="button" variant="secondary" disabled={locked} onClick={close}>{complete ? 'Fermer' : 'Plus tard'}</Button>
        {complete ? <><Button type="button" variant="secondary" disabled={locked} onClick={onPreview}><FileText size={17} /> Voir la fiche et le PDF</Button>{payslip.status === 'posted' && <Button type="button" disabled={locked || readOnly} onClick={onPayment}>Le virement est fait</Button>}</> : <><Button type="button" variant="ghost" disabled={locked || readOnly} onClick={() => onResolve('salary')}>Revoir la fiche</Button><Button type="submit" disabled={locked || readOnly || !!preflight}>{locked ? 'Enregistrement…' : error ? 'Réessayer l’enregistrement' : 'Enregistrer en comptabilité'}</Button></>}
      </div>
    </form>
  </Modal>;
}
