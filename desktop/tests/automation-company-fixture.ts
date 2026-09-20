import type { AutomationState } from '../src/automation';
/** Synthetic bridge used only by the local, non-shipping UI harness. */
export function installAutomationCompanyFixture() {
  const params = new URLSearchParams(location.search);
  const unconfigured = params.get('automation') === 'setup';
  const state: AutomationState = {
    organizationId: 'automation-qa', active: params.get('automation') !== 'inactive', canManage: !params.has('member'),
    available: ['transaction_classification', 'document_routing', 'supplier_routing', 'agent_routing', 'anomaly_detection', 'priority', 'email_classification', 'import_mapping'],
    settings: { enabled: !unconfigured, consent: !unconfigured, mode: 'suggest', flags: unconfigured ? [] : ['transaction_classification', 'document_routing', 'supplier_routing', 'agent_routing', 'anomaly_detection', 'priority', 'email_classification', 'import_mapping'], thresholds: { medium: .75, high: .95 } },
    activity: { date: '2026-09-20', timeZone: 'Europe/Zurich', updatedAt: Date.now() / 1000, displayName: 'Camille', totals: { analyzed: 0, suggestions: 0, confirmed: 0, needsReview: 0, observed: 0 }, features: [] },
  };
  Object.assign(window, { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: { data?: Record<string, unknown> }) => {
      if (command !== 'automation_request') throw Error('Not available in this fixture');
      if (!args.data) return structuredClone(state);
      if (args.data.action === 'settings') {
        if (!state.canManage) throw Error('Read only');
        state.settings = { ...args.data, consent: state.settings.consent || Boolean(args.data.consentVersion) } as AutomationState['settings'];
        return structuredClone(state.settings);
      }
      if (args.data.action === 'feedback') return { recorded: true };
      return { id: 'qa', status: 'suggestion', choices: { action: 'create_quote', category: 'material' } };
    },
  } });
}
