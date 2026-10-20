// Visual preview of the Autopilote follow-up page with fictitious requests. No business calls.
import { createRoot } from 'react-dom/client';
import { AutopilotReviews, type AutopilotAcceptanceCard, type AutopilotCreatedQuoteView } from '../src/AutopilotPanel';
import type { AutopilotActionCard } from '../src/AutopilotActionList';
import type { AutopilotSignalCard } from '../src/AutopilotSignalList';
import { parseLanguage, setAppLanguage } from '../src/language';
import type { AutopilotView } from '../src/autopilotView';
import { DebtCollectionDialog } from '../src/DebtCollectionDialog';
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
  { key: 'poursuite:i9', title: '3e relance sans réponse · Atelier du Lac', detail: 'F-2026-0009 · 1 780.00 CHF · délai échu le 15 oct. 2026',
    actions: [{ id: 'prepare-debt', label: 'Préparer la réquisition de poursuite', primary: true }, { id: 'postpone', label: 'Reporter de 7 jours' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'statement-file:s1', title: 'Relevé bancaire trouvé : camt053_UBS_2026-10-19.xml', detail: 'Dossier Downloads · 19 oct. 2026',
    actions: [{ id: 'import-statement', label: 'Importer', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'bank:e1', title: '89.90 CHF payé à SWISSCOM SCHWEIZ AG', detail: 'Catégorie habituelle : Télécommunications',
    actions: [{ id: 'open-bank', label: 'Créer la dépense', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'bank:b1', title: 'CHF 1 780.00 reçu de Résidence Bellevue', detail: 'facture F-2026-0012 · 18 oct. 2026', note: 'Le client l’avait annoncé le 17 oct. 2026.', actions: [{ id: 'confirm', label: 'Confirmer', primary: true }, { id: 'choose', label: 'Choisir la facture' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'pay-order:p1+p2+p3', title: '3 factures à payer cette semaine · 1 240.00 CHF', detail: 'Papeterie des Alpes, Swisscom (Suisse) SA, Scierie du Jura Sàrl',
    actions: [{ id: 'pay-order', label: 'Générer l’ordre de paiement', primary: true }, { id: 'postpone', label: 'Reporter de 7 jours' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'qrmail:m1', title: 'Facture QR reçue · Scierie du Jura Sàrl', detail: '949.75 CHF · échéance 14 nov. 2026', evidence: 'Facture 10201409 · planches de chêne',
    actions: [{ id: 'qr-create', label: 'Créer la facture fournisseur', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'pay:p1', title: 'À payer · Bois & Parquets SA', detail: 'FA-8812 · CHF 2 340.00 · échéance 24 oct. 2026', actions: [{ id: 'pay', label: 'Payer', primary: true }, { id: 'iban', label: 'Copier IBAN et référence' }, { id: 'view', label: 'Voir la facture' }] },
  { key: 'stock:s1', title: 'Stock bas · Vitrificateur mat 5 l', detail: '2 restants (seuil 5)', actions: [{ id: 'order', label: 'Préparer la commande', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'contact:c1', title: 'Nouvelles coordonnées · Atelier du Lac', detail: 'Rue du Port 4, 1006 Lausanne · 021 555 01 02', actions: [{ id: 'update', label: 'Mettre à jour la fiche', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'appt:a1', title: 'Rendez-vous : visite chantier Morel', detail: 'mardi 21 oct. 2026, 10:00 · Lausanne', actions: [{ id: 'agenda', label: 'Ajouter à l’agenda', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'hours:h1', title: '12 h non facturées · Résidence Bellevue · projet Rénovation hall', detail: 'Environ CHF 1 140.00 selon les tarifs saisis', actions: [{ id: 'invoice', label: 'Préparer la facture', primary: true }, { id: 'project', label: 'Voir le projet' }] },
  { key: 'vat:v1', title: 'Décompte TVA T3 2026 prêt à contrôler', detail: 'Échéance indicative 30 nov. 2026', actions: [{ id: 'vat', label: 'Ouvrir la TVA', primary: true }] },

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
      <AutopilotReviews onAsk={noop} askNotUnderstood={query.get('ask') === 'help'} state={state} organizationId="preview-org" onOpenSource={async () => undefined} onRefresh={async () => undefined} onCatalogue={noop} canAddCatalogue
        acceptances={acceptances} onChooseAcceptance={noop} followUps={followUps} followUpSummary="2 relances prêtes · 1 en attente (promesse de paiement)" onFollowUp={noop} signals={signals} onSignal={noop} onIgnoreSignal={noop} onCreateQuote={noop} createdQuote={item => created[item.proposalId] ?? null}
        onOpenCreatedQuote={noop} onSendCreatedQuote={noop} onCreateInvoice={noop} onSendInvoice={noop} onOpenInvoice={noop}
        catalogueArticles={[{ id: 'c1', name: 'Vitrification parquet' }, { id: 'c2', name: 'Plinthes' }]} onChooseArticle={async phrase => phrase} onCreateArticle={noop} />
    </div></div></section>
  </main></div>;
}
const debtRequest = {
  invoiceId: 'i9', currency: 'CHF', claimCents: 178_000, interestRateBp: 500, interestFrom: '2026-09-01', feesCents: 5_000, lastReminderDate: '2026-10-05',
  title: 'Facture F-2026-0009 du 01.08.2026, échue le 31.08.2026',
  creditor: { name: 'Menuiserie Dupont Sàrl', street: 'Route de Berne 12', postalCode: '1700', city: 'Fribourg', country: 'CH', uid: 'CHE-123.456.789' },
  debtor: { name: 'Atelier du Lac SA', street: 'Rue du Port 4', postalCode: '1006', city: 'Lausanne', country: 'CH' },
};
createRoot(document.getElementById('root')!).render(query.get('dialog') === 'poursuite'
  ? <div className="desktop-app" data-experience="workspace" style={{ minHeight: '100vh' }}><DebtCollectionDialog request={debtRequest} invoiceNumber="F-2026-0009" onClose={noop} onSaved={noop} /></div>
  : <Preview />);
