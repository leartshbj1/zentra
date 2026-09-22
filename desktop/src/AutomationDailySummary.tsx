import { type AutomationState } from './automation';
import { useCompanyAutomation } from './AutomationCompany';
import { useAppLanguage } from './language';
import { openAutomationHub } from './automationExperience';
import { AutomationBrief } from './AutomationBrief';

export function AutomationDailySummary({ link = false }: { link?: boolean }) {
  const { state } = useCompanyAutomation();
  return state ? <AutomationDailySummaryView state={state} link={link} /> : null;
}
export function AutomationDailySummaryView({ state, link = false }: { state: AutomationState; link?: boolean }) {
  const language = useAppLanguage();
  if (!state.active || !state.activity) return null;
  const paused = !state.settings.enabled || !state.settings.consent || !state.available.some(f => state.settings.flags.includes(f));
  return <AutomationBrief activity={state.activity} compact={link} paused={paused} observation={state.settings.mode==='shadow'} language={language} onOpen={destination=>openAutomationHub(destination==='review'?'centre':destination==='support'?'overview':destination)}/>;
}
