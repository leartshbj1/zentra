import { useEffect, useRef } from 'react';
import { Button } from './ui';
import { groupedPayrollHelp, type PayrollHelpTarget } from './payrollHelp';

export function PayrollProblem({
  messages,
  onFix,
  disabled = false,
  reveal = false,
}: {
  messages: string[];
  onFix?: (target: PayrollHelpTarget, selector?: string) => void;
  disabled?: boolean;
  reveal?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const messageKey = messages.filter(Boolean).join('\n');
  const helpItems = groupedPayrollHelp(messages.filter(Boolean));
  const renderHelp = (help: (typeof helpItems)[number]) => (
    <section key={help.title} className="payroll-problem">
      <strong>{help.title}</strong>
      <p>{help.explanation}</p>
      {help.steps && (
        <details className="payroll-problem-guide">
          <summary>Comment faire, étape par étape</summary>
          <ol>
            {help.steps.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ol>
        </details>
      )}
      {onFix && help.action && (
        <Button
          type="button"
          size="small"
          variant="secondary"
          disabled={disabled}
          onClick={() => onFix(help.target, help.selector)}
        >
          {help.action}
        </Button>
      )}
      <details>
        <summary>Voir le message détaillé</summary>
        {help.messages.map((message) => (
          <p key={message}>{message}</p>
        ))}
      </details>
    </section>
  );
  useEffect(() => {
    if (!reveal || !messageKey || container.current?.closest('[hidden]'))
      return;
    container.current?.focus({ preventScroll: true });
    container.current?.scrollIntoView({
      block: 'nearest',
      behavior: 'instant',
    });
  }, [reveal, messageKey]);
  return (
    <div
      ref={container}
      tabIndex={-1}
      className="payroll-problems"
      aria-live="polite"
    >
      {helpItems[0] && renderHelp(helpItems[0])}
      {helpItems.length > 1 && (
        <details className="payroll-remaining" key="remaining-problems">
          <summary>
            Voir les {helpItems.length - 1} autres points à compléter
          </summary>
          <p>
            Vous pouvez commencer par le premier point. Votre saisie reste dans
            ce formulaire pendant les corrections.
          </p>
          {helpItems.slice(1).map(renderHelp)}
        </details>
      )}
    </div>
  );
}
