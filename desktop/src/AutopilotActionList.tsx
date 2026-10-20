import { useState } from 'react';
import { BellRing } from 'lucide-react';
import { t } from './language';
import { autopilotKind } from './autopilotKinds';
import './autopilot-journal.css';

/** One thing Autopilote prepared (a reminder, a quote follow-up); nothing runs before a click. */
export type AutopilotActionCard = Readonly<{
  key: string; title: string; detail: string;
  /** A sentence from the client's mail that changes what to do, quoted as is. */
  evidence?: string;
  note?: string;
  /** Why Autopilote proposes it: the rule applied and how sure it is. Shown on demand. */
  why?: string;
  /** Same action, same counterpart: three validations propose a learned rule. */
  signature?: string;
  actions: readonly Readonly<{ id: string; label: string; primary?: boolean }>[];
}>;

/** Cards beyond this stay folded under one link, so a busy day still reads at a glance. */
const VISIBLE_CARDS = 8;

export function AutopilotActionList({ summary, cards, disabled = false, onAction, label }: { summary?: string; cards: readonly AutopilotActionCard[];
  disabled?: boolean; onAction?: (key: string, actionId: string) => void; label: string }) {
  const [all, setAll] = useState(false);
  if (!cards.length && !summary) return null;
  const shown = all ? cards : cards.slice(0, VISIBLE_CARDS);
  const hidden = cards.length - shown.length;
  return <section className="quote-autopilot__followups" aria-label={label}>
    {summary ? <p className="quote-autopilot__context">{summary}</p> : null}
    {cards.length ? <ol className="quote-autopilot__requests quote-autopilot__requests--followups">
      {shown.map(card => <li key={card.key} data-state="followup">
        <BellRing size={21} aria-hidden="true" />
        <div>{autopilotKind(card.key) ? <span className="quote-autopilot__kind">{t(autopilotKind(card.key)!)}</span> : null}<strong>{card.title}</strong>
          <p className="quote-autopilot__done-summary">{card.detail}</p>
          {card.note ? <p className="quote-autopilot__hint">{card.note}</p> : null}
          {card.evidence ? <blockquote className="quote-autopilot__evidence">{card.evidence}</blockquote> : null}
          {card.why ? <details className="quote-autopilot__why"><summary>{t('Pourquoi ?')}</summary><p>{card.why}</p></details> : null}
        </div>
        <div className="quote-autopilot__request-actions">
          {onAction && card.actions.map(action => <button key={action.id} type="button" disabled={disabled}
            className={action.primary ? 'quote-autopilot__create-quote is-ready' : undefined} onClick={() => onAction(card.key, action.id)}>{action.label}</button>)}
        </div>
      </li>)}
    </ol> : null}
    {hidden > 0 ? <button type="button" className="quote-autopilot__more-cards" onClick={() => setAll(true)}>{t('Afficher les {n} autres', { n: hidden })}</button> : null}
  </section>;
}
