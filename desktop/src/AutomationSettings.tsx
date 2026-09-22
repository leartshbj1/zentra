import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Workflow } from 'lucide-react';
import { useCompanyAutomation } from './AutomationCompany';
import { AutomationSetup } from './AutomationControls';
import { saveAutomationSettings, openAutomationSettings, type AutomationState } from './automation';
import { automationFeatures } from './automationFeatures';
import { automationReadiness, openAutomationHub, readinessLabels, recommendedAutomationSettings } from './automationExperience';
import { t, useAppLanguage } from './language';
import { Button } from './ui';
import './AutomationSettings.css';
import './workflow-clarity.css';
import {SupplierHabits} from './SupplierHabits';
import { AutomationConnectionNotice } from './AutomationConnectionNotice';

export function AutomationSettings({ showHubLink = false }: { showHubLink?: boolean }) {
  useAppLanguage();
  const { state, organizationId, status } = useCompanyAutomation();
  if (status === 'loading') return <section className="automation-settings" role="status"><p>{t('Retrouvons votre espace Automation…')}</p></section>;
  if (!organizationId) return <section className="automation-settings"><h3>{t('Reliez votre entreprise')}</h3><p>{t('Connectez cette entreprise à votre compte pour retrouver son accès partagé.')}</p><Button variant="secondary" onClick={() => window.dispatchEvent(new Event('zentra-automation-account'))}>{t('Ouvrir le compte')}</Button></section>;
  if (!state) return <AutomationConnectionNotice />;
  if (!state?.active) return <AutomationSetup />;
  return <><CompanySettings key={state.organizationId} state={state} />{showHubLink && <Button variant="secondary" onClick={() => openAutomationHub()}>{t('Ouvrir l’espace Automation')}</Button>}</>;
}

function CompanySettings({ state }: { state: AutomationState }) {
  useAppLanguage();
  const { refresh, readOnly } = useCompanyAutomation();
  const [draft, setDraft] = useState(state.settings), [baseline, setBaseline] = useState(JSON.stringify(state.settings));
  const [consent, setConsent] = useState(state.settings.consent), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const dirty = JSON.stringify({ ...draft, consent }) !== baseline;
  const canManage = state.canManage && !readOnly;
  const current = JSON.stringify(state.settings);
  const changedElsewhere = dirty && baseline !== current;
  useEffect(() => {
    if (!dirty && !busy) { setDraft(state.settings); setBaseline(current); setConsent(state.settings.consent); }
  }, [current]);
  return <section className="automation-settings">
    <header><Workflow size={26} /><div><h3>{t('Automation de cet espace')}</h3><p>{t('Ces réglages s’appliquent à toute son équipe.')}</p></div></header>
    <span className="automation-settings__status">{t(readinessLabels[automationReadiness(state)])}</span>
    {!canManage && <p className="automation-settings__notice">{t('Vous bénéficiez des fonctions activées. Le titulaire ou un administrateur gère les réglages.')}</p>}
    {canManage && (!state.settings.consent || !state.settings.flags.length) && <div className="automation-settings__quickstart">
      <strong>{t('Un démarrage simple')}</strong><p>{t('Préparez les fonctions disponibles en mode suggestion. Vous relisez les résultats avant toute action.')}</p>
      <Button variant="secondary" disabled={busy || !state.available.length} onClick={() => { setDraft(recommendedAutomationSettings(state)); setMessage('Réglages préparés. Vérifiez votre accord puis enregistrez pour l’équipe.'); }}>{t('Utiliser les réglages conseillés')}</Button>
    </div>}
    <fieldset disabled={!canManage || busy}>
      <legend>{t('Fonctionnement')}</legend>
      <label className="automation-settings__toggle"><span><strong>{t('Activer les suggestions')}</strong><small>{t('Vous gardez la validation des actions importantes.')}</small></span><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /></label>
      <p className="automation-settings__current-mode">{t(draft.mode === 'shadow' ? 'Observation · sans modifier vos choix' : 'Suggestions · vérifier puis confirmer')}</p>
    </fieldset>
    <details className="workflow-options"><summary>{t('Fonctions activées')} <span>{draft.flags.filter(feature => state.available.includes(feature)).length} / {state.available.length}</span></summary><fieldset disabled={!canManage || busy}>
      <legend>{t('Les fonctions de votre équipe')}</legend>
      <div className="automation-settings__features">{Object.entries(automationFeatures).map(([key, item]) => {
        const feature = key as keyof typeof automationFeatures;
        const available = state.available.includes(feature);
        return <label className="automation-settings__toggle" key={key}><span><strong>{t(item.title)}</strong><small>{t(available ? item.description : 'Cette fonction n’est pas encore disponible.')}</small></span><input type="checkbox" checked={available && draft.flags.includes(feature)} disabled={!available} onChange={e => setDraft({ ...draft, flags: e.target.checked ? [...draft.flags, feature] : draft.flags.filter(f => f !== feature) })} /></label>;
      })}</div>
    </fieldset></details>
    {canManage && <>
      {!state.settings.consent && <label className="automation-settings__consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} /><span>{t('J’autorise l’analyse en ligne des extraits nécessaires pour cette entreprise.')}</span></label>}
      {draft.enabled && !consent && <p>{t('Cochez votre accord ci-dessus pour enregistrer l’activation.')}</p>}
      <details className="workflow-options"><summary>{t('Réglages avancés')}</summary><label className="automation-settings__mode"><span>{t('Mode')}</span><select disabled={busy} value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value as 'suggest' | 'shadow' })}><option value="suggest">{t('Suggestions · vérifier puis confirmer')}</option><option value="shadow">{t('Observation · sans modifier vos choix')}</option></select></label><div className="automation-settings__thresholds">
        <label>{t('Suggestion à partir de (%)')}<input type="number" min="50" max="99" step="1" disabled={busy} value={Math.round(draft.thresholds.medium * 100)} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, medium: Number(e.target.value) / 100 } })} /></label>
        <label>{t('Confiance élevée à partir de (%)')}<input type="number" min="51" max="100" step="1" disabled={busy} value={Math.round(draft.thresholds.high * 100)} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, high: Number(e.target.value) / 100 } })} /></label>
      </div></details>
      {changedElsewhere && <p role="status">{t('Les réglages de l’équipe ont changé. Rechargez-les avant de continuer.')} <Button variant="ghost" disabled={busy} onClick={() => { setDraft(state.settings); setBaseline(current); setConsent(state.settings.consent); }}>{t('Recharger les réglages')}</Button></p>}
      <Button disabled={busy || !dirty || changedElsewhere || (draft.enabled && !consent)} onClick={async () => {
        if (draft.thresholds.medium < .5 || draft.thresholds.high > 1 || draft.thresholds.medium >= draft.thresholds.high) { setMessage('Le premier seuil doit être inférieur au second, entre 50 et 100 %.'); return; }
        setBusy(true); setMessage('');
        try {
          const result = await saveAutomationSettings(draft, consent);
          setDraft(result); setBaseline(JSON.stringify(result)); setConsent(result.consent);
          await refresh(); setMessage('Les réglages sont enregistrés pour toute votre équipe.');
        } catch { await refresh(); setMessage('Les réglages n’ont pas été enregistrés. Réessayez après avoir vérifié l’état du compte et d’Automation.'); }
        finally { setBusy(false); }
      }}><Check size={17} />{t(busy ? 'Enregistrement…' : 'Enregistrer pour toute l’équipe')}</Button>
    </>}
    {message && <p role="status">{t(message)}</p>}
    <details className="workflow-options"><summary>{t('Factures et rendez-vous reçus par e-mail')}</summary><div className="automation-settings__quickstart"><p>{t('Reliez Support pour recevoir les factures fournisseurs dans Gestion. L’enregistrement automatique s’active séparément pour cette entreprise.')}</p><Button variant="secondary" onClick={()=>void invoke('open_supplier_inbox_settings').catch(()=>setMessage('Ouvrez zentraapp.ch/support/espace dans votre navigateur.'))}>{t('Régler la réception des factures')}</Button></div><p>{t('Les rendez-vous rejoignent l’agenda avec les suggestions « E-mails importés ». Les informations incomplètes restent à vérifier.')}</p></details>
    <details className="workflow-options"><summary>{t('Habitudes de classement')}</summary><SupplierHabits key={state.organizationId} org={state.organizationId} manage={canManage}/></details>
    <Button variant="ghost" onClick={() => void openAutomationSettings().catch(() => setMessage('Ouvrez zentraapp.ch/compte/automation dans votre navigateur.'))}>{t('Confidentialité et abonnement')}</Button>
  </section>;
}
