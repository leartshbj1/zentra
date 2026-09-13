import { t, useAppLanguage } from './language';
import { useEffect, useRef } from 'react';
import { Button } from './ui';
import { groupedPayrollHelp, type PayrollHelpTarget } from './payrollHelp';

export function PayrollProblem({
  messages,
  onFix,
  disabled = false,
  reveal = false,
  renderMessage,
}: {
  messages: string[];
  onFix?: (target: PayrollHelpTarget, selector?: string) => void;
  disabled?: boolean;
  reveal?: boolean;
  renderMessage?: (message: string) => string;
}) {
  useAppLanguage();
  const container = useRef<HTMLDivElement>(null);
  const messageKey = messages.filter(Boolean).join('\n');
  const helpItems = groupedPayrollHelp(messages.filter(Boolean));
  const renderHelp = (help: (typeof helpItems)[number]) => (
    <section key={help.title} className="payroll-problem">
      <strong>{t(help.title)}</strong>
      <p>{t(help.explanation)}</p>
      {help.steps && (
        <details className="payroll-problem-guide">
          <summary>{t("Comment faire, étape par étape")}</summary>
          <ol>
            {help.steps.map((text) => (
              <li key={text}>{t(text)}</li>
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
          {t(help.action)}
        </Button>
      )}
      <details>
        <summary>{t("Voir le message détaillé")}</summary>
        {help.messages.map((message) => (
          <p key={message}>{renderMessage ? renderMessage(message) : message}</p>
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
          <summary>{t(helpItems.length === 2 ? 'Voir l’autre point à compléter' : 'Voir les {count} autres points à compléter', { count: helpItems.length - 1 })}</summary>
          <p>{t("Vous pouvez commencer par le premier point. Votre saisie reste dans ce formulaire pendant les corrections.")}</p>
          {helpItems.slice(1).map(renderHelp)}
        </details>
      )}
    </div>
  );
}
