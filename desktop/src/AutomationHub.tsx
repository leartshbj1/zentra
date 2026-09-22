import { ArrowLeft, ArrowRight, Banknote, FileText, Package, Receipt, Workflow } from 'lucide-react';
import { useCompanyAutomation } from './AutomationCompany';
import { AutomationBrief, type BriefDestination } from './AutomationBrief';
import { AutomationSettings } from './AutomationSettings';
import { AutomationTools } from './AutomationTools';
import { automationReadiness, automationWorkflows, workflowReady, type AutomationDestination, type AutomationPage } from './automationExperience';
import { t, useAppLanguage } from './language';
import type { Workspace } from './types';
import { Button } from './ui';
import './AutomationHub.css';
import { AutomationConnectionNotice } from './AutomationConnectionNotice';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AutomationControlCentre } from './AutomationControlCentre';

const icons = { bank: Banknote, projects: FileText, expenses: Receipt, invoices: Receipt, catalog: Package, settings: Workflow };

export function AutomationHub({ workspace, page, onPage, onNavigate, inboxPanel, appointmentPanel }: {
  workspace: Workspace; page: AutomationPage; onPage: (page: AutomationPage) => void; onNavigate: (view: AutomationDestination) => void;
  inboxPanel?: ReactNode; appointmentPanel?: ReactNode;
}) {
  const language = useAppLanguage();
  const { state, status, refresh, readOnly } = useCompanyAutomation();
  if (!state && status === 'unavailable') return <div className="automation-hub"><AutomationConnectionNotice /></div>;
  if (!state) return <section className="automation-hub automation-hub__empty" aria-busy={status === 'loading'}>
    <Workflow size={32} aria-hidden="true" />
    <h2>{t(status === 'loading' ? 'Retrouvons votre espace Automation…' : status === 'disconnected' ? 'Reliez votre entreprise' : 'Automation attend la connexion')}</h2>
    <p>{t(status === 'disconnected' ? 'Connectez cette entreprise à votre compte pour retrouver son accès partagé.' : status === 'loading' ? 'Les réglages de votre entreprise arrivent.' : 'Vos outils de gestion restent disponibles. Automation reviendra automatiquement avec la connexion.')}</p>
    {status === 'disconnected' ? <Button onClick={() => onNavigate('settings')}>{t('Ouvrir le compte')}</Button> : status !== 'loading' && <Button variant="secondary" onClick={() => void refresh()}>{t('Réessayer')}</Button>}
  </section>;
  if (!state.active) return <div className="automation-hub"><AutomationSettings /></div>;
  const readiness = automationReadiness(state);
  const ready = readiness === 'ready' || readiness === 'observation';
  const canManage = state.canManage && !readOnly;
  const followup = ['centre','work','history'].includes(page);
  const open = (destination: BriefDestination) => {
    if (destination === 'support') { void invoke('open_supplier_inbox_settings',{section:'inbox'}).catch(()=>onPage('settings')); return; }
    onPage(destination === 'review' ? 'centre' : destination);
  };
  return <div className="automation-hub">
    <nav className="automation-hub__navigation" aria-label={t('Espace Automation')}>
      {(['overview', 'centre', 'settings'] as const).map(tab => <button key={tab} type="button" aria-current={(tab==='centre'?followup:tab==='settings'?page==='settings'||page==='rules':!followup&&page!=='settings'&&page!=='rules') ? 'page' : undefined} onClick={() => onPage(tab)}>{t(tab === 'overview' ? 'Aujourd’hui' : tab === 'centre' ? 'Suivi' : 'Réglages')}</button>)}
    </nav>
    {!ready && <div className="automation-hub__welcome">
        <div><h2>{t(readiness === 'consent' ? 'Votre accès est actif. Commençons.' : 'Retrouvez vos suggestions')}</h2><p>{t(canManage ? 'Choisissez les fonctions de votre équipe dans les réglages. Tout se passe ici, dans Zentra.' : 'Votre accès est inclus. Le titulaire ou un administrateur peut terminer les réglages pour toute l’équipe.')}</p></div>
        <Button onClick={() => onPage('settings')}>{t(canManage ? 'Configurer mon équipe' : 'Voir les réglages')}<ArrowRight size={17} aria-hidden="true" /></Button>
      </div>}
    {page === 'overview' && <><AutomationBrief activity={state.activity} paused={!ready} observation={readiness==='observation'} language={language} onOpen={open}/><div className="automation-hub__more"><Button variant="ghost" onClick={()=>onPage('tools')}>{t('Les outils de cet écran')}<ArrowRight size={16}/></Button></div></>}
    {(page === 'invoices' || page === 'appointments') && <section className="automation-hub__focused"><Button variant="ghost" onClick={()=>onPage('overview')}><ArrowLeft size={16}/>{t('Aujourd’hui')}</Button>{page==='invoices'?inboxPanel:appointmentPanel}</section>}
    {page === 'tools' && <section aria-label={t('Outils')}>
      <Button variant="ghost" onClick={()=>onPage('overview')}><ArrowLeft size={16}/>{t('Aujourd’hui')}</Button>
      <div className="automation-hub__section-title"><div><h2>{t('Que souhaitez-vous avancer ?')}</h2><p>{t('Retrouvez chaque aide dans son écran de gestion.')}</p></div></div>
      <div className="automation-hub__workflows">{automationWorkflows.map(flow => {
        const enabled = workflowReady(state, flow.features);
        const available = flow.features.some(feature => state.available.includes(feature));
        const Icon = icons[flow.destination];
        return <article key={flow.destination}>
          <Icon size={23} aria-hidden="true" />
          <div className="automation-hub__workflow-copy"><h3>{t(flow.title)}</h3><p>{t(flow.description)}</p><span className="automation-hub__feature-state">{t(enabled ? (state.settings.mode === 'shadow' ? 'Observation' : 'Suggestions actives') : available ? 'À configurer' : 'Indisponible pour le moment')}</span></div>
          <Button size="small" variant="secondary" aria-label={`${t(enabled ? 'Ouvrir' : 'Voir les réglages')} · ${t(flow.title)}`} onClick={() => enabled ? onNavigate(flow.destination) : onPage('settings')}>{t(enabled ? 'Ouvrir' : 'Voir les réglages')}<ArrowRight size={15} aria-hidden="true" /></Button>
        </article>;
      })}</div>
      {ready ? <AutomationTools screen="automation" workspace={workspace} expanded /> : <div className="automation-hub__welcome"><p>{t('Terminez les réglages pour retrouver les outils de votre équipe.')}</p><Button onClick={() => onPage('settings')}>{t('Voir les réglages')}</Button></div>}
    </section>}
    {followup && <AutomationControlCentre key={state.organizationId} organizationId={state.organizationId} initialTab={page==='history'?'history':page==='work'?'work':'review'} embedded hideRules request={data=>invoke('automation_request',{data})} />}
    {page === 'settings' && <section aria-label={t('Réglages')} className="automation-hub__settings"><Button variant="secondary" onClick={()=>onPage('rules')}>{t('Règles de l’équipe')}<ArrowRight size={16}/></Button><AutomationSettings /></section>}
    {page === 'rules' && <><Button variant="ghost" onClick={()=>onPage('settings')}><ArrowLeft size={16}/>{t('Réglages')}</Button><AutomationControlCentre key={state.organizationId} organizationId={state.organizationId} initialTab="rules" embedded hideNavigation request={data=>invoke('automation_request',{data})}/></>}
  </div>;
}
