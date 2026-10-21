import { createRoot } from 'react-dom/client';
import { AutopilotReviews, type AutopilotAcceptanceCard, type AutopilotCreatedQuoteView } from '../src/AutopilotPanel';
import type { AutopilotActionCard } from '../src/AutopilotActionList';
import type { AutopilotSignalCard } from '../src/AutopilotSignalList';
import { parseLanguage, setAppLanguage } from '../src/language';
import type { AutopilotView } from '../src/autopilotView';
import type { JournalEntry } from '../src/autopilotJournal';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';
import '../src/workspace-shell.css';
import '../src/guided-tour.css';
import '../src/clarity.css';
import '../src/refined.css';
import '../src/assistant.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/mobile-air.css';
import '../src/automation-design.css';
import '../src/workspace-atelier.css';
import '../src/onboarding-journey.css';
import '../src/brand-identity.css';
import '../src/workspace-personalization.css';
import '../src/mobile-collections.css';
import '../src/apple-workspace.css';
import '../src/apple-business.css';
import '../src/apple-operational.css';
import '../src/apple-secondary.css';
import '../src/apple-access.css';
import '../src/clarity-2026.css';
import '../src/zentra-2027.css';
import '../src/zentra-2027-pages.css';
import '../src/zentra-2027-sober.css';
import '../src/zentra-2027-menus.css';
import '../src/zentra-2027-calm.css';
import '../src/autopilot-simple.css';
import '../src/filters-calm.css';
import '../src/switch-calm.css';
import '../src/erp-calm.css';
import '../src/autopilot-magic.css';
import '../src/mobile-calm.css';
import '../src/agenda-calm.css';

import { autopilotCopy } from '../src/autopilotPresentation';
const query = new URLSearchParams(location.search);
document.documentElement.dataset.appTheme = query.get('theme') === 'dark' ? 'dark' : 'light';
await setAppLanguage(parseLanguage(query.get('language')) ?? 'fr');
// Fictitious Autopilote cards for the public tour screenshot. No business calls.
const lang = (parseLanguage(query.get('language')) ?? 'fr') as 'fr' | 'de' | 'it' | 'en';
const copy = autopilotCopy(lang);
const L = <T,>(v: Record<'fr' | 'de' | 'it' | 'en', T>) => v[lang];
const at = 1792400000;
const line = (description: string, quantity: number, price: number) => ({ articleId: 'a-' + description.length, description, unit: 'm²', quantityMilli: quantity * 1000, unitPriceCents: price, taxRateBp: 810, netCents: quantity * price });
const items = [
  { proposalId: 'p2', sourceId: 's2', createdAt: at - 7200, disposition: 'needs_review' as const, reasons: ['low_confidence' as const], requiresHumanValidation: true as const,
    suggestion: { customer: { kind: 'existing' as const, name: 'Résidence Bellevue' }, currency: 'CHF' as const, netCents: 86000, lines: [line(L({ fr: 'Peinture murs', de: 'Wände streichen', it: 'Pittura pareti', en: 'Wall painting' }), 43, 2000)] } },
  { proposalId: 'p4', sourceId: 's4', createdAt: at - 172800, disposition: 'needs_review' as const, reasons: ['low_confidence' as const], requiresHumanValidation: true as const },
];
const created: Record<string, AutopilotCreatedQuoteView> = {
  p4: { number: 'D-2026-002', issued: true, clientEmail: 'b@example.invalid', clientName: 'Atelier du Lac', sentAt: (at - 100000) * 1000, accepted: true },
};
const fill = (text: string, values: Record<string, string>) => Object.entries(values).reduce((s, [k, v]) => s.split('{' + k + '}').join(v), text);
const followUps: AutopilotActionCard[] = [
  { key: 'reminder:r1', title: fill(copy.reminderTitle, { level: '1' }), detail: fill(copy.reminderDetail, { client: 'Menuiserie Favre Sàrl', number: 'F-2026-0012', balance: 'CHF 1 780.00', days: '12' }),
    actions: [{ id: 'send', label: copy.actionSend, primary: true }, { id: 'postpone', label: copy.actionPostpone }, { id: 'ignore', label: copy.acceptanceDismiss }] },
  { key: 'bank:b1', title: fill(copy.bankReceived, { amount: 'CHF 3 574.00', from: 'Résidence Bellevue' }), detail: fill(copy.bankInvoice, { number: 'F-2026-0014' }),
    actions: [{ id: 'confirm', label: copy.actionConfirm, primary: true }, { id: 'choose', label: copy.actionChooseInvoice }] },
  { key: 'stock:s1', title: fill(copy.lowStockTitle, { item: L({ fr: 'Vitrificateur mat 5 l', de: 'Parkettlack matt 5 l', it: 'Vernice opaca 5 l', en: 'Matt floor varnish 5 l' }) }), detail: fill(copy.lowStockDetail, { quantity: '2', threshold: '5' }),
    actions: [{ id: 'order', label: copy.actionPrepareOrder, primary: true }, { id: 'ignore', label: copy.acceptanceDismiss }] },
  { key: 'appt:a1', title: fill(copy.appointmentTitle, { title: L({ fr: 'visite de chantier', de: 'Baustellenbesuch', it: 'sopralluogo', en: 'site visit' }) }), detail: fill(copy.appointmentDetail, { when: L({ fr: 'mardi 27 oct., 10:00', de: 'Dienstag, 27. Okt., 10:00', it: 'martedì 27 ott., 10:00', en: 'Tuesday 27 Oct, 10:00' }), place: ' · Lausanne' }),
    actions: [{ id: 'agenda', label: copy.actionAddAgenda, primary: true }, { id: 'ignore', label: copy.acceptanceDismiss }] },
];
const signals: AutopilotSignalCard[] = [
  { sourceId: 'm1', receivedAt: at - 7200, title: copy.signalPayment, sender: 'Camille Martin', evidence: L({ fr: '« Le virement de CHF 640.00 a été effectué ce matin. »', de: '«Die Überweisung von CHF 640.00 ist heute Morgen erfolgt.»', it: '«Il bonifico di CHF 640.00 è stato eseguito stamattina.»', en: '“The CHF 640.00 transfer went out this morning.”' }),
    actionLabel: fill(copy.signalPaymentAction, { amount: 'CHF 640.00', number: 'F-2026-0009' }) },
];
const state = { status: 'ready', canManage: true, consent: null, saving: false, error: null, activity: null, readingReviews: false, reviewsUnavailable: false,
  reviews: { organizationId: 'preview-org', nextCursor: null, items } } as unknown as AutopilotView;
const noop = () => undefined;
// Two cards already validated today: they show folded into checks under "Fait aujourd'hui".
const today = (hours: number, minutes: number) => { const date = new Date(); date.setHours(hours, minutes, 0, 0); return date.toISOString(); };
const journal: JournalEntry[] = [
  { id: 'j2', key: 'quote-sent:p1', at: today(9, 42), ok: true, detail: '', title: 'Atelier Rossi Sàrl · D-2026-0021', actionLabel: copy.doneQuoteSent },
  { id: 'j1', key: 'reminder:r0', at: today(8, 15), ok: true, detail: '', title: 'Boulangerie du Lac · F-2026-0007', actionLabel: copy.doneReminderSent },
];
createRoot(document.getElementById('root')!).render(<div className="desktop-app" data-experience="workspace"><main className="app-main"><section className="page-content" data-screen="automation"><div className="automation-hub"><div className="automation-hub__followup" id="tour-followup">
  <AutopilotReviews onAsk={noop} state={state} organizationId="preview-org" onOpenSource={async () => undefined} onRefresh={async () => undefined} onCatalogue={noop}
    followUps={followUps} onFollowUp={noop} journal={journal} onUndo={noop} signals={signals} onSignal={noop} onIgnoreSignal={noop} onCreateQuote={noop} createdQuote={item => created[item.proposalId] ?? null}
    onOpenCreatedQuote={noop} onSendCreatedQuote={noop} onCreateInvoice={noop} onSendInvoice={noop} onOpenInvoice={noop} />
</div></div></section></main></div>);
