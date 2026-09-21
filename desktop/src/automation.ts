import { invoke } from '@tauri-apps/api/core';
import type { BankMovement } from './types';
export type AutomationFeature =
  | 'transaction_classification'
  | 'document_routing'
  | 'supplier_routing'
  | 'agent_routing'
  | 'anomaly_detection'
  | 'priority'
  | 'email_classification'
  | 'import_mapping';
export type AutomationState = {
  organizationId: string;
  active: boolean;
  canManage: boolean;
  available: AutomationFeature[];
  activity?: AutomationActivity | null;
  settings: {
    revision?: number;
    enabled: boolean;
    consent: boolean;
    mode: 'shadow' | 'suggest';
    flags: AutomationFeature[];
    thresholds: { medium: number; high: number };
  };
};
export type AutomationCounts = {
  analyzed: number;
  suggestions: number;
  confirmed: number;
  needsReview: number;
  observed: number;
};
export type AutomationActivity = {
  appointments?:{imported:number;pending:number};
  supplierInbox?:{received:number;imported:number;automatic:number;needsReview:number;recent:{id:string;subject:string;state:string;automatic:number;imported_at:number}[]};
  date: string;
  timeZone: string;
  updatedAt: number;
  displayName: string | null;
  totals: AutomationCounts;
  features: (AutomationCounts & { feature: AutomationFeature })[];
};
export type AutomationDecision = {
  id?: string;
  status: 'suggestion' | 'manual' | 'shadow' | 'pending' | 'disabled';
  choices?: Record<string, string>;
  finalChoices?: Record<string, string>;
  feedback?: string;
  resourceIds?: Record<string, string | null>;
  confidence?: number;
  band?: 'low' | 'medium' | 'high';
  workflow?: string | null;
  message?: string;
};
export const bankCategories: Record<string, string> = {
  salary: 'Salaires',
  rent: 'Loyer',
  material: 'Matériel et marchandises',
  software: 'Logiciels',
  telecom: 'Télécommunications',
  insurance: 'Assurances',
  transport: 'Transport',
  meals: 'Restauration',
  marketing: 'Marketing',
  bank_fees: 'Frais bancaires',
  tax: 'Impôts et taxes',
  supplier: 'Fournisseur',
  refund: 'Remboursement',
  customer_income: 'Revenu client',
  other: 'Autre',
};
export const documentTypes: Record<string, string> = {
  supplier_invoice: 'Facture fournisseur',
  customer_invoice: 'Facture client',
  quote: 'Devis',
  payslip: 'Fiche de salaire',
  contract: 'Contrat',
  bank_statement: 'Relevé bancaire',
  receipt: 'Reçu',
  evidence: 'Justificatif',
  tax_document: 'Document fiscal',
  other: 'Autre',
};
export const actionLabels: Record<string, string> = {
  create_invoice: 'Préparer une facture',
  create_quote: 'Préparer un devis',
  search_customer: 'Rechercher un client',
  search_supplier: 'Rechercher un fournisseur',
  search_invoice: 'Rechercher une facture',
  get_bank_transactions: 'Voir les opérations bancaires',
  classify_transaction: 'Classer une opération',
  analyze_expenses: 'Voir les dépenses',
  get_project: 'Voir les projets',
  create_task: 'Préparer une tâche',
  search_document: 'Rechercher un document',
  other: 'Autre',
};
export const workflowScreens: Record<string, string> = {
  purchases: 'purchases',
  invoices: 'invoices',
  quotes: 'quotes',
  clients: 'clients',
  suppliers: 'purchases',
  bank: 'bank',
  projects: 'projects',
  payroll: 'payroll',
  accounting: 'accounting',
  planning: 'planning',
};
let stateRequest: Promise<AutomationState | null> | null = null;
export function automationState(): Promise<AutomationState | null> {
  return loadAutomationState().catch(() => null);
}
/** Settings retain the real failure; optional suggestions may fall back to manual entry. */
export function loadAutomationState(): Promise<AutomationState | null> {
  if (!stateRequest)
    stateRequest = invoke<AutomationState>('automation_request', { data: null })
      .finally(() => {
        stateRequest = null;
      });
  return stateRequest;
}
export function featureReady(
  state: AutomationState | null,
  feature: AutomationFeature,
) {
  return Boolean(
    state?.active &&
    state.settings.enabled &&
    state.settings.consent &&
    state.settings.flags.includes(feature) &&
    state.available.includes(feature),
  );
}
export async function automationRequest(
  feature: AutomationFeature,
  context: Record<string, unknown>,
  identity?: string,
): Promise<AutomationDecision> {
  const state = await automationState();
  if (!featureReady(state, feature)) return { status: 'disabled' };
  const key = JSON.stringify([
    state!.organizationId,
    feature,
    identity ?? crypto.randomUUID(),
    context,
    state!.settings.mode,
    state!.settings.thresholds,
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)),
  );
  const requestId = Array.from(digest, (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
  try {
    return await invoke('automation_request', {
      data: { action: 'decide', feature, context, requestId },
    });
  } catch {
    return {
      status: 'manual',
      message: 'Suggestion indisponible. Vous pouvez continuer manuellement.',
    };
  }
}
export async function automationFeedback(
  decision: AutomationDecision | null,
  choices: Record<string, string>,
  rejected = false,
) {
  if (
    !decision?.id ||
    !['suggestion', 'shadow', 'manual'].includes(decision.status)
  )
    return false;
  try {
    await invoke('automation_request', {
      data: {
        action: 'feedback',
        id: decision.id,
        feedback: rejected ? 'rejected' : 'modified',
        choices,
      },
    });
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('zentra-automation-updated'));
    return true;
  } catch {
    return false;
  }
}
export const openAutomationSettings = () =>
  invoke<string>('open_automation_settings');
export async function saveAutomationSettings(settings: AutomationState['settings'], consent = false) {
  const result = await invoke<AutomationState['settings']>('automation_request', { data: {
    action: 'settings', ...settings,
    ...(consent ? { consentVersion: 'automation-2026-09-20' } : {}),
  } });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('zentra-automation-updated'));
  return result;
}
export async function automationResourceFeedback(
  decision: AutomationDecision | null,
  resourceIds: Record<string, string | null>,
) {
  if (!decision?.id) return false;
  try {
    await invoke('automation_request', {
      data: {
        action: 'feedback',
        id: decision.id,
        feedback: 'modified',
        choices: {},
        resourceIds,
      },
    });
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('zentra-automation-updated'));
    return true;
  } catch {
    return false;
  }
}
export function bankContext(movement: BankMovement) {
  return {
    text: [movement.counterpartyName, movement.unstructured]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 900),
    amountCents: movement.amountCents,
    currency: movement.currency,
    date: movement.bookingDate || movement.valueDate,
    direction: movement.creditDebit === 'CRDT' ? 'incoming' : 'outgoing',
  };
}
export function anomalyContext(
  movement: BankMovement,
  history: BankMovement[],
) {
  const previous = history
    .filter(
      (v) =>
        Boolean(movement.counterpartyName.trim()) &&
        v.id !== movement.id &&
        v.creditDebit === movement.creditDebit &&
        v.currency === movement.currency &&
        v.bookingDate < movement.bookingDate &&
        v.counterpartyName === movement.counterpartyName,
    )
    .slice(0, 50);
  const amounts = previous
    .map((v) => Math.abs(v.amountCents))
    .sort((a, b) => a - b);
  return {
    ...bankContext(movement),
    medianAmountCents: amounts.length
      ? amounts[Math.floor(amounts.length / 2)]
      : undefined,
    historyCount: amounts.length,
    newCounterparty: amounts.length === 0,
  };
}
// Fail closed: only registered navigation destinations can be opened. This never
// invokes a payment, export, deletion, or accounting command.
export function openAutomationWorkflow(value: string | undefined | null) {
  if (value && Object.hasOwn(workflowScreens, value))
    window.dispatchEvent(
      new CustomEvent('zentra-automation-navigate', {
        detail: workflowScreens[value],
      }),
    );
}
