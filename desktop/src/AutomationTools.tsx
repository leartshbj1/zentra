import { useState } from 'react';
import { Workflow } from 'lucide-react';
import { useCompanyAutomation } from './AutomationCompany';
import { AutomationChoice, AttentionSuggestion, DocumentClassification, useAutomation } from './AutomationControls';
import { AutomationDocumentReader } from './AutomationDocument';
import { featureReady, actionLabels, bankCategories, automationFeedback } from './automation';
import { openAutomationHub } from './automationExperience';
import type { Workspace } from './types';
import { Button } from './ui';
import { t, useAppLanguage } from './language';
import './AutomationTools.css';

export function automationToolsForScreen(screen: string) {
  if (screen === 'automation') return ['assistant', 'document', 'bank', 'priority', 'email'] as const;
  const tools: ('document' | 'bank' | 'priority' | 'assistant' | 'email')[] = ['assistant'];
  if (['projects', 'quotes', 'orders', 'invoices', 'expenses', 'team', 'accounting', 'reports'].includes(screen)) tools.unshift('document');
  if (['bank', 'accounting'].includes(screen)) tools.unshift('bank');
  if (['invoices', 'reminders', 'agenda', 'expenses'].includes(screen)) tools.unshift('priority');
  if (screen === 'expenses') tools.unshift('email');
  return tools;
}
const kinds = {
  document: { title: 'Classer un document', feature: 'document_routing' },
  bank: { title: 'Classer une opération', feature: 'transaction_classification' },
  priority: { title: 'Examiner une échéance', feature: 'priority' },
  assistant: { title: 'Trouver le bon écran', feature: 'agent_routing' },
  email: { title: 'Classer un e-mail', feature: 'email_classification' },
} as const;

export function AutomationTools({ screen, workspace, expanded = false }: { screen: string; workspace: Workspace; expanded?: boolean }) {
  useAppLanguage();
  const { state } = useCompanyAutomation();
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<keyof typeof kinds | null>(null);
  const available = automationToolsForScreen(screen).filter(key => featureReady(state, kinds[key].feature));
  if (!state?.active || !available.length) return null;
  const chosen = selected && available.includes(selected) ? selected : available[0];
  const content = <div className="automation-tools__content">
      <div className="automation-tools__tabs" role="group" aria-label={t('Choisir un outil Automation')}>{available.map(key => <Button key={key} size="small" variant={chosen === key ? 'secondary' : 'ghost'} aria-pressed={chosen === key} onClick={() => setSelected(key)}>{t(kinds[key].title)}</Button>)}</div>
      <AutomationTool key={chosen} kind={chosen} workspace={workspace} />
      {!expanded && <div className="automation-tools__manage"><Button size="small" variant="ghost" onClick={() => openAutomationHub()}>{t('Ouvrir l’espace Automation')}</Button></div>}
    </div>;
  if (expanded) return <div className="automation-tools__expanded">{content}</div>;
  return <details className="automation-tools" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary><Workflow size={17} aria-hidden="true" /><span>Zentra Automation</span><span className="automation-tools__hint">{t('Les outils de cet écran')}</span></summary>
    {open && content}
  </details>;
}

function AutomationTool({ kind, workspace }: { kind: keyof typeof kinds; workspace: Workspace }) {
  const { readOnly } = useCompanyAutomation();
  const [draft, setDraft] = useState(''), [submitted, setSubmitted] = useState(''), [invoiceId, setInvoiceId] = useState(''), [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const invoices = workspace.invoices.filter(i => ['issued', 'partially_paid'].includes(i.status));
  const invoice = invoices.find(i => i.id === invoiceId);
  const feature = kinds[kind].feature;
  const decision = useAutomation(feature, ['bank', 'email', 'assistant'].includes(kind) && submitted ? { text: submitted } : null, `tool:${kind}:${attempt}`);
  const analyzing = Boolean(submitted && (!decision || decision.status === 'pending'));
  if (kind === 'document') return <div className="automation-tools__form"><AutomationDocumentReader onRead={setSubmitted} />{submitted && <DocumentClassification text={submitted} identity={`tool:${submitted.slice(0, 64)}`} />}</div>;
  if (kind === 'priority') return <div className="automation-tools__form">
    <label>{t('Facture à examiner')}<select value={invoiceId} onChange={e => setInvoiceId(e.target.value)}><option value="">{t('Choisir une facture')}</option>{invoices.map(i => <option key={i.id} value={i.id}>{i.number} · {i.dueDate}</option>)}</select></label>
    {!invoices.length && <p>{t('Aucune facture émise à examiner pour le moment.')}</p>}
    {invoice && <AttentionSuggestion context={{ dueDate: invoice.dueDate, resolved: false }} identity={`dashboard-priority:${invoice.id}`} />}
  </div>;
  const action = decision?.status === 'suggestion' ? decision.choices?.action : undefined;
  return <div className="automation-tools__form">
    <label>{t(kind === 'assistant' ? 'Que souhaitez-vous faire ?' : kind === 'bank' ? 'Libellé de l’opération' : 'Extrait du message')}<textarea maxLength={1500} value={draft} onChange={e => setDraft(e.target.value)} placeholder={t(kind === 'assistant' ? 'Exemple : préparer un devis' : kind === 'bank' ? 'Exemple : achat de fournitures' : 'Collez l’extrait utile du message')} /></label>
    <Button size="small" variant="secondary" disabled={!draft.trim() || analyzing} onClick={() => { setSubmitted(draft.trim()); setAttempt(value => value + 1); setMessage(''); }}>{t(analyzing ? 'Analyse en cours…' : 'Analyser')}</Button>
    {analyzing && <p role="status">{t('Vous pouvez continuer à utiliser l’application.')}</p>}
    {kind !== 'assistant' && <AutomationChoice decision={decision} question={kind === 'bank' ? 'category' : 'type'} disabled={readOnly} labels={kind === 'bank' ? bankCategories : { quote: 'Demande de devis', invoice: 'Facture', complaint: 'Réclamation', question: 'Question', support: 'Support', payment: 'Paiement', administration: 'Administratif', other: 'Autre' }} />}
    {kind === 'assistant' && action && action !== 'other' && actionLabels[action] && <Button variant="secondary" onClick={() => {
      if (readOnly && ['create_invoice', 'create_quote', 'create_task'].includes(action)) { setMessage('Votre accès permet la consultation uniquement.'); return; }
      void automationFeedback(decision, { action });
      window.dispatchEvent(new CustomEvent('zentra-automation-action', { detail: action }));
    }}>{t(actionLabels[action])}</Button>}
    {kind === 'assistant' && decision && (decision.status === 'manual' || action === 'other') && <p>{t('Précisez votre demande ou utilisez le menu de l’application.')}</p>}
    {kind === 'assistant' && decision?.status === 'shadow' && <p>{t('Analyse enregistrée en mode observation.')}</p>}
    {message && <p role="status">{t(message)}</p>}
  </div>;
}
