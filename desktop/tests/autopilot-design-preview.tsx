// Visual preview of the Autopilote follow-up page with fictitious requests. No business calls.
import { createRoot } from 'react-dom/client';
import { AutopilotReviews, type AutopilotAcceptanceCard, type AutopilotCreatedQuoteView } from '../src/AutopilotPanel';
import type { AutopilotActionCard } from '../src/AutopilotActionList';
import type { AutopilotSignalCard } from '../src/AutopilotSignalList';
import { parseLanguage, setAppLanguage } from '../src/language';
import type { AutopilotView } from '../src/autopilotView';
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

const query = new URLSearchParams(location.search);
document.documentElement.dataset.appTheme = query.get('theme') === 'dark' ? 'dark' : 'light';
await setAppLanguage(parseLanguage(query.get('language')) ?? 'fr');
const at = 1792400000;
const line = (description: string, quantity: number, price: number) => ({ articleId: 'a-' + description.length, description, unit: 'm²', quantityMilli: quantity * 1000, unitPriceCents: price, taxRateBp: 810, netCents: quantity * price });
const sender = { email: 'c.morel@example.invalid', name: 'Claire Morel', company: 'Morel Immobilier', phone: null, street: null, postcode: null, city: 'Lausanne', source: 'signature' as const };
const items = [
  { proposalId: 'p1', sourceId: 's1', createdAt: at, disposition: 'needs_review' as const, reasons: ['missing_article' as const], requiresHumanValidation: true as const,
    suggestion: { customer: { kind: 'new' as const, name: 'Morel Immobilier' }, currency: 'CHF' as const, netCents: 120000, lines: [line('Ponçage parquet', 40, 3000)], unmatched: ['Vitrification 2 couches', 'Plinthes chêne'], sender } },
  { proposalId: 'p2', sourceId: 's2', createdAt: at - 7200, disposition: 'needs_review' as const, reasons: ['low_confidence' as const], requiresHumanValidation: true as const,
    suggestion: { customer: { kind: 'existing' as const, name: 'Résidence Bellevue' }, currency: 'CHF' as const, netCents: 86000, lines: [line('Peinture murs', 43, 2000)] } },
  { proposalId: 'p3', sourceId: 's3', createdAt: at - 86400, disposition: 'needs_review' as const, reasons: ['low_confidence' as const], requiresHumanValidation: true as const,
    suggestion: { customer: { kind: 'existing' as const, name: 'Atelier du Lac' }, currency: 'CHF' as const, netCents: 45000, lines: [line('Pose carrelage', 15, 3000)] } },
  { proposalId: 'p4', sourceId: 's4', createdAt: at - 172800, disposition: 'needs_review' as const, reasons: ['low_confidence' as const], requiresHumanValidation: true as const },
  { proposalId: 'p5', sourceId: 's5', createdAt: at - 259200, disposition: 'needs_review' as const, reasons: ['low_confidence' as const], requiresHumanValidation: true as const },
];
const created: Record<string, AutopilotCreatedQuoteView> = {
  p3: { number: 'D-2026-004', issued: false, clientEmail: 'lac@example.invalid', clientName: 'Atelier du Lac' },
  p4: { number: 'D-2026-002', issued: true, clientEmail: 'b@example.invalid', clientName: 'Résidence Bellevue', sentAt: (at - 100000) * 1000, accepted: true },
  p5: { number: 'D-2026-001', issued: true, clientEmail: 'm@example.invalid', clientName: 'Camille Martin', sentAt: (at - 200000) * 1000 },
};
const acceptances: AutopilotAcceptanceCard[] = [{ key: 'a1', sourceId: 's9', receivedAt: at - 3600, sender: 'Alex Morel', evidence: '« Bonjour, c’est d’accord pour le devis, vous pouvez commencer lundi. »', candidates: [{ id: 'q1', label: 'D-2026-003 · Entretien annuel' }, { id: 'q2', label: 'D-2026-001 · Rénovation' }] }];
const followUps: AutopilotActionCard[] = [
  { key: 'reminder:r1', title: 'Relance n°1 prête', detail: 'Résidence Bellevue · F-2026-0012 · CHF 1 780.00 · échue depuis 12 jours',
    actions: [{ id: 'send', label: 'Envoyer par mail', primary: true }, { id: 'postpone', label: 'Reporter de 7 jours' }, { id: 'invoice', label: 'Voir la facture' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'reminder:r2', title: 'Relance n°2 prête', detail: 'Camille Martin · F-2026-0009 · CHF 640.00 · échue depuis 21 jours', note: 'Le client a promis de payer.',
    evidence: '« Nous réglerons la facture le 30 octobre. »', actions: [{ id: 'postpone', label: 'Reporter de 7 jours', primary: true }, { id: 'send', label: 'Envoyer quand même' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'quote:q7', title: 'Relancer le devis D-2026-0007', detail: 'Atelier du Lac · envoyé le 12 oct. 2026 · valable jusqu’au 11 nov. 2026',
    actions: [{ id: 'send-quote', label: 'Envoyer', primary: true }, { id: 'postpone', label: 'Reporter de 7 jours' }, { id: 'ignore', label: 'Ignorer' }] },
];
const signals: AutopilotSignalCard[] = [
  { sourceId: 'm1', receivedAt: at - 7200, title: 'Paiement annoncé', sender: 'Résidence Bellevue', evidence: '« Le virement de CHF 178.00 a été effectué ce matin. »', actionLabel: 'Enregistrer le paiement de CHF 178.00 sur F-2026-0012' },
  { sourceId: 'm2', receivedAt: at - 9000, title: 'Réclamation ou demande de suivi', sender: 'Alex Morel', evidence: '« La plinthe posée hier se décolle déjà. »', actionLabel: 'Créer un suivi' },
];
const state = { status: 'ready', canManage: true, consent: null, saving: false, error: null, activity: null, readingReviews: false, reviewsUnavailable: false,
  reviews: { organizationId: 'preview-org', nextCursor: null, items } } as unknown as AutopilotView;
const noop = () => undefined;
function Preview() {
  return <div className="desktop-app" data-experience="workspace" style={{ minHeight: '100vh' }}><main className="app-main" style={{ marginLeft: 0, padding: '32px 40px' }}>
    <section className="page-content" data-screen="automation"><div className="automation-hub automation-hub--preview"><div className="automation-hub__followup">
      <AutopilotReviews state={state} organizationId="preview-org" onOpenSource={async () => undefined} onRefresh={async () => undefined} onCatalogue={noop} canAddCatalogue
        acceptances={acceptances} onChooseAcceptance={noop} followUps={followUps} followUpSummary="2 relances prêtes · 1 en attente (promesse de paiement)" onFollowUp={noop} signals={signals} onSignal={noop} onIgnoreSignal={noop} onCreateQuote={noop} createdQuote={item => created[item.proposalId] ?? null}
        onOpenCreatedQuote={noop} onSendCreatedQuote={noop} onCreateInvoice={noop} onSendInvoice={noop} onOpenInvoice={noop}
        catalogueArticles={[{ id: 'c1', name: 'Vitrification parquet' }, { id: 'c2', name: 'Plinthes' }]} onChooseArticle={async phrase => phrase} onCreateArticle={noop} />
    </div></div></section>
  </main></div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
