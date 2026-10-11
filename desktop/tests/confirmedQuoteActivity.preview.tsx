// Isolated synthetic UI fixture. No account, API, IPC, work scheduler or native
// quote opening is used. The callback output proves only the selected quoteId.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomationJournal } from '../src/AutomationJournal';
import { type ConfirmedQuoteActivityPage } from '../src/confirmedQuoteActivity';
import { setAppLanguage, type AppLanguage } from '../src/language';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/AutomationControlCentre.css';
import '../src/AutomationHub.css';
import '../src/automation-design.css';
import '../src/apple-workspace.css';

const params = new URLSearchParams(location.search);
const language = (['fr', 'de', 'it', 'en'].includes(params.get('lang') || '') ? params.get('lang') : 'fr') as AppLanguage;
document.documentElement.dataset.appTheme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.style.colorScheme = document.documentElement.dataset.appTheme;
// Existing packaged translation assets only; no activity or document request.
await setAppLanguage(language);
const labels = {
  fr: { demo: 'Données de démonstration · Journal des devis', company: 'Organisation', original: 'Organisation de démonstration', other: 'Autre organisation', installed: 'Activité des devis fournie', target: 'Cible du callback de démonstration' },
  de: { demo: 'Demodaten · Offertenaktivität', company: 'Organisation', original: 'Demoorganisation', other: 'Andere Organisation', installed: 'Offertenaktivität bereitgestellt', target: 'Ziel des Demo-Callbacks' },
  it: { demo: 'Dati dimostrativi · Attività preventivi', company: 'Organizzazione', original: 'Organizzazione dimostrativa', other: 'Altra organizzazione', installed: 'Attività preventivi fornita', target: 'Destinazione del callback dimostrativo' },
  en: { demo: 'Demo data · Quote activity', company: 'Organization', original: 'Demo organization', other: 'Other organization', installed: 'Quote activity supplied', target: 'Demo callback target' },
}[language];
const page: ConfirmedQuoteActivityPage = { organizationId: 'demo-company', nextCursor: null, items: [
  { activityId: 'demo:activity:1', proposalId: 'demo:proposal:1', quoteId: '7418f947-06af-4dfb-84d0-0f2eae5fb946', confirmedAt: 1791716400, kind: 'quote_draft_created', requiresHumanValidation: true },
  { activityId: 'demo:activity:2', proposalId: 'demo:proposal:2', quoteId: 'b8c6975a-6f44-4b15-a579-068b072d95f1', confirmedAt: 1791622800, kind: 'quote_draft_created', requiresHumanValidation: true },
] };
function Fixture() {
  const [organizationId, setOrganizationId] = useState('demo-company');
  const [installed, setInstalled] = useState(true);
  const [opened, setOpened] = useState('');
  return <main className="automation-hub" style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px', boxSizing: 'border-box' }}>
    <header style={{ display: 'grid', gap: 12, marginBottom: 24 }}><p>{labels.demo}</p>
      <label>{labels.company}<select aria-label={labels.company} value={organizationId} onChange={event => { setOrganizationId(event.target.value); setOpened(''); }} style={{ display: 'block', minHeight: 44, maxWidth: '100%' }}><option value="demo-company">{labels.original}</option><option value="demo-other">{labels.other}</option></select></label>
      <label style={{ minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8 }}><input type="checkbox" checked={installed} style={{ width: 18, minWidth: 18, height: 18, flex: '0 0 auto', accentColor: 'var(--zen-accent)' }} onChange={event => { setInstalled(event.target.checked); setOpened(''); }} />{labels.installed}</label>
    </header>
    <div className="automation-hub__journal automation-centre"><AutomationJournal runs={[]} renderRun={() => null} organizationId={organizationId} confirmedQuotes={installed ? page : undefined} openQuote={setOpened} /></div>
    {opened && <output aria-label={labels.target} style={{ display: 'block', overflowWrap: 'anywhere', marginTop: 20 }}>{labels.target} : {opened}</output>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
