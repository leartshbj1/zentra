import { useEffect, useState } from 'react';
import { useCompanyAutomation } from './AutomationCompany';
import { ZentraArrival } from './OnboardingIntro';
import { openAutomationHub } from './automationExperience';
import { automationWelcomeKey, hasConfirmedAutomationAccess, hasSeenAutomationWelcome, rememberAutomationWelcome } from './automationWelcomeState';
import { t, useAppLanguage } from './language';
import { Modal } from './ui';
import './automation-welcome.css';

/** Opens at a quiet moment after confirmed company access. Never interrupts an editor or another dialog. */
export function AutomationWelcome({ view }: { view: string }) {
  useAppLanguage();
  const company = useCompanyAutomation();
  const id = company.organizationId;
  const confirmed = hasConfirmedAutomationAccess(company, id);
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [destination, setDestination] = useState<'settings' | 'overview' | null>(null);
  useEffect(() => {
    // Navigation guards deliberately refuse to navigate while any dialog is still mounted.
    if (!open && destination) { if (confirmed) openAutomationHub(destination); setDestination(null); }
  }, [open, destination, confirmed]);
  useEffect(() => {
    const replay = (event: Event) => {
      if (confirmed && (event as CustomEvent).detail === id) setRequested(true);
    };
    window.addEventListener('zentra-automation-welcome', replay);
    return () => window.removeEventListener('zentra-automation-welcome', replay);
  }, [confirmed, id]);
  useEffect(() => {
    if (!confirmed || !id) { setOpen(false); setRequested(false); return; }
    if (open || (!requested && (dismissed || hasSeenAutomationWelcome(id)))) return;
    if (!requested && !['dashboard', 'automation'].includes(view)) return;
    const showWhenIdle = () => {
      if (document.hidden || document.querySelector('[role="dialog"], [aria-busy="true"]')) return;
      if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return;
      setOpen(true);
    };
    const timer = window.setInterval(showWhenIdle, 1000);
    return () => window.clearInterval(timer);
  }, [confirmed, id, open, requested, dismissed, view]);
  if (!open || !confirmed || !id || !company.state) return null;
  const needsSetup = company.state.canManage && !company.readOnly && (!company.state.settings.consent || !company.state.settings.enabled || !company.state.settings.flags.length);
  const close = () => { rememberAutomationWelcome(id); setDismissed(true); setRequested(false); setOpen(false); };
  return <Modal className="automation-welcome" title={t('Bienvenue dans Zentra Automation')} assistantHelp={false} onClose={close}>
    <ZentraArrival product="automation" storageKey={automationWelcomeKey(id)} forceReplay={requested}
      startLabel={needsSetup ? 'Configurer Automation' : 'Découvrir Automation'}
      subtitle={needsSetup ? 'Choisissez ce qu’Automation fera pour votre équipe.' : 'Votre accès Automation est actif pour cet espace.'}
      onStart={() => { close(); setDestination(needsSetup ? 'settings' : 'overview'); }} />
  </Modal>;
}
