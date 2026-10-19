import { useState } from 'react';
import { Mail } from 'lucide-react';
import { useAppLanguage, getAppLocale } from './language';
import { autopilotCopy } from './autopilotPresentation';

/** One proposal made from a client or supplier mail; the action runs only on click. */
export type AutopilotSignalCard = Readonly<{
  sourceId: string; receivedAt: number; title: string; evidence: string; sender: string;
  /** The single action, already worded ("Enregistrer le paiement de CHF 178.00 sur F-2026-0012"). */
  actionLabel: string | null;
  /** When several documents fit, the person picks one first. */
  candidates?: readonly Readonly<{ id: string; label: string }>[];
}>;

function SignalRow({ card, disabled, onAct, onIgnore }: { card: AutopilotSignalCard; disabled: boolean;
  onAct?: (sourceId: string, choiceId?: string) => void; onIgnore?: (sourceId: string) => void }) {
  const copy = autopilotCopy(useAppLanguage());
  const [choice, setChoice] = useState(card.candidates?.length === 1 ? card.candidates[0].id : '');
  return <li data-state="signal">
    <Mail size={21} aria-hidden="true" />
    <div><strong>{card.title}</strong>
      <time dateTime={new Date(card.receivedAt * 1000).toISOString()}>{[card.sender, new Intl.DateTimeFormat(getAppLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(card.receivedAt * 1000)].filter(Boolean).join(' · ')}</time>
      <blockquote className="quote-autopilot__evidence">{card.evidence}</blockquote>
      {card.candidates?.length ? <label className="quote-autopilot__acceptance-pick">{copy.signalWhichInvoice}
        <select value={choice} disabled={disabled} onChange={event => setChoice(event.target.value)}>
          <option value="">{copy.signalPickInvoice}</option>
          {card.candidates.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
        </select></label> : null}
      {!card.actionLabel && !card.candidates?.length ? <p className="quote-autopilot__done-summary">{copy.signalNothingFound}</p> : null}
    </div>
    <div className="quote-autopilot__request-actions">
      {onAct && card.actionLabel ? <button type="button" className="quote-autopilot__create-quote is-ready"
        disabled={disabled || (!!card.candidates?.length && !choice)} onClick={() => onAct(card.sourceId, choice || undefined)}>{card.actionLabel}</button> : null}
      {onIgnore && <button type="button" disabled={disabled} onClick={() => onIgnore(card.sourceId)}>{copy.acceptanceDismiss}</button>}
    </div>
  </li>;
}

/** Proposals from the mails Autopilote read: payments announced, quotes declined, supplier documents, complaints. */
export function AutopilotSignals({ cards, disabled = false, onAct, onIgnore }: { cards: readonly AutopilotSignalCard[]; disabled?: boolean;
  onAct?: (sourceId: string, choiceId?: string) => void; onIgnore?: (sourceId: string) => void }) {
  const copy = autopilotCopy(useAppLanguage());
  if (!cards.length) return null;
  return <ol className="quote-autopilot__requests quote-autopilot__requests--signals" aria-label={copy.signalListTitle}>
    {cards.map(card => <SignalRow key={card.sourceId} card={card} disabled={disabled} onAct={onAct} onIgnore={onIgnore} />)}
  </ol>;
}
