import { useRef, useState } from 'react';
import { Check, QrCode, X } from 'lucide-react';
import { t, useAppLanguage } from './language';
import { matchQrBillSupplier } from './qrBillPurchase';
import { qrBillReadMessage, readQrBillFile } from './qrBillReader';
import { formatIban, formatPaymentReference, qrBillDueDate, type QrBill } from './swissQrBill';
import type { Supplier, Workspace } from './types';
import { Button } from './ui';
import { formatDate, formatMoney } from './utils';
import './invoice-scan.css';

type Read = { bill: QrBill; file: File; supplier: Supplier | null };

/**
 * « Lire la QR-facture » : lecture locale du code QR (PDF ou photo), sans IA.
 * Rien n'est enregistré avant « Utiliser ces informations » puis la
 * sauvegarde habituelle du brouillon.
 */
export function QrBillPanel({ workspace, disabled, onApply, onCreateSupplier, onBusy }: {
  workspace: Workspace;
  disabled: boolean;
  onApply: (bill: QrBill, file: File, supplier: Supplier | null) => void;
  /** Crée la fiche fournisseur proposée et rend son identifiant, ou null. */
  onCreateSupplier: (bill: QrBill) => Promise<string | null>;
  onBusy: (busy: boolean) => void;
}) {
  useAppLanguage();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState<Read | null>(null);
  const [message, setMessage] = useState('');

  async function open(file: File) {
    if (busy || disabled) return;
    setBusy(true);
    onBusy(true);
    setMessage('');
    setRead(null);
    try {
      const result = await readQrBillFile(file);
      if (!result.ok) {
        setMessage(t(qrBillReadMessage(result.reason)));
        return;
      }
      setRead({ bill: result.bill, file, supplier: matchQrBillSupplier(result.bill, workspace) });
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  async function createSupplier() {
    if (!read || busy || disabled) return;
    setBusy(true);
    onBusy(true);
    try {
      const id = await onCreateSupplier(read.bill);
      if (id) onApply(read.bill, read.file, { id, paymentTermsDays: 30 } as Supplier);
      if (id) setRead(null);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  const bill = read?.bill;
  const euro = bill?.currency === 'EUR';
  const due = bill ? qrBillDueDate(bill) : null;
  return <div className="invoice-scan" aria-busy={busy}>
    <div className="invoice-scan__start">
      <Button type="button" variant="secondary" disabled={disabled || busy} onClick={() => input.current?.click()}>
        <QrCode size={18} />{busy ? t('Lecture de la QR-facture…') : t('Lire la QR-facture')}
      </Button>
      <span>{t('PDF ou photo · lu sur cet appareil, sans envoi.')}</span>
    </div>
    <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void open(file); }} />
    {message && <p role="status">{message}</p>}
    {bill && read && <section className="invoice-scan__review" aria-label={t('Informations de la QR-facture')}>
      <div className="invoice-scan__heading">
        <div><h4>{bill.creditor.name}</h4><p>{read.file.name}</p></div>
        <Button type="button" variant="ghost" aria-label={t('Fermer la proposition')} onClick={() => setRead(null)}><X size={18} /></Button>
      </div>
      <dl>
        {[
          [t('Montant'), bill.amountCents === null ? t('Libre, à compléter') : `${formatMoney(bill.amountCents, bill.currency)}`],
          [t('IBAN'), formatIban(bill.iban)],
          [t('Référence'), bill.referenceType === 'NON' ? (bill.message || t('Aucune')) : formatPaymentReference(bill.referenceType, bill.reference)],
          [t('Facture n°'), bill.billInformation?.invoiceNumber ?? t('Non indiqué')],
          [t('Échéance'), due ? formatDate(due) : t('Délai habituel du fournisseur')],
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {euro && <p role="status">{t('Facture en euros : Zentra enregistre les achats en francs. Saisissez-la à la main avec le montant en CHF.')}</p>}
      {!euro && (read.supplier
        ? <p>{t('Fournisseur reconnu : {name}. Comparez avec l’original, il sera joint au brouillon.', { name: read.supplier.name })}</p>
        : <p>{t('Ce fournisseur n’a pas encore de fiche. Créez-la d’un clic, ou choisissez-le dans la liste.')}</p>)}
      {!euro && <div className="invoice-scan__actions">
        {!read.supplier && <Button type="button" variant="secondary" disabled={disabled || busy} onClick={() => void createSupplier()}>{t('Créer le fournisseur')}</Button>}
        <Button type="button" disabled={disabled || busy} onClick={() => { onApply(bill, read.file, read.supplier); setRead(null); }}><Check size={17} />{t('Utiliser ces informations')}</Button>
      </div>}
    </section>}
  </div>;
}
