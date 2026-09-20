import { featureReady, type AutomationFeature, type AutomationState } from './automation';

export type AutomationPage = 'overview' | 'tools' | 'settings';
export type AutomationDestination = 'bank' | 'projects' | 'expenses' | 'catalog' | 'invoices' | 'settings';
export function automationReadiness(state: AutomationState) {
  if (!state.active) return 'inactive';
  if (!state.settings.consent) return 'consent';
  if (!state.settings.enabled) return 'paused';
  if (!state.available.length) return 'unavailable';
  if (!state.available.some(f => state.settings.flags.includes(f))) return 'empty';
  return state.settings.mode === 'shadow' ? 'observation' : 'ready';
}
export const readinessLabels = {
  inactive: 'Option non active', consent: 'Configuration à terminer', paused: 'Suggestions en pause',
  unavailable: 'Service indisponible', empty: 'Fonctions à choisir', observation: 'Mode observation', ready: 'Prêt pour toute l’équipe',
} as const;

export const automationWorkflows: { features: AutomationFeature[]; title: string; description: string; destination: AutomationDestination }[] = [
  { features: ['transaction_classification', 'anomaly_detection'], title: 'Banque & comptabilité', description: 'Classez les opérations et repérez celles à vérifier.', destination: 'bank' },
  { features: ['document_routing'], title: 'Documents & projets', description: 'Identifiez un document et retrouvez le bon écran.', destination: 'projects' },
  { features: ['supplier_routing', 'email_classification'], title: 'Achats & fournisseurs', description: 'Préparez vos achats à partir des documents reçus.', destination: 'expenses' },
  { features: ['priority'], title: 'Factures & échéances', description: 'Examinez les factures qui demandent votre attention.', destination: 'invoices' },
  { features: ['import_mapping'], title: 'Catalogue & imports', description: 'Associez les colonnes avant d’importer vos articles.', destination: 'catalog' },
];
export function workflowReady(state: AutomationState | null, features: AutomationFeature[]) { return features.some(f => featureReady(state, f)); }

/** An explicit draft preset, not a consent grant or an automatic server write. */
export function recommendedAutomationSettings(state: AutomationState): AutomationState['settings'] {
  return { ...state.settings, enabled: true, mode: 'suggest', flags: [...state.available], thresholds: { medium: .75, high: .95 } };
}

export function openAutomationHub(page: AutomationPage = 'overview') {
  window.dispatchEvent(new CustomEvent('zentra-automation-hub', { detail: page }));
}
