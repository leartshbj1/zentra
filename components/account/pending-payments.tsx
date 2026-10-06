import { ChevronRight, Clock3 } from 'lucide-react';
import {
  prepaidReceiptPath,
  validPrepaidReceiptId,
} from '@/lib/payments/prepaid-receipt-types';
import type { SiteLanguage } from '@/lib/site-language';

/** The server supplies only receipts already authorized for the current owner.
 * This presentation component does not fetch, recover or dispatch a payment. */
export type PendingPaymentReceipt = Readonly<{
  intentId: string;
  name: string;
  targetName: string | null;
  status: 'pending' | 'verification_required' | 'activation_pending';
  receiptHref: string;
}>;

export type PendingPaymentPage = Readonly<{
  items: readonly PendingPaymentReceipt[];
  nextCursor: string | null;
}>;

const copy = {
  fr: {
    title: 'Paiements à vérifier',
    follow: 'Suivre ce paiement',
    pending: 'Confirmation en cours',
    verification_required: 'Résultat à vérifier',
    activation_pending: 'Activation en cours',
    unavailable: 'Vos paiements n’ont pas pu être vérifiés.',
    retry: 'Recharger la page',
    empty: 'Aucun paiement à vérifier.',
    next: 'Voir les paiements suivants',
  },
  de: {
    title: 'Zahlungen prüfen',
    follow: 'Zahlung verfolgen',
    pending: 'Bestätigung ausstehend',
    verification_required: 'Ergebnis prüfen',
    activation_pending: 'Aktivierung läuft',
    unavailable: 'Ihre Zahlungen konnten nicht überprüft werden.',
    retry: 'Seite neu laden',
    empty: 'Keine Zahlungen zu prüfen.',
    next: 'Weitere Zahlungen anzeigen',
  },
  it: {
    title: 'Pagamenti da verificare',
    follow: 'Segui questo pagamento',
    pending: 'Conferma in corso',
    verification_required: 'Risultato da verificare',
    activation_pending: 'Attivazione in corso',
    unavailable: 'Non è stato possibile verificare i tuoi pagamenti.',
    retry: 'Ricarica la pagina',
    empty: 'Nessun pagamento da verificare.',
    next: 'Mostra i pagamenti successivi',
  },
  en: {
    title: 'Payments to check',
    follow: 'Track this payment',
    pending: 'Awaiting confirmation',
    verification_required: 'Result needs checking',
    activation_pending: 'Activation in progress',
    unavailable: 'Your payments could not be checked.',
    retry: 'Reload the page',
    empty: 'No payments to check.',
    next: 'View more payments',
  },
} as const;

export function PendingPayments({
  page,
  language = 'fr',
  showEmpty = false,
}: {
  page: PendingPaymentPage | null;
  language?: SiteLanguage;
  showEmpty?: boolean;
}) {
  const visible =
    page?.items.filter(
      (receipt) =>
        validPrepaidReceiptId(receipt.intentId) &&
        ['pending', 'verification_required', 'activation_pending'].includes(
          receipt.status,
        ),
    ) ?? [];
  const unavailable =
    page === null ||
    (page.items.length > 0 && !visible.length && !page.nextCursor);
  if (!unavailable && !visible.length && !page?.nextCursor && !showEmpty)
    return null;
  const labels = copy[language];
  return (
    <section className="account-card" aria-label={labels.title}>
      <h2>{labels.title}</h2>
      {unavailable && (
        <>
          <output>{labels.unavailable}</output>
          <a
            className="account-link-row"
            href={showEmpty ? '/compte/paiements' : '/compte'}
          >
            <span>{labels.retry}</span>
            <ChevronRight size={18} aria-hidden="true" />
          </a>
        </>
      )}
      {!unavailable && !visible.length && !page?.nextCursor && showEmpty && (
        <p>{labels.empty}</p>
      )}
      {visible.map((receipt) => (
        <a
          key={receipt.intentId}
          className="account-link-row"
          href={prepaidReceiptPath(receipt.intentId)}
        >
          <Clock3 size={22} aria-hidden="true" />
          <span>
            {receipt.name}
            {receipt.targetName && <small>{receipt.targetName}</small>}
            <small>
              {labels[receipt.status]} · {labels.follow}
            </small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </a>
      ))}
      {page?.nextCursor && (
        <a
          className="account-link-row"
          href={`/compte/paiements?avant=${encodeURIComponent(page.nextCursor)}`}
        >
          <span>{labels.next}</span>
          <ChevronRight size={18} aria-hidden="true" />
        </a>
      )}
    </section>
  );
}
