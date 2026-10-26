import { useEffect, useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import {
  defaultPaymentSafetySettings,
  entryFindingText,
  entryHabit,
  findingDetail,
  findingTitle,
  historyLines,
  receiptRecipients,
  receiptRequestDraft,
  receiptWho,
  type EntryReview,
  type MissingReceipt,
  type PaymentReview,
  type PaymentSafetySettings as Settings,
  type ReceiptRequestChannel,
  type SupplierPaymentHistory,
} from './paymentSafety';
import type { Employee, SupplierInvoice } from './types';
import { Button, Field, Modal } from './ui';
import { createId, errorMessage, formatDate, formatMoney } from './utils';
import './payment-safety.css';

/** Résumé du fournisseur : nombre de paiements, 12 mois, dernier paiement, montant habituel, IBAN. */
export function SupplierPaymentHistoryList({ history }: { history: SupplierPaymentHistory }) {
  useAppLanguage();
  return <dl className="payment-check__history" aria-label={t('Historique du fournisseur')}>
    {historyLines(history).map((line) => <div key={line.label}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}
  </dl>;
}

/** Les alertes calculées par l'app, chacune avec sa règle en clair. */
export function PaymentFindings({ review, history = true }: { review: PaymentReview; history?: boolean }) {
  useAppLanguage();
  if (!review.findings.length) return null;
  return <div className="payment-check">
    <ul className="payment-check__items">
      {review.findings.map((finding, index) => <li key={`${finding.kind}-${index}`}>
        <strong>{findingTitle(finding)}</strong>
        <p>{findingDetail(finding, review.amountCents)}</p>
      </li>)}
    </ul>
    {history && <SupplierPaymentHistoryList history={review.history} />}
  </div>;
}

export type FlaggedPayment = { invoice: SupplierInvoice; review: PaymentReview };

/**
 * Avant d'écrire l'ordre : chaque facture signalée est confirmée en connaissance
 * de cause (gardé dans le journal) ou retirée du lot.
 */
export function PaymentChecksDialog({ flagged, busy, onCancel, onRemove, onConfirm }: {
  flagged: readonly FlaggedPayment[];
  busy: boolean;
  onCancel: () => void;
  onRemove: (invoiceId: string) => void;
  onConfirm: (acknowledged: { supplierInvoiceId: string; kinds: string[] }[]) => void;
}) {
  useAppLanguage();
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const ready = flagged.length > 0 && flagged.every((row) => confirmed[row.invoice.id]);
  return <Modal title={t('Avant de générer l’ordre')} description={flagged.length === 1 ? t('1 facture demande votre attention.') : t('{count} factures demandent votre attention.', { count: flagged.length })} onClose={onCancel} dismissible={!busy} className="payment-checks-modal">
    <div className="payment-checks">
      <ul className="payment-checks__list">
        {flagged.map(({ invoice, review }) => <li key={invoice.id}>
          <header>
            <strong>{invoice.supplierName}</strong>
            <span>{invoice.reference || t('Sans numéro')} · {formatMoney(review.amountCents)}</span>
          </header>
          <PaymentFindings review={review} />
          <div className="payment-checks__decision">
            <label>
              <input type="checkbox" checked={!!confirmed[invoice.id]} disabled={busy} onChange={(event) => setConfirmed((current) => ({ ...current, [invoice.id]: event.target.checked }))} />
              <span>{t('J’ai vérifié : payer quand même')}</span>
            </label>
            <Button type="button" variant="ghost" size="small" disabled={busy} onClick={() => onRemove(invoice.id)}>{t('Retirer du lot')}</Button>
          </div>
        </li>)}
      </ul>
      <p className="payment-checks__note">{t('Votre confirmation est gardée dans le journal, avec votre nom et la date.')}</p>
      <div className="form-actions">
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>{t('Annuler')}</Button>
        <Button type="button" disabled={busy || !ready} onClick={() => onConfirm(flagged.map(({ invoice, review }) => ({ supplierInvoiceId: invoice.id, kinds: [...new Set(review.findings.map((finding) => finding.kind))] })))}>
          {busy ? t('Préparation…') : t('Générer l’ordre de paiement')}
        </Button>
      </div>
    </div>
  </Modal>;
}

/** « 5000 », « 5'000 », « 5 000.50 » ou « 5000,50 » en centimes. */
export function centsFromText(value: string): number | null {
  const compact = value.replace(/['’\s  ]/g, '');
  const match = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(compact);
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
}

/** Paramètres : double validation et relance des justificatifs, pour toute l'équipe. */
export function PaymentSafetySettings({ disabled }: { disabled: boolean }) {
  useAppLanguage();
  const [settings, setSettings] = useState<Settings>(defaultPaymentSafetySettings);
  const [amount, setAmount] = useState('5000');
  const [days, setDays] = useState('10');
  const [state, setState] = useState<{ mayEdit: boolean; solo: boolean }>({ mayEdit: true, solo: true });
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => desktopApi.paymentSafetyOverview()).then((overview) => {
      if (!live) return;
      setSettings(overview.settings);
      setAmount(String(overview.settings.approvalThresholdCents / 100));
      setDays(String(overview.settings.receiptReminderDays));
      setState({ mayEdit: overview.actor.mayApprove, solo: overview.actor.solo });
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const locked = disabled || saving || !state.mayEdit;

  async function save() {
    const cents = centsFromText(amount);
    const reminderDays = Number(days);
    if (cents === null || cents < 100) { setMessage(t('Saisissez un montant d’au moins CHF 1.00.')); return; }
    if (!Number.isInteger(reminderDays) || reminderDays < 1 || reminderDays > 90) { setMessage(t('Saisissez un délai entre 1 et 90 jours.')); return; }
    setSaving(true); setMessage('');
    try {
      const saved = await desktopApi.savePaymentSafetySettings({ ...settings, approvalThresholdCents: cents, receiptReminderDays: reminderDays });
      setSettings(saved);
      setMessage(t('Règles de paiement enregistrées pour toute l’équipe.'));
    } catch (reason) {
      setMessage(errorMessage(reason, t('Les règles de paiement n’ont pas pu être enregistrées.')));
    } finally { setSaving(false); }
  }

  return <section className="payment-safety-settings" aria-labelledby="payment-safety-settings-title">
    <h3 id="payment-safety-settings-title">{t('Paiements sûrs')}</h3>
    <p>{t('Avant chaque ordre de paiement, Zentra vérifie l’IBAN, les premiers paiements, les factures en double et les montants inhabituels.')}</p>
    <label className="payment-safety-settings__switch">
      <input type="checkbox" role="switch" aria-checked={settings.approvalEnabled} checked={settings.approvalEnabled} disabled={locked} onChange={(event) => setSettings((current) => ({ ...current, approvalEnabled: event.target.checked }))} />
      <span><strong>{t('Double validation des paiements')}</strong><small>{t('Au-delà du montant choisi, la personne qui prépare un paiement ne peut pas l’approuver seule. Le propriétaire ou un administrateur l’approuve.')}</small></span>
    </label>
    {settings.approvalEnabled && <Field label={t('À partir de (CHF)')} hint={state.solo ? t('Vous êtes seul dans l’entreprise : Zentra garde les alertes, sans bloquer le paiement.') : undefined}>
      <input inputMode="decimal" value={amount} disabled={locked} onChange={(event) => setAmount(event.target.value)} />
    </Field>}
    <Field label={t('Relancer un justificatif manquant après (jours)')} hint={t('Une dépense bancaire sans pièce apparaît alors dans Autopilote.')}>
      <input inputMode="numeric" value={days} disabled={locked} onChange={(event) => setDays(event.target.value)} />
    </Field>
    <div className="payment-safety-settings__actions">
      <Button type="button" variant="secondary" disabled={locked} onClick={() => void save()}>{saving ? t('Enregistrement…') : t('Enregistrer les règles de paiement')}</Button>
      {!state.mayEdit && <p>{t('Seul le propriétaire ou un administrateur peut changer ces règles.')}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </section>;
}

/**
 * Demande de justificatif à un collaborateur : le texte préparé par l'app est
 * modifiable, puis envoyé d'un clic par la messagerie de l'entreprise ou de cet
 * appareil. Sans messagerie connectée, ou si l'envoi échoue, le brouillon
 * s'ouvre dans votre messagerie.
 */
export function ReceiptRequestDialog({ receipt, employees, companyName, rememberedId, onClose, onSent }: {
  receipt: MissingReceipt;
  employees: readonly Employee[];
  companyName: string;
  rememberedId?: string;
  onClose: () => void;
  onSent: (employee: Employee, how: 'sent' | 'draft') => void;
}) {
  useAppLanguage();
  const people = useMemo(() => receiptRecipients(employees, rememberedId), [employees, rememberedId]);
  const [employeeId, setEmployeeId] = useState(people[0]?.id ?? '');
  const employee = people.find((person) => person.id === employeeId) ?? null;
  const prepared = employee ? receiptRequestDraft(receipt, employee, companyName) : null;
  const [edited, setEdited] = useState<{ forId: string; subject: string; body: string } | null>(null);
  const subject = edited?.forId === employeeId ? edited.subject : prepared?.subject ?? '';
  const body = edited?.forId === employeeId ? edited.body : prepared?.body ?? '';
  const [channel, setChannel] = useState<ReceiptRequestChannel | null | undefined>(undefined);
  const [requestId] = useState(() => createId());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => desktopApi.receiptRequestChannel()).then((value) => { if (live) setChannel(value); }).catch(() => { if (live) setChannel(null); });
    return () => { live = false; };
  }, []);
  const amount = formatMoney(Math.abs(receipt.movement.amountCents), receipt.movement.currency || 'CHF');
  const href = employee ? `mailto:${encodeURIComponent(employee.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : '';
  const ready = !!employee && !!channel && !!subject.trim() && !!body.trim();

  async function send() {
    if (!employee || !channel || sending) return;
    setSending(true); setError('');
    try {
      await desktopApi.sendReceiptRequest(channel, { requestId, reference: receipt.movement.id, recipient: employee.email, subject: subject.trim(), body });
      onSent(employee, 'sent');
    } catch (reason) {
      setError(errorMessage(reason, t('Le message n’a pas pu être envoyé.')));
    } finally { setSending(false); }
  }

  return <Modal title={t('Demander le justificatif')} description={[amount, formatDate((receipt.movement.bookingDate || receipt.movement.valueDate).slice(0, 10)), receiptWho(receipt.movement)].filter(Boolean).join(' · ')} onClose={onClose} dismissible={!sending} className="receipt-request-modal">
    <div className="receipt-request">
      {people.length ? <>
        <Field label={t('Collaborateur')}>
          <select value={employeeId} disabled={sending} onChange={(event) => setEmployeeId(event.target.value)}>
            {people.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.email}</option>)}
          </select>
        </Field>
        <Field label={t('Objet')}>
          <input value={subject} maxLength={200} disabled={sending} onChange={(event) => setEdited({ forId: employeeId, subject: event.target.value, body })} />
        </Field>
        <Field label={t('Message')}>
          <textarea value={body} rows={9} maxLength={4000} disabled={sending} onChange={(event) => setEdited({ forId: employeeId, subject, body: event.target.value })} />
        </Field>
        <p className="receipt-request__note">{channel === undefined
          ? t('Recherche de votre messagerie…')
          : channel
            ? t('Envoyé depuis {email}, seulement quand vous cliquez sur Envoyer.', { email: channel.fromEmail })
            : t('Aucune messagerie n’est connectée dans Zentra : le message s’ouvrira dans votre messagerie, à envoyer vous-même.')}</p>
      </> : <p className="receipt-request__note">{t('Aucun collaborateur n’a d’adresse e-mail. Ajoutez-la dans sa fiche, rubrique Équipe.')}</p>}
      {error && <p className="receipt-request__error" role="alert">{error} {t('Vous pouvez aussi ouvrir le message dans votre messagerie.')}</p>}
      <div className="form-actions">
        <Button type="button" variant="secondary" disabled={sending} onClick={onClose}>{t('Fermer')}</Button>
        {employee && (channel ? <a className="receipt-request__fallback" href={href} onClick={() => onSent(employee, 'draft')}>{t('Ouvrir dans ma messagerie')}</a>
          : channel === null && <a className="button button--primary button--normal" href={href} onClick={() => onSent(employee, 'draft')}>{t('Ouvrir le brouillon dans la messagerie')}</a>)}
        {channel && <Button type="button" disabled={!ready || sending} onClick={() => void send()}>{sending ? t('Envoi…') : t('Envoyer')}</Button>}
      </div>
    </div>
  </Modal>;
}

/** Écriture inhabituelle pour ce fournisseur, signalée avant la validation. */
export function SupplierEntryCheck({ invoiceId, confirmed, disabled, onReview, onConfirm }: {
  invoiceId: string;
  confirmed: boolean;
  disabled: boolean;
  onReview: (review: EntryReview | null) => void;
  onConfirm: (value: boolean) => void;
}) {
  useAppLanguage();
  const [review, setReview] = useState<EntryReview | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => desktopApi.reviewSupplierInvoiceEntry(invoiceId)).then((value) => { if (live) { setReview(value); onReview(value); } }).catch(() => { if (live) onReview(null); });
    return () => { live = false; };
  }, [invoiceId, onReview]);
  if (!review?.findings.length) return null;
  const habit = entryHabit(review);
  return <section className="supplier-review__matching supplier-review__entry" aria-labelledby={`entry-check-${invoiceId}`}>
    <h3 id={`entry-check-${invoiceId}`}>{t('Écriture inhabituelle')}</h3>
    {habit && <p>{habit}</p>}
    <ul>{review.findings.map((finding, index) => <li key={`${finding.kind}-${index}`}>{entryFindingText(finding)}</li>)}</ul>
    <label><input name="entryChecked" type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => onConfirm(event.target.checked)} />{t('J’ai vérifié le compte, la TVA et le montant.')}</label>
  </section>;
}
