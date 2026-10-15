import { desktopApi } from './bridge';
import { catalogItemToDocumentLine } from './catalog';
import { catalogFormData, type CatalogDraft } from './catalogForm';
import { withKnownErrorIncident } from './diagnostics';
import { t } from './language';
import type {
  AgendaEvent,
  AppSettings,
  CatalogItem,
  DocumentLine,
  NogaCatalog,
  NogaSection,
  Project,
  Workspace,
} from './types';
import { addDaysIso, createId, documentTotals } from './utils';
import type { WorkspaceMutationOrigin } from './workspaceMemberOrigin';
import { WorkspaceOriginChangedError } from './workspaceOrigin';

/*
 * Entreprise de démonstration « Atelier Démo Sàrl ».
 *
 * Toutes les données sont fictives (adresses inventées, e-mails en
 * @example.invalid, aucun téléphone, aucun IBAN). La démonstration ne crée que
 * des fiches et des brouillons : jamais de facture émise ni de paiement, qui
 * produiraient des écritures comptables et consommeraient la numérotation.
 */

export const DEMO_FLAG_KEY = 'zentra.demo.workspace.v1';
export const DEMO_COMPANY_NAME = 'Atelier Démo Sàrl';

/** Marque l’espace local comme démonstration. Renvoie false si le stockage est indisponible. */
export function markDemoWorkspace(): boolean {
  try {
    localStorage.setItem(DEMO_FLAG_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export function isDemoWorkspace(): boolean {
  try {
    return localStorage.getItem(DEMO_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/** Renvoie false si le stockage est indisponible ; l’indicateur reste alors inchangé. */
export function clearDemoWorkspaceFlag(): boolean {
  try {
    localStorage.removeItem(DEMO_FLAG_KEY);
    return true;
  } catch {
    return false;
  }
}

type DemoActivity = { section: NogaSection['code'] | ''; division: string };

/** F/43 (travaux de construction spécialisés) si possible, sinon la première section pourvue d’une division. */
function demoActivity(catalog: NogaCatalog): DemoActivity {
  const sections = Array.isArray(catalog?.sections) ? catalog.sections : [];
  const withDivisions = sections.filter(
    (section) => Array.isArray(section.divisions) && section.divisions.length > 0,
  );
  const construction = withDivisions.find((section) => section.code === 'F');
  if (construction) {
    const preferred = construction.divisions.find((division) => division.code === '43');
    return { section: 'F', division: (preferred ?? construction.divisions[0]).code };
  }
  const first = withDivisions[0];
  return first
    ? { section: first.code, division: first.divisions[0].code }
    : { section: '', division: '' };
}

/**
 * Réglages d’intégration de l’entreprise fictive. Partir des réglages initiaux
 * de l’assistant (initialOnboardingSettings) garde toutes les autres sections
 * valides ; seul le socle « essentiel » (identité et activité) est rempli.
 * Si le catalogue NOGA ne contient aucune division, la section reste vide et
 * validateOnboarding le signale.
 */
export function demoCompanySettings(base: AppSettings, catalog: NogaCatalog): AppSettings {
  const settings = structuredClone(base);
  const activity = demoActivity(catalog);
  return {
    ...settings,
    organization: {
      ...settings.organization,
      legalName: DEMO_COMPANY_NAME,
      legalForm: 'Sàrl',
      contactName: 'Camille Démo',
      email: 'demo@example.invalid',
      phone: '',
      website: '',
      uidNumber: '',
      vatNumber: '',
      vatRegistered: false,
      logoPath: '',
      address: {
        ...settings.organization.address,
        street: 'Rue de la Démonstration',
        buildingNumber: '12',
        postalCode: '1003',
        city: 'Lausanne',
        canton: 'VD',
        country: 'CH',
      },
    },
    business: {
      ...settings.business,
      nogaSection: activity.section,
      nogaDivision: activity.division,
      nogaDetailedCode: '',
      activityDescription:
        'Peinture intérieure, plâtrerie et petites rénovations pour particuliers, commerces et coopératives (entreprise fictive de démonstration).',
    },
  };
}

type ClientKey = 'shop' | 'person' | 'coop';
type CatalogKey = 'painting' | 'plaster' | 'paint' | 'protection';
type ProjectKey = 'stairwell' | 'boutique';

const demoClients: ReadonlyArray<{
  key: ClientKey;
  company: string;
  contactPerson: string;
  email: string;
  street: string;
  buildingNumber: string;
  postalCode: string;
  city: string;
  canton: string;
  notes: string;
}> = [
  {
    key: 'shop',
    company: 'Boulangerie du Bourg Exemple SA',
    contactPerson: 'Sophie Martin',
    email: 'sophie.martin@example.invalid',
    street: 'Rue de l’Exemple',
    buildingNumber: '14',
    postalCode: '1110',
    city: 'Morges',
    canton: 'VD',
    notes: 'Client fictif de démonstration : PME avec une boutique et un atelier.',
  },
  {
    key: 'person',
    company: '',
    contactPerson: 'Luc Exemple',
    email: 'luc.exemple@example.invalid',
    street: 'Chemin de la Démo',
    buildingNumber: '3',
    postalCode: '1205',
    city: 'Genève',
    canton: 'GE',
    notes: 'Client fictif de démonstration : particulier.',
  },
  {
    key: 'coop',
    company: 'Coopérative d’habitation Les Essais',
    contactPerson: 'Nadia Rossi',
    email: 'gerance.lesessais@example.invalid',
    street: 'Route des Essais',
    buildingNumber: '27',
    postalCode: '1630',
    city: 'Bulle',
    canton: 'FR',
    notes: 'Client fictif de démonstration : coopérative d’habitation.',
  },
];

const demoCatalog: ReadonlyArray<{ key: CatalogKey; draft: Omit<CatalogDraft, 'vatBp'> }> = [
  {
    key: 'painting',
    draft: {
      kind: 'service', name: 'Travaux de peinture', sku: 'MO-PEINT',
      description: 'Préparation des supports et application en deux couches.',
      unit: 'heure', salesPrice: '85.00', purchaseCost: '', trackStock: false, reorderLevel: '0',
    },
  },
  {
    key: 'plaster',
    draft: {
      kind: 'service', name: 'Plâtrerie et rebouchage', sku: 'MO-PLATR',
      description: 'Rebouchage, ponçage et lissage des murs et plafonds.',
      unit: 'heure', salesPrice: '92.00', purchaseCost: '', trackStock: false, reorderLevel: '0',
    },
  },
  {
    key: 'paint',
    draft: {
      kind: 'product', name: 'Peinture intérieure blanche mate, 10 l', sku: 'PEINT-10L',
      description: 'Peinture acrylique lessivable pour murs et plafonds.',
      unit: 'pièce', salesPrice: '129.00', purchaseCost: '78.00', trackStock: false, reorderLevel: '0',
    },
  },
  {
    key: 'protection',
    draft: {
      kind: 'product', name: 'Film de protection pour sols, 25 m²', sku: 'PROT-SOL',
      description: 'Rouleau antidérapant pour protéger les sols pendant les travaux.',
      unit: 'pièce', salesPrice: '34.50', purchaseCost: '19.00', trackStock: false, reorderLevel: '0',
    },
  },
];

const demoProjects: ReadonlyArray<{
  key: ProjectKey;
  clientKey: ClientKey;
  name: string;
  address: string;
  status: Project['status'];
  plannedStartDays: number;
  plannedEndDays: number;
  actualStartDays: number | null;
  budgetCents: number;
  plannedHours: number;
  notes: string;
}> = [
  {
    key: 'stairwell',
    clientKey: 'coop',
    name: 'Rénovation de la cage d’escalier',
    address: 'Route des Essais 27, 1630 Bulle',
    status: 'in_progress',
    plannedStartDays: -7,
    plannedEndDays: 21,
    actualStartDays: -5,
    budgetCents: 1_850_000,
    plannedHours: 120,
    notes: 'Quatre étages, travaux par étage pour garder l’escalier praticable.',
  },
  {
    key: 'boutique',
    clientKey: 'shop',
    name: 'Rafraîchissement des peintures de la boutique',
    address: 'Rue de l’Exemple 14, 1110 Morges',
    status: 'planned',
    plannedStartDays: 14,
    plannedEndDays: 18,
    actualStartDays: null,
    budgetCents: 620_000,
    plannedHours: 40,
    notes: 'Travaux à réaliser hors des heures d’ouverture.',
  },
];

const demoQuotes: ReadonlyArray<{
  clientKey: ClientKey;
  projectKey: ProjectKey | null;
  title: string;
  lines: ReadonlyArray<readonly [CatalogKey, number]>;
  notes: string;
}> = [
  {
    clientKey: 'coop',
    projectKey: 'stairwell',
    title: 'Peinture de la cage d’escalier, 4 étages',
    lines: [['painting', 64], ['plaster', 16], ['paint', 12], ['protection', 6]],
    notes: 'Travaux réalisés étage par étage ; accès des habitants maintenu.',
  },
  {
    clientKey: 'person',
    projectKey: null,
    title: 'Peinture du salon et du couloir',
    lines: [['painting', 18], ['paint', 3], ['protection', 2]],
    notes: 'Déplacement et protection des meubles compris.',
  },
];

const demoNotes: ReadonlyArray<{ projectKey: ProjectKey; title: string; body: string; pinned: boolean }> = [
  {
    projectKey: 'stairwell',
    title: 'Cage d’escalier : points à vérifier',
    body: 'Relevé du chantier\n☑ Protéger la main courante et les portes palières\n☐ Contrôler l’humidité du mur nord avant la deuxième couche\n☐ Commander deux seaux de peinture supplémentaires',
    pinned: true,
  },
  {
    projectKey: 'boutique',
    title: 'Boutique de Morges : idées de teintes',
    body: 'Souhait de la cliente : blanc cassé pour les murs, gris clair pour les plinthes.\nApporter le nuancier lors de la visite technique.',
    pinned: false,
  },
];

const demoAgenda: ReadonlyArray<{
  projectKey: ProjectKey | null;
  title: string;
  kind: AgendaEvent['kind'];
  startTime: string;
  endTime: string;
  location: string;
  notes: string;
}> = [
  {
    projectKey: 'boutique',
    title: 'Visite technique de la boutique',
    kind: 'visit',
    startTime: '09:00',
    endTime: '10:00',
    location: 'Rue de l’Exemple 14, 1110 Morges',
    notes: 'Mesurer les surfaces et présenter le nuancier.',
  },
  {
    projectKey: null,
    title: 'Présentation du devis à Luc Exemple',
    kind: 'appointment',
    startTime: '14:00',
    endTime: '15:00',
    location: 'Chemin de la Démo 3, 1205 Genève',
    notes: 'Apporter le devis du salon et du couloir.',
  },
];

/** Les seules méthodes du pont utilisées par la démonstration. */
export type DemoSeedApi = Pick<
  typeof desktopApi,
  'loadWorkspace' | 'createEntity' | 'saveCatalogItem' | 'saveProject' | 'saveDocument' | 'saveWorkNote' | 'saveAgendaEvent'
>;

export type DemoSeedOptions = {
  /** Origine capturée par `act` ; sans elle, l’espace relu au départ sert de garde. */
  origin?: WorkspaceMutationOrigin;
  /** Date de référence (tests). */
  now?: Date;
};

function localIsoDate(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function workingDayFrom(date: string): string {
  let current = date;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const day = new Date(`${current}T12:00:00`).getDay();
    if (day !== 0 && day !== 6) return current;
    current = addDaysIso(current, 1);
  }
  return current;
}

function hasBusinessData(workspace: Workspace): boolean {
  return [workspace.clients, workspace.catalogItems, workspace.projects, workspace.quotes, workspace.invoices]
    .some((rows) => Array.isArray(rows) && rows.length > 0);
}

function failure(message: string, reason: unknown): Error {
  return withKnownErrorIncident(new Error(message, { cause: reason }), reason);
}

/** Exécute une création ; la première erreur arrête toute la démonstration. */
async function create<T>(label: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (reason) {
    throw failure(
      t('Les données de démonstration sont incomplètes : « {item} » n’a pas pu être créé. Les éléments déjà ajoutés restent dans votre espace.', { item: label }),
      reason,
    );
  }
}

/**
 * Remplit une entreprise vide, déjà créée, avec des données fictives :
 * 3 clients, 4 références de catalogue, 2 projets, 2 devis en brouillon,
 * 2 notes et 2 rendez-vous dans les prochains jours ouvrables.
 *
 * Uniquement par les API existantes du pont, dans l’ordre
 * clients → catalogue → projets → devis → notes → agenda.
 * La création s’arrête à la première erreur et lève une Error en français
 * (cause d’origine dans `cause`). Les éléments déjà créés restent dans
 * l’espace : rien n’est annulé, et un nouvel appel est ensuite refusé car
 * l’entreprise n’est plus vide.
 *
 * L’indicateur local (markDemoWorkspace) reste à la charge de l’appelant.
 */
export async function seedDemoWorkspace(
  api: DemoSeedApi = desktopApi,
  options: DemoSeedOptions = {},
): Promise<void> {
  const { origin } = options;
  let workspace: Workspace;
  try {
    workspace = await api.loadWorkspace(origin?.workspaceScope, origin?.memberContextNonce);
  } catch (reason) {
    throw failure(t('Votre espace n’a pas pu être lu. Aucune donnée de démonstration n’a été ajoutée.'), reason);
  }
  const settings = workspace.settings;
  if (!workspace.onboardingCompleted || !settings)
    throw new Error(t('Créez d’abord votre entreprise avant d’ajouter les données de démonstration.'));
  if (origin && workspace.workNotesScope !== origin.workspaceScope) throw new WorkspaceOriginChangedError();
  if (hasBusinessData(workspace))
    throw new Error(t('Cet espace contient déjà des données. Les données de démonstration ne sont ajoutées que dans une entreprise vide.'));

  const scope = origin?.workspaceScope ?? (workspace.workNotesScope || undefined);
  const nonce = origin?.memberContextNonce;
  const today = localIsoDate(options.now ?? new Date());

  // Clients : même forme que ContactForm (le numéro de bâtiment va dans addressLine2).
  const clientIds = {} as Record<ClientKey, string>;
  for (const client of demoClients) {
    const id = createId();
    const name = client.company || client.contactPerson;
    await create(name, () => api.createEntity('clients', {
      id,
      name,
      company: client.company,
      contactPerson: client.contactPerson,
      email: client.email,
      phone: '',
      addressLine1: client.street,
      addressLine2: client.buildingNumber,
      postalCode: client.postalCode,
      city: client.city,
      canton: client.canton,
      country: 'CH',
      notes: client.notes,
    }, scope, nonce));
    clientIds[client.key] = id;
  }

  // Catalogue : catalogFormData, exactement comme CatalogItemForm. Taux par défaut du formulaire.
  const vatBp = settings.organization.vatRegistered ? settings.billing.vatRatesBp[0] ?? 0 : 0;
  const catalogItems = {} as Record<CatalogKey, CatalogItem>;
  for (const entry of demoCatalog) {
    const id = createId();
    const data = catalogFormData({ ...entry.draft, vatBp: String(vatBp) }, false);
    await create(data.name, () => api.saveCatalogItem(id, data, undefined, scope, nonce));
    catalogItems[entry.key] = {
      id,
      kind: data.kind,
      sku: data.sku,
      name: data.name,
      description: data.description,
      unit: data.unit,
      salesPriceCents: data.salesPriceCents,
      purchaseCostCents: data.purchaseCostCents,
      vatBp: data.vatBp,
      trackStock: data.trackStock,
      stockQuantityMilli: 0,
      reorderLevelMilli: data.reorderLevelMilli,
      archivedAt: null,
      createdAt: '',
      updatedAt: '',
    };
  }

  // Projets : même forme que le formulaire de projet (adresse libre dans addressLine1).
  const projectIds = {} as Record<ProjectKey, string>;
  for (const project of demoProjects) {
    projectIds[project.key] = await create(project.name, () => api.saveProject({
      clientId: clientIds[project.clientKey],
      code: '',
      name: project.name,
      addressLine1: project.address,
      addressLine2: '',
      postalCode: '',
      city: '',
      canton: '',
      status: project.status,
      plannedStartDate: addDaysIso(today, project.plannedStartDays),
      plannedEndDate: addDaysIso(today, project.plannedEndDays),
      actualStartDate: project.actualStartDays === null ? '' : addDaysIso(today, project.actualStartDays),
      actualEndDate: '',
      budgetCents: project.budgetCents,
      plannedMinutes: project.plannedHours * 60,
      description: '',
      notes: project.notes,
    }, undefined, scope, nonce));
  }

  // Devis : brouillons uniquement, même forme de données que DocumentEditor.
  const validityDays = settings.billing.quoteValidityDays > 0 ? settings.billing.quoteValidityDays : 30;
  for (const quote of demoQuotes) {
    const lines: DocumentLine[] = quote.lines.map(([key, quantity]) => ({
      ...catalogItemToDocumentLine(catalogItems[key]),
      quantity,
    }));
    const totals = documentTotals(lines);
    await create(quote.title, () => api.saveDocument('quotes', {
      clientId: clientIds[quote.clientKey],
      projectId: quote.projectKey ? projectIds[quote.projectKey] : null,
      title: quote.title,
      status: 'draft',
      issueDate: today,
      currency: settings.billing.currency || 'CHF',
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      vatCents: totals.vatCents,
      totalCents: totals.totalCents,
      notes: quote.notes,
      terms: settings.billing.defaultFooter,
      validUntil: addDaysIso(today, validityDays),
    }, lines, undefined, scope, nonce));
  }

  for (const note of demoNotes) {
    await create(note.title, () => api.saveWorkNote({
      id: createId(),
      title: note.title,
      body: note.body,
      projectId: projectIds[note.projectKey],
      pinned: note.pinned,
      expectedUpdatedAt: null,
      expectedWorkspaceScope: scope,
    }));
  }

  // Rendez-vous sur deux jours ouvrables distincts, dans les sept prochains jours.
  let previousDate = '';
  for (const event of demoAgenda) {
    const date = workingDayFrom(previousDate ? addDaysIso(previousDate, 1) : addDaysIso(today, 2));
    previousDate = date;
    await create(event.title, () => api.saveAgendaEvent({
      id: createId(),
      isNew: true,
      expectedUpdatedAt: null,
      title: event.title,
      startDate: date,
      endDate: date,
      allDay: false,
      startTime: event.startTime,
      endTime: event.endTime,
      kind: event.kind,
      status: 'scheduled',
      location: event.location,
      notes: event.notes,
      projectId: event.projectKey ? projectIds[event.projectKey] : null,
      employeeId: null,
    }));
  }
}
