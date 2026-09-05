import { FileCheck2, FolderOpen, Receipt } from 'lucide-react';
import { useState } from 'react';
import { desktopApi } from './bridge';
import type { Invoice, Quote, Workspace } from './types';
import { Button, Field, FormActions, Modal, StatusBadge, submitForm } from './ui';
import { addDaysIso, documentTotals, formatMoney, invoicePaid, todayIso } from './utils';
import './QuoteInvoiceFolder.css';

type Act = (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>;

export function QuoteInvoiceFolder({ quote, workspace, busy, close, onOpen, act }: {
  quote: Quote; workspace: Workspace; busy: boolean; close: () => void;
  onOpen: (entity: 'quotes' | 'invoices', document: Quote | Invoice) => void; act: Act;
}) {
  const invoices = workspace.invoices.filter((invoice) => invoice.quoteId === quote.id);
  const ordered = [...invoices].sort((a, b) => (a.type === 'deposit' ? 0 : 1) - (b.type === 'deposit' ? 0 : 1));
  const deposit = invoices.find((invoice) => invoice.type === 'deposit');
  const canComplete = invoices.length === 1 && deposit && deposit.status !== 'cancelled' && !deposit.billingPair;
  const total = documentTotals(quote.lines).totalCents;
  const received = invoices.reduce((sum, invoice) => sum + invoicePaid(invoice.id, workspace.payments), 0);
  const credits = invoices.filter((invoice) => invoice.type === 'credit_note' && invoice.status !== 'draft' && invoice.status !== 'cancelled').reduce((sum, invoice) => sum + documentTotals(invoice.lines).totalCents, 0);
  const project = workspace.projects.find((project) => project.id === quote.projectId);
  return <Modal title={`Dossier ${quote.number || quote.title}`} description={project?.name || quote.title} onClose={close} wide>
    <div className="quote-invoice-folder">
      <div className="quote-invoice-folder__totals">
        <div><span>Montant du devis</span><strong>{formatMoney(total, quote.currency)}</strong></div>
        <div><span>Encaissé</span><strong>{formatMoney(received, quote.currency)}</strong></div>
        <div><span>Reste à encaisser sur le devis</span><strong>{formatMoney(Math.max(0, total + credits - received), quote.currency)}</strong></div>
      </div>
      <button className="quote-invoice-folder__document" onClick={() => onOpen('quotes', quote)}>
        <FileCheck2 size={22}/><span><strong>Devis {quote.number}</strong><small>{quote.title}</small></span><StatusBadge status={quote.status}/>
      </button>
      <div className="quote-invoice-folder__invoices">{ordered.map((invoice) => <article key={invoice.id}>
        <Receipt size={22}/><h3>{invoice.type === 'deposit' ? 'Facture d’acompte' : invoice.billingPair ? 'Facture de solde' : invoice.type === 'credit_note' ? 'Avoir' : 'Facture'}</h3>
        <p>{invoice.number || 'Brouillon · numéro à l’émission'}</p>
        <strong className="quote-invoice-folder__amount">{formatMoney(documentTotals(invoice.lines).totalCents, invoice.currency)}</strong>
        <StatusBadge status={invoice.status}/>
        <p>{invoice.type === 'deposit' ? 'Premier versement prévu au devis.' : invoice.billingPair ? 'Montant du devis, moins l’acompte facturé.' : invoice.title}</p>
        <Button variant="secondary" onClick={() => onOpen('invoices', invoice)}><FolderOpen size={17}/> Ouvrir {invoice.type === 'deposit' ? 'l’acompte' : invoice.billingPair ? 'le solde' : 'la facture'}</Button>
      </article>)}</div>
      {canComplete ? <div className="info-strip"><span>Ce devis possède un acompte, mais sa facture de solde n’a pas encore été créée.</span><Button disabled={busy} onClick={() => void act(() => desktopApi.createQuoteBalance(quote.id), 'La facture de solde a été ajoutée au dossier.', false)}>Créer la facture de solde</Button></div> : null}
      <p className="quote-conversion-note">Chaque facture a son propre numéro et son propre suivi de paiement. La déduction de l’acompte sur le solde ne signifie pas que l’acompte a été payé.</p>
    </div>
  </Modal>;
}

/** Keep the two financial documents consistent while their dates remain editable. */
export function PairedInvoiceEditor({ invoice, workspace, busy, close, onFolder, act }: {
  invoice: Invoice; workspace: Workspace; busy: boolean; close: () => void; onFolder: () => void; act: Act;
}) {
  const [issueDate, setIssueDate] = useState(invoice.issueDate || todayIso());
  const totals = documentTotals(invoice.lines);
  return <Modal title={invoice.type === 'deposit' ? 'Facture d’acompte' : 'Facture de solde'} description={invoice.number || invoice.title} onClose={close} wide>
    <form className="paired-invoice-editor" onSubmit={submitForm(async (form) => {
      await act(() => desktopApi.updateEntity('invoices', invoice.id, {
        issueDate, dueDate: String(form.get('dueDate')), serviceDateFrom: String(form.get('serviceDateFrom')),
        serviceDateTo: String(form.get('serviceDateTo')), notes: String(form.get('notes')),
      }), 'Les dates de la facture ont été enregistrées.');
    })}>
      <div className="info-strip"><span>Les montants sont liés au devis et à l’autre facture du dossier.</span><Button type="button" variant="secondary" onClick={onFolder}><FolderOpen size={17}/> Voir le dossier</Button></div>
      <fieldset disabled={busy} className="document-form"><div className="form-grid">
        <Field label="Date d’émission" required><input type="date" name="issueDate" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} required/></Field>
        <Field label="Échéance" required><input type="date" name="dueDate" min={issueDate} defaultValue={invoice.dueDate || addDaysIso(issueDate, workspace.settings!.billing.paymentTermsDays)} required/></Field>
        <Field label="Début de prestation" required><input type="date" name="serviceDateFrom" defaultValue={invoice.serviceDateFrom} required/></Field>
        <Field label="Fin de prestation"><input type="date" name="serviceDateTo" defaultValue={invoice.serviceDateTo}/></Field>
        <Field label="Notes" wide><textarea name="notes" defaultValue={invoice.notes}/></Field>
      </div></fieldset>
      <ul className="quote-invoice-folder__lines">{invoice.lines.map((line) => <li key={line.id}><span>{line.description}</span><strong>{formatMoney(documentTotals([line]).totalCents, invoice.currency)}</strong></li>)}</ul>
      <div className="quote-invoice-folder__totals"><div><span>Total HT</span><strong>{formatMoney(totals.netCents, invoice.currency)}</strong></div><div><span>TVA</span><strong>{formatMoney(totals.vatCents, invoice.currency)}</strong></div><div><span>{invoice.type === 'deposit' ? 'Acompte TTC' : 'Solde TTC'}</span><strong>{formatMoney(totals.totalCents, invoice.currency)}</strong></div></div>
      <FormActions busy={busy} onCancel={close} submitLabel="Enregistrer les dates"/>
    </form>
  </Modal>;
}
