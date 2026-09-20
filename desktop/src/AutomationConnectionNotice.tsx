import { useCompanyAutomation } from './AutomationCompany';
import { automationConnectionMessages } from './automationConnection';
import { Button } from './ui';
import { t } from './language';

export function AutomationConnectionNotice() {
  const { problem, refresh } = useCompanyAutomation();
  const message = automationConnectionMessages[problem ?? 'service'];
  return <section className="automation-settings" role="status">
    <h3>{t(message.title)}</h3><p>{t(message.body)}</p>
    {message.account && <Button variant="secondary" onClick={() => window.dispatchEvent(new Event('zentra-automation-account'))}>{t('Ouvrir Compte et équipe')}</Button>}
    <Button variant="ghost" onClick={() => void refresh()}>{t('Réessayer')}</Button>
  </section>;
}
