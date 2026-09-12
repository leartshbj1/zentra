import { useEffect, useRef, useState } from 'react';
import type { Invoice, Workspace } from './types';
import { Button, Modal } from './ui';
import { documentTotals, errorMessage, formatDate, formatMoney } from './utils';
import { invoiceIssuePreflight, invoiceIssueProblem, type InvoiceIssueTarget } from './invoiceIssueHelp';
import './invoice-issue.css';

export function InvoiceIssueDialog({ invoice, workspace, busy, readOnly, close, onConfirm, onResolve }: {
  invoice: Invoice; workspace: Workspace; busy: boolean; readOnly: boolean; close: () => void;
  onConfirm: (invoice: Invoice) => Promise<void>; onResolve: (target: InvoiceIssueTarget) => void;
}) {
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const inFlight = useRef(false), problemRef = useRef<HTMLDivElement>(null);
  const locked = busy || saving;
  const preflight = invoiceIssuePreflight(invoice, workspace);
  const problem = preflight || (error ? invoiceIssueProblem(error) : null);
  const total = documentTotals(invoice.lines);
  const name = invoice.type === 'credit_note' ? 'l’avoir' : invoice.type === 'deposit' ? 'l’acompte' : invoice.billingPair ? 'le solde' : 'la facture';
  const client = workspace.clients.find(row => row.id === invoice.clientId);
  useEffect(() => {
    if (!error || locked || !problemRef.current) return;
    const node = problemRef.current;
    const actions = node.closest('form')?.querySelector('.form-actions');
    node.style.scrollMarginBlockEnd = `${(actions?.getBoundingClientRect().height || 0) + 20}px`;
    node.focus(); node.scrollIntoView({ block: 'nearest' });
  }, [error, locked]);
  return <Modal title={`Émettre ${name}`} description={invoice.title} onClose={close} dismissible={!locked} className="invoice-issue-modal">
    <form className="invoice-issue" onSubmit={async event => {
      event.preventDefault();
      if (locked || readOnly || preflight || inFlight.current) return;
      inFlight.current = true; setSaving(true); setError('');
      try { await onConfirm(invoice); }
      catch (reason) { setError(errorMessage(reason, 'L’émission n’a pas pu être terminée.')); }
      finally { inFlight.current = false; setSaving(false); }
    }}>
      {problem && <div className="invoice-issue__problem" role="alert" tabIndex={-1} ref={problemRef}><strong>{problem.title}</strong><p>{problem.text}</p><Button type="button" variant="secondary" disabled={locked} onClick={() => onResolve(problem.target)}>{problem.action}</Button>{problem.target === 'periods' && <Button type="button" variant="ghost" disabled={locked} onClick={() => onResolve('dates')}>Corriger la date du brouillon</Button>}{error && <details><summary>Voir le message complet</summary><p>{error}</p></details>}</div>}
      <div className="invoice-issue__total"><span>{invoice.type === 'credit_note' ? 'Montant de l’avoir' : 'Total à facturer'}</span><strong>{formatMoney(total.totalCents, invoice.currency)}</strong><p>La confirmation attribue un numéro et rend ce document non modifiable.</p></div>
      <dl className="invoice-issue__summary">
        <div><dt>Client</dt><dd>{client?.name || 'Client indisponible'}</dd></div>
        <div><dt>Date d’émission</dt><dd>{invoice.issueDate ? formatDate(invoice.issueDate) : 'À compléter'}</dd></div>
        {invoice.type !== 'credit_note' && <div><dt>Paiement au plus tard le</dt><dd>{invoice.dueDate ? formatDate(invoice.dueDate) : 'À compléter'}</dd></div>}
        <div><dt>Prestation</dt><dd>{invoice.serviceDateFrom ? `${formatDate(invoice.serviceDateFrom)}${invoice.serviceDateTo && invoice.serviceDateTo !== invoice.serviceDateFrom ? ` — ${formatDate(invoice.serviceDateTo)}` : ''}` : 'À compléter'}</dd></div>
        <div><dt>Hors TVA</dt><dd>{formatMoney(total.netCents, invoice.currency)}</dd></div>
        <div><dt>TVA</dt><dd>{formatMoney(total.vatCents, invoice.currency)}</dd></div>
      </dl>
      <details className="invoice-issue__lines"><summary>Relire les prestations ({invoice.lines.length})</summary><ul>{invoice.lines.map(line => <li key={line.id}><span>{line.description}</span><strong>{formatMoney(documentTotals([line]).totalCents, invoice.currency)}</strong></li>)}</ul></details>
      <p className="invoice-issue__note">Relisez les informations avant de confirmer. Aucun e-mail n’est envoyé par ce bouton.</p>
      {invoice.type === 'deposit' && <p className="invoice-issue__note">Émettre l’acompte ne signifie pas qu’il a été payé. Enregistrez le paiement après réception de l’argent.</p>}
      {readOnly && <p className="invoice-issue__note">L’application est en lecture seule. Vous pouvez consulter le document ; son émission demande un accès en écriture.</p>}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={close}>Revenir sans émettre</Button><Button type="submit" disabled={locked || readOnly || Boolean(preflight)}>{locked ? 'Émission en cours…' : `Confirmer et émettre ${name}`}</Button></div>
    </form>
  </Modal>;
}
