// Synthetic QA only, not an application entry point.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomationHub } from '../src/AutomationHub';
import { type AutomationPage } from '../src/automationExperience';
import { AutomationCompanyProvider } from '../src/AutomationCompany';
import type { Workspace } from '../src/types';
import { setAppLanguage, languageNames, type AppLanguage } from '../src/language';
import { setAppearance } from '../src/appearance';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/dark.generated.css';
import '../src/dark.css';
let scenario = 'team';
let settings = { enabled: true, consent: true, mode: 'suggest', flags: ['transaction_classification', 'agent_routing', 'document_routing', 'priority'], thresholds: { medium: .65, high: .9 } };
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (_command: string, args: { data?: Record<string, unknown> }) => {
  if (scenario === 'offline') throw Error('offline');
  if(args?.data?.action === 'settings') { settings = { ...args.data, consent: Boolean(args.data.consentVersion) || settings.consent } as typeof settings; scenario = 'manager'; return settings; }
  if(args?.data?.action === 'feedback') return { recorded: true };
  if(args?.data?.action === 'decide') return { id: 'qa-decision', status: 'suggestion', band: 'high', choices: { category: 'material', action: 'create_quote' } };
  const active = scenario !== 'inactive';
  const n = scenario === 'empty' ? 0 : scenario === 'updated' ? 13 : 12;
  return { organizationId: 'qa-company', active, canManage: ['manager', 'setup'].includes(scenario), available: ['transaction_classification', 'agent_routing', 'document_routing', 'priority'], settings: scenario === 'setup' ? { ...settings, enabled: false, consent: false, flags: [] } : { ...settings, enabled: scenario === 'paused' ? false : settings.enabled },
    activity: active ? { date: '2026-09-20', timeZone: 'Europe/Zurich', updatedAt: Date.now() / 1000, displayName: 'Camille', totals: { analyzed: n, suggestions: n ? 9 : 0, confirmed: n ? 7 : 0, needsReview: n ? 3 : 0, observed: 0 }, features: n ? [{ feature: 'transaction_classification', analyzed: n - 4, suggestions: 6, confirmed: 5, needsReview: 2, observed: 0 }, { feature: 'document_routing', analyzed: 4, suggestions: 3, confirmed: 2, needsReview: 1, observed: 0 }] : [], supplierInbox:{received:n?8:0,imported:n?6:0,automatic:n?5:0,needsReview:n?2:0,recent:n?[{id:'qa-invoice',subject:'Facture septembre · Fournitures Atelier du Lac',state:'imported',automatic:false,imported_at:Date.now()/1000}]:[]} } : null };
} } });
function Preview() {
  const [org, setOrg] = useState<string | null>('qa-company');
  const [page, setPage] = useState<AutomationPage>('overview');
  const [destination, setDestination] = useState('');
  return <main className="desktop-app" data-experience="apple" style={{ padding: 16, maxWidth: 1200, margin: 'auto' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
      <select aria-label="Langue" onChange={e => setAppLanguage(e.target.value as AppLanguage)}>{Object.entries(languageNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <button onClick={() => setAppearance('dark')}>Sombre</button><button onClick={() => setAppearance('light')}>Clair</button>
      <select aria-label="Scénario" onChange={e => { scenario = e.target.value; window.dispatchEvent(new Event('zentra-automation-updated')); }}><option value="team">Équipe</option><option value="manager">Administrateur</option><option value="setup">À configurer</option><option value="updated">Nouvelle analyse</option><option value="inactive">Sans option</option><option value="empty">Aucune activité</option><option value="paused">En pause</option><option value="offline">Hors ligne</option></select>
      <button onClick={() => setOrg(org ? null : 'qa-company')}>Changer d’entreprise</button>
    </div>
    <AutomationCompanyProvider organizationId={org}>
    <AutomationHub page={page} onPage={setPage} onNavigate={setDestination} workspace={{ invoices: [], settings: { organization: { legalName: 'Atelier du Lac' } } } as unknown as Workspace} />
    </AutomationCompanyProvider>
    {destination && <output>Écran ouvert : {destination}</output>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
