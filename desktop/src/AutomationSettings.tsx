import { useEffect, useState } from 'react';
import { Check, Workflow } from 'lucide-react';
import { useCompanyAutomation } from './AutomationCompany';
import { AutomationSetup } from './AutomationControls';
import { saveAutomationSettings, openAutomationSettings, type AutomationState } from './automation';
import { automationFeatures } from './automationFeatures';
import { t, useAppLanguage } from './language';
import { Button } from './ui';
import './AutomationSettings.css';

export function AutomationSettings() {
  useAppLanguage();
  const { state, organizationId, refresh } = useCompanyAutomation();
  if (!state && organizationId) return <section className="automation-settings"><h3>Zentra Automation</h3><p>{t('Connectez-vous à Internet pour retrouver les réglages de votre équipe.')}</p><Button variant="secondary" onClick={() => void refresh()}>{t('Réessayer')}</Button></section>;
  if (!state?.active) return <AutomationSetup />;
  return <CompanySettings key={state.organizationId} state={state} />;
}

function CompanySettings({ state }: { state: AutomationState }) {
  useAppLanguage();
  const { refresh, readOnly } = useCompanyAutomation();
  const [draft, setDraft] = useState(state.settings), [baseline, setBaseline] = useState(JSON.stringify(state.settings));
  const [consent, setConsent] = useState(state.settings.consent), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const dirty = JSON.stringify(draft) !== baseline || consent !== state.settings.consent;
  const canManage = state.canManage && !readOnly;
  const current = JSON.stringify(state.settings);
  const changedElsewhere = dirty && baseline !== current;
  useEffect(() => {
    if (!dirty && !busy) { setDraft(state.settings); setBaseline(current); setConsent(state.settings.consent); }
  }, [current]);
  return <section className="automation-settings">
    <header><Workflow size={26} /><div><h3>{t('Automation pour toute votre équipe')}</h3><p>{t('Un seul réglage pour tous les collaborateurs de cette entreprise.')}</p></div></header>
    {!canManage && <p className="automation-settings__notice">{t('Vous bénéficiez des fonctions activées. Le titulaire ou un administrateur gère les réglages.')}</p>}
    <fieldset disabled={!canManage || busy}>
      <legend>{t('Fonctionnement')}</legend>
      <label className="automation-settings__toggle"><span><strong>{t('Activer les suggestions')}</strong><small>{t('Vous gardez la validation des actions importantes.')}</small></span><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /></label>
      <label className="automation-settings__mode"><span>{t('Mode')}</span><select value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value as 'suggest' | 'shadow' })}><option value="suggest">{t('Suggestions · vérifier puis confirmer')}</option><option value="shadow">{t('Observation · sans modifier vos choix')}</option></select></label>
    </fieldset>
    <fieldset disabled={!canManage || busy}>
      <legend>{t('Les fonctions de votre équipe')}</legend>
      <div className="automation-settings__features">{Object.entries(automationFeatures).map(([key, item]) => {
        const feature = key as keyof typeof automationFeatures;
        const available = state.available.includes(feature);
        return <label className="automation-settings__toggle" key={key}><span><strong>{t(item.title)}</strong><small>{t(available ? item.description : 'Cette fonction n’est pas encore disponible.')}</small></span><input type="checkbox" checked={available && draft.flags.includes(feature)} disabled={!available} onChange={e => setDraft({ ...draft, flags: e.target.checked ? [...draft.flags, feature] : draft.flags.filter(f => f !== feature) })} /></label>;
      })}</div>
    </fieldset>
    {canManage && <>
      {!state.settings.consent && <label className="automation-settings__consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} /><span>{t('J’autorise l’analyse en ligne des extraits nécessaires pour cette entreprise.')}</span></label>}
      <details><summary>{t('Réglages avancés')}</summary><div className="automation-settings__thresholds">
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
        } catch { setMessage('Les réglages n’ont pas été enregistrés. Vérifiez votre connexion puis réessayez.'); }
        finally { setBusy(false); }
      }}><Check size={17} />{t(busy ? 'Enregistrement…' : 'Enregistrer pour toute l’équipe')}</Button>
    </>}
    {message && <p role="status">{t(message)}</p>}
    <Button variant="ghost" onClick={() => void openAutomationSettings().catch(() => setMessage('Ouvrez zentraapp.ch/compte/automation dans votre navigateur.'))}>{t('Confidentialité et abonnement')}</Button>
  </section>;
}
