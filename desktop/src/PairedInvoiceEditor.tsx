import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, FolderOpen } from 'lucide-react';
import { desktopApi } from './bridge';
import type { Invoice, Workspace } from './types';
import { Button, Field, Modal, submitForm } from './ui';
import { addDaysIso, documentTotals, errorMessage, formatDate, formatMoney, todayIso } from './utils';
import { invoiceDateIssues, isSalesDate, type InvoiceDateIssue } from './salesFormValidation';
import { changePairedIssueDate, initialPairedInvoiceFields, pairedDateStep, pairedPaymentDays, pairedServiceReference, type PairedInvoiceFields, type PairedInvoiceStep } from './pairedInvoicePreparation';
import './QuoteInvoiceFolder.css';

type Props = {
  invoice: Invoice; workspace: Workspace; busy: boolean; readOnly?: boolean; correctDates?: boolean;
  close: () => void; onFolder: () => void;
  act: (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;
};
const steps = [['service', 'Prestation'], ['payment', 'Paiement'], ['review', 'Vérifier']] as const;

export function PairedInvoiceEditor(props: Props) {
  return <Preparation key={`${props.invoice.id}:${!!props.correctDates}`} {...props} readOnly={props.readOnly || props.invoice.status !== 'draft'} />;
}

function Preparation({ invoice, workspace, busy, readOnly = false, correctDates = false, close, onFolder, act }: Props) {
  const days = pairedPaymentDays(workspace.settings?.billing.paymentTermsDays ?? 30);
  const [initial] = useState(() => initialPairedInvoiceFields(invoice, days, todayIso(), readOnly));
  const [fields, setFields] = useState(initial);
  const [step, setStep] = useState<PairedInvoiceStep>(() => correctDates ? pairedDateStep(invoiceDateIssues(initial)[0]?.field ?? 'issueDate') : 'service');
  const [issue, setIssue] = useState<InvoiceDateIssue | null>(() => correctDates ? invoiceDateIssues(initial)[0] ?? null : null);
  const [serverError, setServerError] = useState(''), [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState<'close' | 'folder' | null>(null);
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false), form = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null), problem = useRef<HTMLDivElement>(null), leavePanel = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step), previousLeave = useRef(false), leaveOrigin = useRef<HTMLElement | null>(null);
  const locked = busy || saving;
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  const reference = pairedServiceReference(invoice, workspace.invoices);
  const totals = documentTotals(invoice.lines);
  const name = invoice.type === 'deposit' ? 'Facture d’acompte' : 'Facture de solde';
  const client = workspace.clients.find(row => row.id === invoice.clientId);
  const date = (value: string) => isSalesDate(value) ? formatDate(value) : 'À compléter';

  useEffect(() => {
    const container = form.current;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const input = document.activeElement;
        if (!(input instanceof HTMLElement) || !container?.contains(input) || !input.matches('input, textarea')) return;
        const body = container.closest<HTMLElement>('.modal__body');
        if (!body) return;
        const area = body.getBoundingClientRect(), rect = input.getBoundingClientRect();
        const viewport = window.visualViewport;
        const top = Math.max(area.top, viewport?.offsetTop ?? 0) + 12;
        let bottom = Math.min(area.bottom, viewport ? viewport.offsetTop + viewport.height : innerHeight) - 12;
        const bar = container.querySelector('.paired-preparation__actions')?.getBoundingClientRect();
        if (bar && bar.top > top && bar.top < bottom) bottom = bar.top - 12;
        if (bottom <= top || (rect.top >= top && rect.bottom <= bottom)) return;
        body.scrollBy({ top: rect.top - top - Math.max(0, (bottom - top - rect.height) / 2), behavior: 'instant' });
      });
    };
    container?.addEventListener('focusin', reveal);
    window.addEventListener('resize', reveal);
    window.visualViewport?.addEventListener('resize', reveal);
    return () => {
      cancelAnimationFrame(frame);
      container?.removeEventListener('focusin', reveal);
      window.removeEventListener('resize', reveal);
      window.visualViewport?.removeEventListener('resize', reveal);
    };
  }, []);

  useEffect(() => {
    if (locked) return;
    const node = leaving ? leavePanel.current : issue ? form.current?.querySelector<HTMLInputElement>(`input[name="${issue.field}"]`) : serverError ? problem.current : previousLeave.current ? (leaveOrigin.current?.isConnected ? leaveOrigin.current : heading.current) : previousStep.current !== step ? heading.current : null;
    previousStep.current = step; previousLeave.current = !!leaving;
    node?.focus(); node?.scrollIntoView({ block: 'nearest' });
  }, [step, issue, serverError, leaving, locked]);

  function change(field: keyof PairedInvoiceFields, value: string) {
    if (locked || readOnly || inFlight.current) return;
    setFields(previous => field === 'issueDate' ? changePairedIssueDate(previous, value, days) : { ...previous, [field]: value });
    if (issue?.field === field) setIssue(null);
    setServerError(''); setNotice('');
  }
  function validate(onlyStep?: PairedInvoiceStep) {
    const next = invoiceDateIssues(fields).find(value => !onlyStep || pairedDateStep(value.field) === onlyStep);
    if (!next) { setIssue(null); return true; }
    setIssue(next); setStep(pairedDateStep(next.field)); return false;
  }
  function go(next: PairedInvoiceStep) {
    if (locked || inFlight.current) return;
    if (next === 'review' && !readOnly && !validate()) return;
    setStep(next); setIssue(null); setServerError('');
  }
  function requestLeave(destination: 'close' | 'folder') {
    if (locked || inFlight.current) return;
    if (dirty) { leaveOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setLeaving(destination); }
    else (destination === 'folder' ? onFolder : close)();
  }
  async function save() {
    if (locked || readOnly || inFlight.current || !validate()) return;
    inFlight.current = true; setSaving(true); setServerError('');
    let reported = false;
    const report = (reason: unknown) => { reported = true; setServerError(errorMessage(reason, 'Les modifications n’ont pas pu être enregistrées. Votre saisie est conservée.')); };
    try {
      const saved = await act(() => desktopApi.updateEntity('invoices', invoice.id, { ...fields }), 'Les dates et les notes de la facture ont été enregistrées.', false, report);
      if (saved) onFolder();
      else if (!reported) setServerError('L’enregistrement n’a pas encore été confirmé. Si une fenêtre d’actualisation est ouverte, terminez cette vérification avant de réessayer.');
    } catch (reason) { report(reason); }
    finally { inFlight.current = false; setSaving(false); }
  }
  const fieldError = (field: keyof PairedInvoiceFields) => issue?.field === field ? issue.message : undefined;
  return <Modal title={name} description={invoice.number || invoice.title} onClose={() => requestLeave('close')} dismissible={!locked} wide>
    <form ref={form} className="paired-invoice-editor paired-preparation" noValidate onSubmit={submitForm(async () => {
      if (locked || inFlight.current || leaving) return;
      if (step === 'service') { if (readOnly || validate('service')) go('payment'); }
      else if (step === 'payment') go('review');
      else await save();
    })}>
      {leaving ? <div className="paired-preparation__leave" role="alert" tabIndex={-1} ref={leavePanel}>
        <h2>Garder vos modifications ?</h2><p>Les dates et les notes que vous venez de modifier ne sont pas encore enregistrées.</p>
        <Button type="button" onClick={() => setLeaving(null)}>Rester sur la facture</Button>
        <Button type="button" variant="secondary" onClick={() => (leaving === 'folder' ? onFolder : close)()}>Quitter sans enregistrer</Button>
      </div> : <>
        <div className="paired-preparation__overview"><div><span>{name} · TTC</span><strong>{formatMoney(totals.totalCents, invoice.currency)}</strong></div><p>Les montants viennent du devis. Préparez les dates, puis relisez la facture avant de l’enregistrer.</p></div>
        <nav className="paired-preparation__steps" aria-label="Préparation de la facture">{steps.map(([id, label], index) => <button key={id} type="button" disabled={locked} aria-current={step === id ? 'step' : undefined} onClick={() => go(id)}><span>{index + 1}</span>{label}</button>)}</nav>
        {readOnly && <p className="paired-preparation__hint" role="status">{invoice.status !== 'draft' ? 'Cette facture est déjà émise. Ses dates, ses notes et ses montants restent conservés.' : 'Vous êtes en lecture seule. Vous pouvez parcourir les informations ; leur enregistrement demande un accès en écriture.'}</p>}
        {serverError && <div className="paired-preparation__problem" role="alert" tabIndex={-1} ref={problem}><strong>Vos modifications sont conservées</strong><p>{serverError}</p><Button type="button" variant="secondary" disabled={locked} onClick={() => go('payment')}>Revoir les dates</Button></div>}
        <section className="paired-preparation__section" aria-labelledby="paired-step-heading">
          <h2 id="paired-step-heading" ref={heading} tabIndex={-1}>{step === 'service' ? 'Quand la prestation a-t-elle lieu ?' : step === 'payment' ? 'Quand cette facture doit-elle être payée ?' : 'Vérifiez les informations'}</h2>
          {step === 'service' && <>
            <p>Indiquez le jour ou la période des travaux ou du service facturé. Pour une seule journée, la date de début suffit.</p>
            {reference && <div className="paired-preparation__reference"><p>L’autre facture du dossier indique {date(reference.serviceDateFrom)}{reference.serviceDateTo && reference.serviceDateTo !== reference.serviceDateFrom ? ` au ${date(reference.serviceDateTo)}` : ''}.</p><Button type="button" variant="secondary" disabled={locked || readOnly} onClick={() => {
              if (locked || readOnly || inFlight.current) return;
              setFields(previous => ({ ...previous, serviceDateFrom: reference.serviceDateFrom, serviceDateTo: reference.serviceDateTo || '' })); setIssue(null); setNotice('Dates de prestation reprises. Les dates de paiement et vos notes sont conservées.');
            }}><Copy size={16} /> Reprendre ces dates de prestation</Button></div>}
            {notice && <p className="paired-preparation__hint" role="status">{notice}</p>}
            <fieldset disabled={locked || readOnly} className="form-grid">
              <Field label="Début de prestation" required error={fieldError('serviceDateFrom')} hint="Le jour de la prestation, ou le début de la période."><input type="date" name="serviceDateFrom" value={fields.serviceDateFrom} aria-invalid={!!fieldError('serviceDateFrom')} aria-describedby={fieldError('serviceDateFrom') ? 'paired-date-problem' : undefined} onChange={event => change('serviceDateFrom', event.target.value)} /></Field>
              <Field label="Fin de prestation" error={fieldError('serviceDateTo')} hint="Facultatif : laissez vide pour une seule journée."><input type="date" name="serviceDateTo" value={fields.serviceDateTo} min={fields.serviceDateFrom} aria-invalid={!!fieldError('serviceDateTo')} aria-describedby={fieldError('serviceDateTo') ? 'paired-date-problem' : undefined} onChange={event => change('serviceDateTo', event.target.value)} /></Field>
            </fieldset>
          </>}
          {step === 'payment' && <>
            <p>La date d’émission apparaît sur la facture. L’échéance est le dernier jour prévu pour son paiement.</p>
            <fieldset disabled={locked || readOnly} className="form-grid">
              <Field label="Date d’émission" required error={fieldError('issueDate')} hint="La date à faire figurer sur cette facture."><input type="date" name="issueDate" value={fields.issueDate} aria-invalid={!!fieldError('issueDate')} aria-describedby={fieldError('issueDate') ? 'paired-date-problem' : undefined} onChange={event => change('issueDate', event.target.value)} /></Field>
              <Field label="Échéance" required error={fieldError('dueDate')} hint="Paiement attendu au plus tard à cette date."><input type="date" name="dueDate" value={fields.dueDate} min={fields.issueDate} aria-invalid={!!fieldError('dueDate')} aria-describedby={fieldError('dueDate') ? 'paired-date-problem' : undefined} onChange={event => change('dueDate', event.target.value)} /></Field>
            </fieldset>
            <div className="paired-preparation__terms" role="group" aria-label="Choisir un délai de paiement">{[...new Set([7, 14, 30, days])].sort((a,b) => a-b).map(value => <Button key={value} type="button" variant="secondary" disabled={locked || readOnly || !isSalesDate(fields.issueDate)} onClick={() => change('dueDate', addDaysIso(fields.issueDate, value))}>{value === 0 ? 'Le jour de l’émission' : `À ${value} jours`}{value === days ? ' · habituel' : ''}</Button>)}</div>
            <Field label="Notes" wide hint="Facultatif : conditions ou message propres à cette facture. Les retours à la ligne sont conservés."><textarea name="notes" aria-label="Notes" rows={4} disabled={locked || readOnly} value={fields.notes} onChange={event => change('notes', event.target.value)} /></Field>
          </>}
          {issue && <p id="paired-date-problem" className="paired-preparation__hint">Corrigez le champ signalé pour continuer. Vos autres informations restent présentes.</p>}
          {step === 'review' && <>
            <p>{invoice.status === 'draft' ? 'L’enregistrement garde cette facture en brouillon. Vous pourrez ensuite l’émettre depuis le dossier pour lui attribuer son numéro.' : 'Ces informations appartiennent à la facture émise et restent conservées.'}</p>
            <dl className="paired-preparation__review"><div><dt>Client</dt><dd>{client?.name || 'Client du devis'}</dd></div><div><dt>Prestation</dt><dd>{date(fields.serviceDateFrom)}{fields.serviceDateTo && fields.serviceDateTo !== fields.serviceDateFrom ? ` au ${date(fields.serviceDateTo)}` : ''}</dd></div><div><dt>Date d’émission</dt><dd>{date(fields.issueDate)}</dd></div><div><dt>Paiement au plus tard le</dt><dd>{date(fields.dueDate)}</dd></div><div><dt>Hors TVA</dt><dd>{formatMoney(totals.netCents, invoice.currency)}</dd></div><div><dt>TVA</dt><dd>{formatMoney(totals.vatCents, invoice.currency)}</dd></div></dl>
            {fields.notes && <div className="paired-preparation__notes"><strong>Notes</strong><p>{fields.notes}</p></div>}
            <p className="paired-preparation__hint">{invoice.type === 'deposit' ? 'Après l’émission, enregistrez le paiement lorsque vous recevez l’argent.' : 'Le solde déduit l’acompte. L’acompte garde son propre suivi de paiement.'}</p>
          </>}
        </section>
        <details className="paired-preparation__lines"><summary>Voir le détail du montant</summary><ul className="quote-invoice-folder__lines">{invoice.lines.map(line => <li key={line.id}><span>{line.description}</span><strong>{formatMoney(documentTotals([line]).totalCents, invoice.currency)}</strong></li>)}</ul></details>
        <div className="form-actions paired-preparation__actions">
          <Button type="button" variant="secondary" disabled={locked} onClick={() => step === 'service' ? requestLeave('close') : go(step === 'review' ? 'payment' : 'service')}><ArrowLeft size={16}/>{step === 'service' ? 'Annuler' : 'Retour'}</Button>
          <Button type="submit" disabled={locked || (step === 'review' && readOnly)}>{saving ? 'Enregistrement…' : step === 'service' ? 'Continuer vers le paiement' : step === 'payment' ? 'Vérifier la facture' : <><Check size={16}/> Enregistrer et voir le dossier</>}</Button>
        </div>
        <Button type="button" variant="ghost" disabled={locked} onClick={() => requestLeave('folder')}><FolderOpen size={16}/> Voir le dossier</Button>
      </>}
    </form>
  </Modal>;
}
