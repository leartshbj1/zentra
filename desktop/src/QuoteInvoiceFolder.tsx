import { FileCheck2, FolderOpen, Receipt } from 'lucide-react';
import { useState } from 'react';
import { desktopApi } from './bridge';
import type { Invoice, Quote, Workspace } from './types';
import { Button, ErrorPanel, Field, FormActions, Modal, StatusBadge, submitForm } from './ui';
import { addDaysIso, documentTotals, errorMessage, formatMoney, invoicePaid, todayIso } from './utils';
import { invoiceDatesError } from './salesFormValidation';
import './QuoteInvoiceFolder.css';

type Act = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;

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
export function PairedInvoiceEditor({ invoice, workspace, busy, readOnly = false, close, onFolder, act }: {
  invoice: Invoice; workspace: Workspace; busy: boolean; readOnly?: boolean; close: () => void; onFolder: () => void; act: Act;
}) {
  const [initial] = useState(() => ({
    issueDate: invoice.issueDate || todayIso(),
    dueDate: invoice.dueDate || addDaysIso(invoice.issueDate || todayIso(), workspace.settings!.billing.paymentTermsDays),
    serviceDateFrom: invoice.serviceDateFrom || '', serviceDateTo: invoice.serviceDateTo || '', notes: invoice.notes || '',
  }));
  const [fields, setFields] = useState(initial);
  const [localError, setLocalError] = useState('');
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  async function save(openFolder = false) {
    if (busy || readOnly) return;
    const error = invoiceDatesError(fields);
    if (error) { setLocalError(error); return; }
    setLocalError('');
    const saved = await act(() => desktopApi.updateEntity('invoices', invoice.id, fields),
      'Les dates et les notes de la facture ont été enregistrées.', !openFolder,
      reason => setLocalError(errorMessage(reason, 'Les modifications n’ont pas pu être enregistrées. Votre saisie est conservée.')));
    if (saved && openFolder) onFolder();
  }
  const change = (name: keyof typeof fields, value: string) => { setFields(previous => ({ ...previous, [name]: value })); setLocalError(''); };
  const totals = documentTotals(invoice.lines);
  return <Modal title={invoice.type === 'deposit' ? 'Facture d’acompte' : 'Facture de solde'} description={invoice.number || invoice.title} onClose={close} dismissible={!busy} wide>
    <form className="paired-invoice-editor" noValidate onSubmit={submitForm(async () => save())}>
      <div className="info-strip"><span>Les montants sont liés au devis et à l’autre facture du dossier.</span><Button type="button" variant="secondary" disabled={busy || (readOnly && dirty)} onClick={() => dirty ? void save(true) : onFolder()}><FolderOpen size={17}/> {dirty ? 'Enregistrer et voir le dossier' : 'Voir le dossier'}</Button></div>
      {localError && <ErrorPanel title="Vérifions les dates" message={localError} reveal />}
      <fieldset disabled={busy || readOnly} className="document-form"><div className="form-grid">
        <Field label="Date d’émission" required><input type="date" name="issueDate" value={fields.issueDate} onChange={event => change('issueDate', event.target.value)} required/></Field>
        <Field label="Échéance" required><input type="date" name="dueDate" min={fields.issueDate} value={fields.dueDate} onChange={event => change('dueDate', event.target.value)} required/></Field>
        <Field label="Début de prestation" hint="Pour une prestation d’un jour, renseignez seulement cette date." required><input type="date" name="serviceDateFrom" value={fields.serviceDateFrom} onChange={event => change('serviceDateFrom', event.target.value)} required/></Field>
        <Field label="Fin de prestation"><input type="date" name="serviceDateTo" min={fields.serviceDateFrom} value={fields.serviceDateTo} onChange={event => change('serviceDateTo', event.target.value)}/></Field>
        <Field label="Notes" wide><textarea name="notes" aria-label="Notes" rows={4} value={fields.notes} onChange={event => change('notes', event.target.value)}/></Field>
      </div></fieldset>
      <ul className="quote-invoice-folder__lines">{invoice.lines.map((line) => <li key={line.id}><span>{line.description}</span><strong>{formatMoney(documentTotals([line]).totalCents, invoice.currency)}</strong></li>)}</ul>
      <div className="quote-invoice-folder__totals"><div><span>Total HT</span><strong>{formatMoney(totals.netCents, invoice.currency)}</strong></div><div><span>TVA</span><strong>{formatMoney(totals.vatCents, invoice.currency)}</strong></div><div><span>{invoice.type === 'deposit' ? 'Acompte TTC' : 'Solde TTC'}</span><strong>{formatMoney(totals.totalCents, invoice.currency)}</strong></div></div>
      <FormActions busy={busy} disabled={readOnly} onCancel={close} submitLabel="Enregistrer les dates"/>
    </form>
  </Modal>;
}
