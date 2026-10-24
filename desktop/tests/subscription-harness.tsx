// Development-only fixture; never included in the application build.
// Fictional company. Query: ?view=subscription|autopilot&scene=month|near|reached|year|trial&theme=light|dark&lang=fr|de|it|en
import { createRoot } from 'react-dom/client';
import { AutomationSetup } from '../src/AutomationControls';
import { NativeSubscription } from '../src/NativeSubscription';
import { setAppLanguage, type AppLanguage } from '../src/language';
import { setAppearance } from '../src/appearance';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';
import '../src/workspace-shell.css';
import '../src/clarity.css';
import '../src/refined.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/mobile-air.css';
import '../src/automation-design.css';
import '../src/apple-secondary.css';
import '../src/apple-access.css';
import '../src/clarity-2026.css';
import '../src/zentra-2027.css';
import '../src/zentra-2027-pages.css';
import '../src/zentra-2027-sober.css';
import '../src/zentra-2027-menus.css';
import '../src/zentra-2027-calm.css';
import '../src/autopilot-simple.css';
import '../src/switch-calm.css';
import '../src/erp-calm.css';
import '../src/autopilot-magic.css';
import '../src/mobile-calm.css';
import '../src/parcours-client.css';

const query = new URLSearchParams(location.search);
const scene = query.get('scene') ?? 'month';
const view = query.get('view') ?? 'subscription';
if (query.get('theme') === 'light' || query.get('theme') === 'dark') setAppearance(query.get('theme') as 'light' | 'dark');
if (['fr', 'de', 'it', 'en'].includes(query.get('lang') ?? '')) void setAppLanguage(query.get('lang') as AppLanguage);

const day = 86_400, now = Math.floor(Date.UTC(2026, 9, 24) / 1000);
const used = scene === 'near' ? 2_520 : scene === 'reached' ? 3_000 : scene === 'trial' ? 120 : 1_180;
const limit = scene === 'trial' ? 500 : 3_000;
const yearly = scene === 'year', trial = scene === 'trial';
const overview = {
  organizationId: 'org_harness', organizationName: 'Menuiserie Exemple Sàrl', owner: true, canManage: true,
  name: trial ? 'Essai gratuit Zentra' : 'Zentra Équipe', plan: trial ? null : 'team',
  monthlyChfCents: trial ? 0 : yearly ? 6583 : 7900, billingInterval: trial ? null : yearly ? 'year' : 'month', periodChfCents: trial ? 0 : yearly ? 79_000 : 7900,
  status: trial ? 'trial' : 'active', renewalAt: now + (yearly ? 300 : trial ? 9 : 18) * day,
  trial: trial ? { active: true, endsAt: now + 9 * day, analyses: 500 } : null,
  seats: { used: 3, limit: 5, reserved: 1 },
  products: [
    { id: 'gestion', name: 'Gestion', active: true, detail: '3 / 5 personnes', until: null },
    { id: 'support', name: 'Support', active: true, detail: `${used} / ${limit} analyses`, until: null },
    { id: 'automation', name: 'Autopilote', active: true, detail: 'Automatismes configurés', until: null },
  ],
  support: { active: true, used, limit, remaining: Math.max(0, limit - used), periodEnd: now + 8 * day, alert: null },
  change: null, canChange: true, portalAvailable: true, steps: [], onboardingComplete: true,
};
const plansV2 = {
  version: 2, currency: 'CHF', vatIncluded: true,
  trial: { days: 14, cardRequired: false, plan: 'equipe', people: 5, analyses: 500, autopilote: true },
  plans: [
    { id: 'solo', name: 'Solo', monthlyChfCents: 4900, yearlyChfCents: 49000, minPeople: 1, people: 1, analyses: 1000, autopilote: true, recommended: false },
    { id: 'equipe', name: 'Équipe', monthlyChfCents: 7900, yearlyChfCents: 79000, minPeople: 2, people: 5, analyses: 3000, autopilote: true, recommended: true },
    { id: 'pro', name: 'Pro', monthlyChfCents: 12900, yearlyChfCents: 129000, minPeople: 6, people: 15, analyses: 10000, autopilote: true, recommended: false },
  ],
  extraPerson: { plan: 'pro', monthlyChfCents: 700, yearlyChfCents: 7000, analyses: 500, available: false },
  analyses: { warningAt: 0.8, overageBilled: false },
};
const inactive = query.get('autopilot') !== 'active';
Object.assign(window, {
  isTauri: true,
  __TAURI_INTERNALS__: {
    invoke: async (command: string) => {
      if (command === 'subscription_overview_request') return overview;
      if (command === 'get_plan_catalog') return plansV2;
      if (command === 'automation_request') return { organizationId: 'org_harness', active: !inactive, canManage: true, available: [], settings: { enabled: false, consent: false, flags: [], mode: 'suggest', thresholds: { medium: 0.65, high: 0.9 } } };
      return null;
    },
    transformCallback: () => 0,
  },
});

function Harness() {
  return <main className="workspace-main" style={{ padding: '24px 16px', minHeight: '100vh', background: 'var(--apple-canvas, var(--background, #f5f7f5))' }}>
    {view === 'autopilot'
      ? <AutomationSetup onContinue={() => undefined} onSkip={query.get('onboarding') ? () => undefined : undefined} />
      : <section className="cloud-account-panel"><NativeSubscription organizationId="org_harness" /></section>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
