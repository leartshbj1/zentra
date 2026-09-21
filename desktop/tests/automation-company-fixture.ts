import type { AutomationState } from '../src/automation';
/** Synthetic bridge used only by the local, non-shipping UI harness. */
export function installAutomationCompanyFixture() {
  const params = new URLSearchParams(location.search);
  const unconfigured = params.get('automation') === 'setup';
  const invoices = [
    { id: 'mail-demo-1', name: 'Papeterie du Léman', reference: 'LEMAN-2026-091', net: 25000, state: 'needs_review' },
    { id: 'mail-demo-2', name: 'Atelier électrique & installations de Suisse romande', reference: 'ELEC-2026-082', net: 108000, state: 'needs_review' },
    { id: 'mail-demo-3', name: 'Studio Romandie', reference: 'STUDIO-2026-067', net: 40000, state: 'imported' },
  ].map((row, i) => ({ id: row.id, organizationId: 'automation-qa', fileName: row.reference+'.pdf', mediaType: 'application/pdf', sha256: 'fixture', sender: 'factures@example.test', subject: row.reference, state: row.state, invoiceId: row.state==='imported'?row.id:null, automatic: false, otherDevice: false, createdAt: 1790000000-i, extraction: {supplierName:row.name,reference:row.reference,invoiceDate:'2026-09-21',dueDate:'2026-10-21',currency:'CHF',netCents:row.net,vatCents:Math.round(row.net*.081),totalCents:row.net+Math.round(row.net*.081),vatBp:810,category:'materials',confidence:.98,issues:[],evidence:{}} }));
  const state: AutomationState = {
    organizationId: 'automation-qa', active: params.get('automation') !== 'inactive', canManage: !params.has('member'),
    available: ['transaction_classification', 'document_routing', 'supplier_routing', 'agent_routing', 'anomaly_detection', 'priority', 'email_classification', 'import_mapping'],
    settings: { enabled: !unconfigured, consent: !unconfigured, mode: 'suggest', flags: unconfigured ? [] : ['transaction_classification', 'document_routing', 'supplier_routing', 'agent_routing', 'anomaly_detection', 'priority', 'email_classification', 'import_mapping'], thresholds: { medium: .75, high: .95 } },
    activity: { date: '2026-09-21', timeZone: 'Europe/Zurich', updatedAt: Date.now() / 1000, displayName: 'Camille', totals: { analyzed: 0, suggestions: 0, confirmed: 0, needsReview: 0, observed: 0 }, features: [], supplierInbox: {received:3,imported:1,automatic:0,needsReview:2,recent:[]} },
  };
  Object.assign(window, { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: { data?: Record<string, unknown> }) => {
      if (command === 'supplier_inbox_request') {
        if (!args?.data) return {organizationId:'automation-qa',linked:true,autoPost:false,automationActive:true,items:structuredClone(invoices)};
        if (args.data.action === 'document') {
          const bytes = new Uint8Array(await (await fetch('/tests/fixtures/automation-test-invoice.pdf')).arrayBuffer());
          return {base64:btoa(String.fromCharCode(...bytes))};
        }
        throw Error('Fixture: no accounting writes');
      }
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
