import { useAutomation } from './AutomationControls';
import { actionLabels, automationFeedback } from './automation';
import { Button } from './ui';
import { t, useAppLanguage } from './language';
import { useSyncExternalStore } from 'react';
import { getAppOpeningPermit, isAppOpeningPermitCurrent, subscribeAppOpening } from './appOpening';
export function AssistantAutomationAction({
  text,
  close,
}: {
  text: string;
  close: () => void;
}) {
  useAppLanguage();
  const openingPermit = useSyncExternalStore(subscribeAppOpening, getAppOpeningPermit, () => null);
  // Local Qwen has already answered. Routing only needs the short user intent,
  // not the conversation history, payroll fields, balances, or customer list.
  const decision = useAutomation(
    'agent_routing',
    openingPermit && text ? { text: text.slice(0, 900) } : null,
  );
  const action = decision?.choices?.action;
  if (
    !openingPermit || decision?.status !== 'suggestion' ||
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
          if (!isAppOpeningPermitCurrent(openingPermit)) return;
          void automationFeedback(decision, { action });
          close();
          requestAnimationFrame(() => {
            if (!isAppOpeningPermitCurrent(openingPermit)) return;
            window.dispatchEvent(
              new CustomEvent('zentra-automation-action', { detail: action }),
            );
          });
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
