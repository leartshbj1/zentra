// Visual preview of the Autopilote follow-up page with fictitious requests. No business calls.
import { createRoot } from 'react-dom/client';
import { AutopilotReviews, type AutopilotAcceptanceCard, type AutopilotCreatedQuoteView } from '../src/AutopilotPanel';
import type { AutopilotActionCard } from '../src/AutopilotActionList';
import { useState } from 'react';
import { AutopilotBehaviourSettings } from '../src/AutopilotBehaviourSettings';
import { DEFAULT_BEHAVIOUR, type AutopilotBehaviour } from '../src/autopilotSettings';
import type { AutopilotSignalCard } from '../src/AutopilotSignalList';
import { parseLanguage, setAppLanguage } from '../src/language';
import type { AutopilotView } from '../src/autopilotView';
import { DebtCollectionDialog } from '../src/DebtCollectionDialog';
import { ReceiptRequestDialog } from '../src/PaymentSafetyParts';
import type { MissingReceipt } from '../src/paymentSafety';
import type { BankMovement, Employee } from '../src/types';
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
import '../src/parcours-client.css';
import '../src/pack-batiment.css';
import '../src/aere.css';

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
  { key: 'ask:p1', title: 'Demande incomplète de Menuiserie Favre Sàrl', detail: 'À préciser : portes coulissantes, plinthes chêne. Un brouillon de réponse le demande.',
    actions: [{ id: 'ignore', label: 'Ignorer' }, { id: 'ask-info', label: 'Préparer la réponse', primary: true }] },
  { key: 'site:si-new', title: 'Rattacher au chantier Villa Dupont', detail: 'Couleurs Romandes SA · facture CR-88590 · 136.21 CHF',
    why: 'La facture mentionne l’adresse du chantier (Chemin des Vignes 14).',
    actions: [{ id: 'site-open', label: 'Voir la facture' }, { id: 'ignore', label: 'Ignorer' }, { id: 'site-attach', label: 'Rattacher', primary: true }] },
  // Paiements sûrs : approbation par une deuxième personne, justificatif manquant, alerte avant paiement.
  { key: 'approve:i6', title: 'Paiement à approuver · Menuiserie Favre Sàrl · CHF 12 400.00', detail: 'Préparé par Anna Keller · facture F-2026-0418',
    note: 'À vérifier : Montant inhabituel pour ce fournisseur', why: 'Au-delà de CHF 5 000.00, une deuxième personne approuve le paiement · Fiable',
    actions: [{ id: 'view-payments', label: 'Voir les paiements' }, { id: 'ignore', label: 'Ignorer' }, { id: 'approve-payment', label: 'Approuver', primary: true }] },
  { key: 'receipt:m1', title: 'Justificatif manquant · CHF 84.50 · Coop Bau+Hobby Bulle', detail: 'Débité le 3 oct. 2026, il y a 22 jours, sans pièce',
    why: 'Dépense bancaire sans pièce depuis 10 jours ou plus (réglable dans Paramètres) · Fiable',
    actions: [{ id: 'ask-receipt', label: 'Demander au collaborateur' }, { id: 'postpone', label: 'Reporter de 7 jours' }, { id: 'ignore', label: 'Ignorer' }, { id: 'attach-receipt', label: 'Joindre le justificatif', primary: true }] },
  { key: 'pay:i2', title: 'À payer · Scierie du Jura Sàrl', detail: '10201409 · CHF 949.75 · échéance 29 oct. 2026', note: 'Avant de payer : IBAN changé depuis le dernier paiement',
    actions: [{ id: 'copy-iban', label: 'Copier IBAN et référence' }, { id: 'view-purchase', label: 'Voir la facture' }, { id: 'ignore', label: 'Ignorer' }, { id: 'pay', label: 'Payer', primary: true }] },
  { key: 'service:eq-keller:x', title: 'Entretien chaudière Famille Keller dans 30 jours', detail: 'Proposé le 24 nov. 2026 à 08:00 · Chaudière Viessmann Vitodens 200-W · Sous-sol, Rue du Lac 4, Nyon',
    why: 'Entretien tous les 12 mois, d’après le parc installé. · Confiance élevée',
    actions: [{ id: 'plan-service', label: 'Planifier', primary: true }, { id: 'postpone', label: 'Plus tard' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'booking:pb1', title: 'Demande de rendez-vous de Famille Keller : mardi 3 novembre à 09:00', detail: 'Marc Keller · 079 555 01 12 · 60 minutes', evidence: 'Plutôt le matin, la porte du garage est ouverte.',
    why: 'Créneau libre choisi par le client sur sa page ; rien n’est confirmé avant votre clic.',
    actions: [{ id: 'booking-accept', label: 'Accepter et planifier', primary: true }, { id: 'booking-decline', label: 'Refuser' }] },
  { key: 'deposit:l1', title: 'Acompte de 3 600.00 CHF payé en ligne · devis D-2026-0042', detail: 'À rapprocher de la facture d’acompte F-2026-0118',
    why: 'Payrexx a confirmé le paiement ; le montant est celui calculé par Zentra · Confiance élevée',
    actions: [{ id: 'deposit-record', label: 'Rapprocher le paiement', primary: true }] },
  { key: 'review:c-rochat:i1', title: 'Demander un avis à Claire Rochat', detail: 'Facture F-2026-0112 payée le 22 oct. 2026',
    why: 'Client satisfait qui vient de payer ; une seule demande par période.',
    actions: [{ id: 'review-mail', label: 'Préparer l’e-mail', primary: true }, { id: 'review-sms', label: 'Envoyer par SMS' }, { id: 'review-copy', label: 'Copier le lien' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'sms-reminder:ev-5', title: 'Rappel SMS à Alex Morel : rendez-vous demain à 10:00', detail: 'Bonjour, nous vous rappelons notre rendez-vous de demain mardi 27 octobre à 10:00. Atelier du Léman 021 555 00 00',
    evidence: 'Visite salle de bain Morel', why: 'Rendez-vous de demain avec le numéro du client ; coût facturé par votre fournisseur SMS.',
    actions: [{ id: 'sms-send', label: 'Envoyer le SMS', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'reminder:r1', title: 'Relance n°1 prête', detail: 'Résidence Bellevue · F-2026-0012 · CHF 1 780.00 · échue depuis 12 jours',
    actions: [{ id: 'send', label: 'Envoyer par mail', primary: true }, { id: 'postpone', label: 'Reporter de 7 jours' }, { id: 'invoice', label: 'Voir la facture' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'reminder:r2', title: 'Relance n°2 prête', detail: 'Camille Martin · F-2026-0009 · CHF 640.00 · échue depuis 21 jours', note: 'Le client a promis de payer.',
    evidence: '« Nous réglerons la facture le 30 octobre. »', actions: [{ id: 'postpone', label: 'Reporter de 7 jours', primary: true }, { id: 'send', label: 'Envoyer quand même' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'quote:q7', title: 'Relancer le devis D-2026-0007', detail: 'Atelier du Lac · envoyé le 12 oct. 2026 · valable jusqu’au 11 nov. 2026',
    actions: [{ id: 'send-quote', label: 'Envoyer', primary: true }, { id: 'postpone', label: 'Reporter de 7 jours' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'poursuite:i9', title: '3e relance sans réponse · Atelier du Lac', detail: 'F-2026-0009 · 1 780.00 CHF · délai échu le 15 oct. 2026',
    actions: [{ id: 'prepare-debt', label: 'Préparer la poursuite', primary: true }, { id: 'postpone', label: 'Reporter de 7 jours' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'statement-file:s1', title: 'Relevé bancaire trouvé : camt053_UBS_2026-10-19.xml', detail: 'Dossier Downloads · 19 oct. 2026',
    actions: [{ id: 'import-statement', label: 'Importer', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'bank:e1', title: '89.90 CHF payé à SWISSCOM SCHWEIZ AG', detail: 'Catégorie habituelle : Télécommunications',
    actions: [{ id: 'open-bank', label: 'Créer la dépense', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'bank:b1', title: 'CHF 1 780.00 reçu de Résidence Bellevue', detail: 'facture F-2026-0012 · 18 oct. 2026', note: 'Le client l’avait annoncé le 17 oct. 2026.', actions: [{ id: 'confirm', label: 'Confirmer', primary: true }, { id: 'choose', label: 'Choisir la facture' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'bank-batch:a+b+c+d+e', title: '5 paiements sûrs à confirmer · 4 210.00 CHF', detail: 'F-2026-0012 1 780.00 CHF · F-2026-0014 640.00 CHF · F-2026-0015 890.00 CHF · R-118 89.90 CHF …', note: 'Règle apprise',
    why: 'Référence de paiement structurée identique et montant exact pour chaque paiement. · Confiance élevée',
    actions: [{ id: 'confirm-all', label: 'Valider les 5 paiements', primary: true }, { id: 'open-bank', label: 'Ouvrir la banque' }] },
  { key: 'rule:supplier:Swisscom', title: 'Toujours préparer ainsi pour Swisscom (Suisse) SA ?', detail: 'Validé 3 fois de la même façon. Ces cartes seront regroupées pour être validées en un clic ; rien ne part sans vous.',
    actions: [{ id: 'rule-always', label: 'Oui, toujours', primary: true }, { id: 'rule-never', label: 'Non' }] },
  { key: 'cash-diff:k1', title: 'Caisse : écart de -12.00 CHF au comptage du 19 oct. 2026', detail: 'Compté 450.50 CHF, attendu 462.50 CHF.',
    actions: [{ id: 'cash-correct', label: 'Corriger le livre de caisse', primary: true }, { id: 'open-cash', label: 'Voir la caisse' }] },
  { key: 'contract:k2', title: 'Résiliation possible jusqu’au 30 sept. 2026 · Assurance RC entreprise', detail: 'Helvetia · sinon reconduit jusqu’au 31 déc. 2027',
    actions: [{ id: 'contract-open', label: 'Voir le contrat', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'treasury-low:t1', title: 'Trésorerie : creux de -2 340.00 CHF le 25 nov. 2026', detail: 'Salaires',
    actions: [{ id: 'open-treasury', label: 'Voir la trésorerie', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'fx-rate:EUR:2026-10', title: 'Cours EUR manquant · 3 écriture(s) depuis le 3 oct. 2026', detail: 'Sans le cours du mois, le bilan, le résultat et la TVA restent en attente.',
    why: 'Les écritures en devise gardent les montants du document ; leur contre-valeur CHF demande le cours du mois.',
    actions: [{ id: 'open-currencies', label: 'Saisir le cours', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'budget:a4000:2026-10', title: '4000 Achats de matériel au-dessus du budget : +21 %', detail: 'Réel 108 500.00 CHF · budget 90 000.00 CHF depuis janvier.',
    why: 'Réel du journal comparé au budget saisi, du début de l’année à ce mois. · Confiance élevée',
    actions: [{ id: 'open-budget', label: 'Voir le budget', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'opportunity:o4:x', title: 'Décision prévue dépassée · Agrandissement de l’atelier', detail: 'Menuiserie Favre Sàrl · 42 000.00 CHF hors TVA',
    why: 'Opportunité encore ouverte dans le pipeline des ventes.',
    actions: [{ id: 'open-pipeline', label: 'Voir l’opportunité', primary: true }, { id: 'opportunity-lost', label: 'Marquer perdue' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'archive:2025', title: 'Archiver l’année 2025', detail: 'Journal, factures, salaires et justificatifs en une archive vérifiable, à conserver jusqu’à fin 2035.',
    why: 'Les livres et les pièces se conservent dix ans (art. 958f CO, Olico).',
    actions: [{ id: 'open-archive', label: 'Préparer l’archive', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'trace:dn-1', title: 'Livraison BL-2026-0031 : noter les lots ou numéros de série', detail: 'Robinet thermostatique · livré le 8 oct. 2026',
    why: 'Article suivi par lot ou numéro de série, livré sans numéro noté.',
    actions: [{ id: 'trace-delivery', label: 'Noter les numéros', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'lot-expiry:l1', title: 'Lot L-2610-A de Colle carrelage flex : expire le 8 nov. 2026', detail: 'Encore 8 sac en stock.',
    actions: [{ id: 'open-lots', label: 'Voir les lots', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'produce:kit', title: 'Fabriquer 3 pce de Kit radiateur prêt à poser', detail: 'Stock bas : 1 pce. Vos composants permettent d’en faire 4.',
    why: 'Produit avec nomenclature, sous son seuil de réapprovisionnement.',
    actions: [{ id: 'produce', label: 'Préparer la production', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'deliver:o1', title: 'Commande CMD-2026-0042 prête à livrer', detail: 'Résidence Bellevue',
    why: 'Commande confirmée dont tout le reste à livrer est en stock.',
    actions: [{ id: 'open-order', label: 'Émettre le bon de livraison', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'depreciation:2026', title: 'Amortissements 2026 à comptabiliser · 3 400.00 CHF', detail: 'Camionnette 2 800.00 CHF · Ordinateurs 600.00 CHF',
    why: 'Montants calculés selon le taux et la méthode de chaque bien ; une écriture par bien. · Confiance élevée',
    actions: [{ id: 'depreciate-all', label: 'Comptabiliser les amortissements', primary: true }, { id: 'open-assets', label: 'Voir les immobilisations' }] },
  { key: 'inventory:2026', title: 'Inventaire de fin d’année 2026 : 14 article(s) à compter', detail: 'Robinet thermostatique, Colle carrelage flex, Tube multicouche 16 mm …',
    why: 'Le stock au 31 décembre se compte article par article ; Zentra calcule l’écart.',
    actions: [{ id: 'open-inventory', label: 'Ouvrir le comptage', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'portal:e1', title: 'Devis D-2026-014 accepté en ligne par Claire Morel', detail: '1 139.37 CHF · accepté le 19 oct. 2026', evidence: 'Parfait, vous pouvez commencer le 3 novembre.',
    why: 'Réponse donnée par le client sur la page du devis envoyée par lien. · Confiance élevée',
    actions: [{ id: 'portal-invoice', label: 'Créer la facture', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'portal:e2', title: 'Devis D-2026-011 refusé en ligne par Garage Dupont', detail: 'Refusé le 18 oct. 2026.', evidence: 'Nous avons choisi une autre offre.',
    actions: [{ id: 'portal-refuse', label: 'Marquer refusé', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'online:l1', title: 'Paiement en ligne reçu · F-2026-0016', detail: 'Résidence Bellevue · 486.00 CHF par TWINT ou carte',
    why: 'Payrexx confirme le paiement de ce lien ; l’encaissement n’est enregistré qu’après votre clic. · Confiance élevée',
    actions: [{ id: 'record-online', label: 'Enregistrer le paiement', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'pay-order:p1+p2+p3', title: '3 factures à payer cette semaine · 1 240.00 CHF', detail: 'Papeterie des Alpes, Swisscom (Suisse) SA, Scierie du Jura Sàrl',
    actions: [{ id: 'pay-order', label: 'Générer l’ordre de paiement', primary: true }, { id: 'postpone', label: 'Reporter de 7 jours' }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'qrmail:m1', title: 'Facture QR reçue · Scierie du Jura Sàrl', detail: '949.75 CHF · échéance 14 nov. 2026', evidence: 'Facture 10201409 · planches de chêne',
    actions: [{ id: 'qr-create', label: 'Créer la facture fournisseur', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'pay:p1', title: 'À payer · Bois & Parquets SA', detail: 'FA-8812 · CHF 2 340.00 · échéance 24 oct. 2026', actions: [{ id: 'pay', label: 'Payer', primary: true }, { id: 'iban', label: 'Copier IBAN et référence' }, { id: 'view', label: 'Voir la facture' }] },
  { key: 'stock:s1', title: 'Stock bas · Vitrificateur mat 5 l', detail: '2 restants (seuil 5)', actions: [{ id: 'order', label: 'Préparer la commande', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'contact:c1', title: 'Nouvelles coordonnées · Atelier du Lac', detail: 'Rue du Port 4, 1006 Lausanne · 021 555 01 02', actions: [{ id: 'update', label: 'Mettre à jour la fiche', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'appt:a1', title: 'Rendez-vous : visite chantier Morel', detail: 'mardi 21 oct. 2026, 10:00 · Lausanne', actions: [{ id: 'agenda', label: 'Ajouter à l’agenda', primary: true }, { id: 'ignore', label: 'Ignorer' }] },
  { key: 'hours:h1', title: '12 h non facturées · Résidence Bellevue · projet Rénovation hall', detail: 'Environ CHF 1 140.00 selon les tarifs saisis', actions: [{ id: 'invoice', label: 'Préparer la facture', primary: true }, { id: 'project', label: 'Voir le projet' }] },
  { key: 'payroll:2026-10', title: 'Salaires d’octobre 2026 à préparer', detail: 'Copie du mois précédent, cotisations recalculées par l’app. Vous contrôlez chaque fiche avant de la valider.',
    why: 'Collaborateurs en poste sans fiche pour ce mois ; fiche validée le mois précédent. · À vérifier avant de valider',
    actions: [{ id: 'ignore', label: 'Ignorer' }, { id: 'open-payroll', label: 'Ouvrir les salaires' }, { id: 'prepare-payroll', label: 'Préparer les 4 fiches', primary: true }] },
  { key: 'vat:v1', title: 'Décompte TVA 1 juil. 2026 – 30 sept. 2026 · 3 412.60 CHF à payer', detail: 'Échéance indicative 29 nov. 2026', why: 'Montant calculé par l’app sur les documents de la période, comme dans le décompte.', actions: [{ id: 'postpone', label: 'Reporter' }, { id: 'vat', label: 'Ouvrir la TVA', primary: true }] },

];
const signals: AutopilotSignalCard[] = [
  { sourceId: 'm1', receivedAt: at - 7200, title: 'Paiement annoncé', sender: 'Résidence Bellevue', evidence: '« Le virement de CHF 178.00 a été effectué ce matin. »', actionLabel: 'Enregistrer le paiement de CHF 178.00 sur F-2026-0012' },
  { sourceId: 'm2', receivedAt: at - 9000, title: 'Réclamation ou demande de suivi', sender: 'Alex Morel', evidence: '« La plinthe posée hier se décolle déjà. »', actionLabel: 'Créer un suivi' },
];
const state = { status: 'ready', canManage: true, consent: null, saving: false, error: null, activity: null, readingReviews: false, reviewsUnavailable: false,
  reviews: { organizationId: 'preview-org', nextCursor: null, items } } as unknown as AutopilotView;
const noop = () => undefined;
const journal = [
  { id: 'j1', at: '2026-10-20T09:12:00Z', key: 'qrmail:m0', actionLabel: 'Créer la facture fournisseur', title: 'Facture QR reçue · Scierie du Jura Sàrl', detail: '', ok: true, undo: { kind: 'supplier-draft' as const, invoiceId: 'x' } },
  { id: 'j2', at: '2026-10-20T08:40:00Z', key: 'bank:b0', actionLabel: 'Confirmer', title: '1 780.00 CHF reçu de Résidence Bellevue', detail: '', ok: true },
  { id: 'j3', at: '2026-10-19T17:05:00Z', key: 'reminder:r1', actionLabel: 'Reporter de 7 jours', title: 'Relance n°1 prête', detail: '', ok: true, undo: { kind: 'follow-up' as const, key: 'reminder:r1', previous: null }, undoneAt: '2026-10-19T17:06:00Z' },
];
function Preview() {
  return <div className="desktop-app" data-experience="workspace" style={{ minHeight: '100vh' }}><main className="app-main" style={{ marginLeft: 0, padding: '32px 40px' }}>
    <section className="page-content" data-screen="automation"><div className="automation-hub automation-hub--preview"><div className="automation-hub__followup">
      <AutopilotReviews onAsk={noop} askNotUnderstood={query.get('ask') === 'help'} state={state} organizationId="preview-org" onOpenSource={async () => undefined} onRefresh={async () => undefined} onCatalogue={noop} canAddCatalogue
        acceptances={acceptances} onChooseAcceptance={noop} followUps={followUps} followUpSummary="2 relances prêtes · 1 en attente (promesse de paiement)" onFollowUp={noop} journal={journal} onUndo={noop} signals={signals} onSignal={noop} onIgnoreSignal={noop} onCreateQuote={noop} createdQuote={item => created[item.proposalId] ?? null}
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
function BehaviourPreview() {
  const [behaviour, setBehaviour] = useState<AutopilotBehaviour>({ ...DEFAULT_BEHAVIOUR, autoValidate: ['qrmail'] });
  return <div className="desktop-app" data-experience="workspace" style={{ minHeight: '100vh' }}><main className="app-main" style={{ marginLeft: 0, padding: '32px 16px' }}>
    <section className="page-content" data-screen="automation"><div className="automation-hub"><section className="automation-hub__settings">
      <AutopilotBehaviourSettings behaviour={behaviour} onChange={change => setBehaviour(current => ({ ...current, ...change }))} />
    </section></div></section>
  </main></div>;
}
// Demande de justificatif : données fictives, le brouillon s'ouvre dans la messagerie.
const receiptPerson = (id: string, name: string, email: string) => ({ id, name, email, employmentEnd: '' }) as unknown as Employee;
const missingReceipt: MissingReceipt = { reason: 'unlinked', ageDays: 22, movement: { id: 'm1', amountCents: 8_450, currency: 'CHF', bookingDate: '2026-10-03', valueDate: '2026-10-03', counterpartyName: 'Coop Bau+Hobby Bulle', unstructured: '', reference: '' } as BankMovement };
createRoot(document.getElementById('root')!).render(query.get('view') === 'behaviour' ? <BehaviourPreview /> : query.get('dialog') === 'poursuite'
  ? <div className="desktop-app" data-experience="workspace" style={{ minHeight: '100vh' }}><DebtCollectionDialog request={debtRequest} invoiceNumber="F-2026-0009" onClose={noop} onSaved={noop} /></div>
  : query.get('dialog') === 'justificatif'
    ? <div className="desktop-app" data-experience="workspace" style={{ minHeight: '100vh' }}><ReceiptRequestDialog receipt={missingReceipt} employees={[receiptPerson('e1', 'Luca Rossi', 'luca.rossi@atelier-leman.example'), receiptPerson('e2', 'Sara Meier', 'sara.meier@atelier-leman.example')]} companyName="Atelier du Léman Sàrl" onClose={noop} onOpened={noop} /></div>
    : <Preview />);
