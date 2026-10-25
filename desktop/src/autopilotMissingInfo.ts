import type { AutopilotReviewItem } from './autopilotReview';

/**
 * A quote request that cannot be priced as written: Autopilote drafts the reply that
 * asks only for what is missing (quantities, the article meant, the site address,
 * the wished date). The draft opens in the person's own mail program; nothing is sent
 * by Zentra, and the person edits it before sending.
 */
const MISSING = new Set(['missing_quantity', 'ambiguous_quantity', 'unsupported_quantity', 'missing_article', 'too_many_candidates']);

export function askKey(proposalId: string) { return 'ask:' + proposalId; }

/** Requests whose reasons say information is missing, with an address to answer to. */
export function requestsMissingInfo(items: readonly AutopilotReviewItem[]) {
  return items.filter(item => item.reasons.some(reason => MISSING.has(reason)) && !!item.suggestion?.sender?.email);
}

const COPY = {
  fr: { subject: 'Votre demande de devis', hello: 'Bonjour{name},', thanks: 'Merci pour votre demande. Pour vous envoyer un devis exact, pourriez-vous nous préciser :', quantity: 'la quantité souhaitée pour : {item}', article: 'le modèle ou la référence exacte pour : {item}', generic: 'les quantités et les articles souhaités', address: 'l’adresse du chantier ou de livraison', date: 'le délai souhaité', end: 'Avec nos meilleures salutations' },
  de: { subject: 'Ihre Offertanfrage', hello: 'Guten Tag{name}', thanks: 'Vielen Dank für Ihre Anfrage. Damit wir Ihnen eine genaue Offerte senden können, teilen Sie uns bitte mit:', quantity: 'die gewünschte Menge für: {item}', article: 'das genaue Modell oder die Referenz für: {item}', generic: 'die gewünschten Mengen und Artikel', address: 'die Adresse der Baustelle oder Lieferung', date: 'den gewünschten Termin', end: 'Freundliche Grüsse' },
  it: { subject: 'La sua richiesta di preventivo', hello: 'Buongiorno{name},', thanks: 'Grazie per la sua richiesta. Per inviarle un preventivo esatto, potrebbe indicarci:', quantity: 'la quantità desiderata per: {item}', article: 'il modello o il riferimento esatto per: {item}', generic: 'le quantità e gli articoli desiderati', address: 'l’indirizzo del cantiere o di consegna', date: 'il termine desiderato', end: 'Cordiali saluti' },
  en: { subject: 'Your quote request', hello: 'Hello{name},', thanks: 'Thank you for your request. To send you an exact quote, could you tell us:', quantity: 'the quantity you need for: {item}', article: 'the exact model or reference for: {item}', generic: 'the quantities and items you need', address: 'the site or delivery address', date: 'the date you would like', end: 'Kind regards' },
};

/** The reply draft, written from the request's missing parts only. */
export function missingInfoDraft(item: AutopilotReviewItem, language: string, company: string) {
  const copy = COPY[language as keyof typeof COPY] ?? COPY.fr;
  const sender = item.suggestion?.sender;
  const unmatched = item.suggestion?.unmatched ?? [];
  const quantity = item.reasons.some(reason => reason === 'missing_quantity' || reason === 'ambiguous_quantity' || reason === 'unsupported_quantity');
  const asks: string[] = [];
  for (const phrase of unmatched.slice(0, 6)) asks.push((quantity ? copy.quantity : copy.article).replace('{item}', phrase));
  if (!asks.length) asks.push(copy.generic);
  if (!sender?.street) asks.push(copy.address);
  asks.push(copy.date);
  const name = sender?.name ? ` ${sender.name}` : '';
  const body = [copy.hello.replace('{name}', name), '', copy.thanks, ...asks.map(line => `- ${line}`), '', copy.end, company].filter(line => line !== undefined).join('\n');
  return { to: sender?.email ?? '', subject: copy.subject, body };
}

/** A mailto: link for the person's own mail program (subject and body encoded). */
export function mailtoLink(draft: Readonly<{ to: string; subject: string; body: string }>) {
  return `mailto:${encodeURIComponent(draft.to).replace('%40', '@')}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
}
