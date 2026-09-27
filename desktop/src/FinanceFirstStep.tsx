import { useId, type ReactNode } from 'react';
import { t } from './language';
import { Button } from './ui';
import './finance-first-step.css';

/** A single next action; existing records and recoverable errors stay outside it. */
export function FinanceFirstStep({ title, description, actionLabel, onAction, disabled, secondary }: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  disabled?: boolean;
  secondary?: ReactNode;
}) {
  const titleId = useId();
  return <section className="finance-first-step" aria-labelledby={titleId}>
    <h2 id={titleId}>{t(title)}</h2>
    <p>{t(description)}</p>
    {actionLabel && onAction ? <div className="finance-first-step__action"><Button disabled={disabled} onClick={onAction}>{t(actionLabel)}</Button></div> : null}
    {secondary ? <div className="finance-first-step__secondary">{secondary}</div> : null}
  </section>;
}
