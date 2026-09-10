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
  onFix?: (target: PayrollHelpTarget) => void;
  disabled?: boolean;
  reveal?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const messageKey = messages.filter(Boolean).join('\n');
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
      {groupedPayrollHelp(messages.filter(Boolean)).map((help) => (
        <section key={help.title} className="payroll-problem">
          <strong>{help.title}</strong>
          <p>{help.explanation}</p>
          {onFix && help.action && (
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={disabled}
              onClick={() => onFix(help.target)}
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
      ))}
    </div>
  );
}
