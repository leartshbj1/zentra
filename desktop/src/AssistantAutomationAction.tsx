import { useAutomation } from './AutomationControls';
import { actionLabels, automationFeedback } from './automation';
import { Button } from './ui';
import { t, useAppLanguage } from './language';
export function AssistantAutomationAction({
  text,
  close,
}: {
  text: string;
  close: () => void;
}) {
  useAppLanguage();
  // Local Qwen has already answered. Routing only needs the short user intent,
  // not the conversation history, payroll fields, balances, or customer list.
  const decision = useAutomation(
    'agent_routing',
    text ? { text: text.slice(0, 900) } : null,
  );
  const action = decision?.choices?.action;
  if (
    decision?.status !== 'suggestion' ||
    !action ||
    action === 'other' ||
    !actionLabels[action]
  )
    return null;
  return (
    <div className="automation-choice">
      <span className="automation-eyebrow">{t('Suggestion Zentra')}</span>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          void automationFeedback(decision, { action });
          close();
          requestAnimationFrame(() =>
            window.dispatchEvent(
              new CustomEvent('zentra-automation-action', { detail: action }),
            ),
          );
        }}
      >
        {t(actionLabels[action])}
      </Button>
      <small>
        {t(
          'Le formulaire s’ouvre pour vérification. Rien n’est enregistré sans votre confirmation.',
        )}
      </small>
    </div>
  );
}
