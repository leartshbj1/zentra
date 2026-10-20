import { BellRing } from 'lucide-react';
import { t } from './language';
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

export function AutopilotActionList({ summary, cards, disabled = false, onAction, label }: { summary?: string; cards: readonly AutopilotActionCard[];
  disabled?: boolean; onAction?: (key: string, actionId: string) => void; label: string }) {
  if (!cards.length && !summary) return null;
  return <section className="quote-autopilot__followups" aria-label={label}>
    {summary ? <p className="quote-autopilot__context">{summary}</p> : null}
    {cards.length ? <ol className="quote-autopilot__requests quote-autopilot__requests--followups">
      {cards.map(card => <li key={card.key} data-state="followup">
        <BellRing size={21} aria-hidden="true" />
        <div><strong>{card.title}</strong>
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
  </section>;
}
