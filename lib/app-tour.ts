export const tourGroups = [
  'Votre quotidien',
  'Votre activité',
  'Votre entreprise',
] as const;
export const appTourScreens = [
  {
    id: 'accueil',
    label: 'Tableau de bord',
    group: 0,
    title: 'L’essentiel, dès l’ouverture.',
    description:
      'Chiffre d’affaires, paiements reçus et factures à suivre. Retrouvez votre activité sans ouvrir chaque dossier.',
    detail:
      'Dans cet exemple, Atelier du Léman suit trois factures et retrouve le travail préparé par Automation.',
  },
  {
    id: 'automation',
    label: 'Automation',
    group: 0,
    title: 'Voyez ce qui avance pour vous.',
    description:
      'Un journal commun pour les factures reçues, les tâches et les décisions. Les cas à vérifier restent bien visibles.',
    detail:
      'Automation est une option de Gestion. Les parcours par e-mail nécessitent Support relié à la même entreprise ; les réponses préparées restent à relire.',
  },
  {
    id: 'agenda',
    label: 'Agenda',
    group: 0,
    title: 'Chaque rendez-vous à sa place.',
    description:
      'Visites, échéances et rendez-vous se retrouvent dans le planning de l’entreprise.',
    detail:
      'La visite de Résidence Bellevue est liée au projet et à la personne qui s’en occupe.',
  },
  {
    id: 'projets',
    label: 'Projets',
    group: 0,
    title: 'Un dossier pour chaque projet.',
    description:
      'Retrouvez le client, les documents, le planning et les coûts du même projet, au même endroit.',
    detail:
      'Atelier du Léman suit une rénovation en cours et prépare l’aménagement d’un second client.',
  },
  {
    id: 'clients',
    label: 'Clients',
    group: 0,
    title: 'Gardez le fil avec vos clients.',
    description:
      'Coordonnées et historique restent réunis. Repartez d’une fiche client pour retrouver ses projets et ses documents.',
    detail:
      'Camille Martin et Alex Morel sont des contacts fictifs de cette entreprise de démonstration.',
  },
  {
    id: 'devis',
    label: 'Devis',
    group: 1,
    title: 'Présentez votre proposition.',
    description:
      'Retrouvez les devis en préparation, envoyés ou acceptés. Chaque document garde son client et son projet.',
    detail:
      'Le devis accepté peut servir de point de départ à la facture, avec les prestations déjà renseignées.',
  },
  {
    id: 'factures',
    label: 'Factures',
    group: 1,
    title: 'De l’émission au règlement.',
    description:
      'Repérez les factures émises, les montants encore dus et les paiements enregistrés.',
    detail:
      'L’équipe autorisée retrouve les changements enregistrés dans l’entreprise partagée avec une connexion Internet.',
  },
  {
    id: 'commandes',
    label: 'Commandes & livraisons',
    group: 1,
    title: 'Suivez la suite de la vente.',
    description:
      'Retrouvez vos commandes et les livraisons associées avant de préparer la facturation.',
    detail:
      'Ces écrans prolongent le suivi commercial dans le même espace que les devis et les factures.',
  },
  {
    id: 'relances',
    label: 'Relances',
    group: 1,
    title: 'Les factures à suivre, simplement.',
    description:
      'Repérez les échéances dépassées et préparez le suivi de vos clients.',
    detail:
      'Vous gardez la main sur les relances. La visite n’envoie aucun message.',
  },
  {
    id: 'achats',
    label: 'Achats & fournisseurs',
    group: 1,
    title: 'Les achats aussi ont leur dossier.',
    description:
      'Factures fournisseurs, références et règlements restent liés. Vous voyez ce qui est prêt et ce qui demande une vérification.',
    detail:
      'Avec Automation et Support reliés, une facture reçue par e-mail peut être préparée ici. Les informations incertaines restent à contrôler.',
  },
  {
    id: 'catalogue',
    label: 'Produits & services',
    group: 1,
    title: 'Vos prestations, prêtes à reprendre.',
    description:
      'Conservez vos produits, vos services et leurs tarifs pour les retrouver dans vos prochains documents.',
    detail:
      'Le catalogue de démonstration contient une prestation de préparation des surfaces.',
  },
  {
    id: 'temps',
    label: 'Temps',
    group: 1,
    title: 'Reliez les heures au travail réalisé.',
    description:
      'Les heures appartiennent à un projet et à un collaborateur. Retrouvez les saisies et leur état de facturation.',
    detail:
      'Élodie a enregistré quatre heures de préparation pour Résidence Bellevue.',
  },
  {
    id: 'equipe',
    label: 'Équipe',
    group: 2,
    title: 'Les informations de chacun, réunies.',
    description:
      'Retrouvez les fiches des collaborateurs et les informations utiles à la préparation des salaires.',
    detail:
      'Les dossiers du personnel sont distincts des accès au compte. Les rôles encadrent les actions de chaque membre.',
  },
  {
    id: 'salaires',
    label: 'Fiches de salaire',
    group: 2,
    title: 'La paie, période par période.',
    description:
      'Préparez les fiches à partir du dossier du collaborateur et retrouvez les périodes déjà saisies.',
    detail:
      'Les assurances et les situations individuelles restent à vérifier. Zentra n’est pas certifié Swissdec et ne transmet pas de déclaration ELM.',
  },
  {
    id: 'banque',
    label: 'Banque',
    group: 2,
    title: 'Retrouvez le bon règlement.',
    description:
      'Importez un relevé CAMT et examinez les rapprochements proposés avec vos factures.',
    detail:
      'Vous confirmez les opérations après vérification. Zentra ne déclenche pas de paiement bancaire.',
  },
  {
    id: 'comptabilite',
    label: 'Comptabilité',
    group: 2,
    title: 'Comprenez vos chiffres.',
    description:
      'Résultat, TVA et dossier de clôture : retrouvez vos informations comptables par période.',
    detail:
      'Les comptes et les liaisons doivent être configurés. Les états se contrôlent avant leur utilisation officielle.',
  },
  {
    id: 'rapports',
    label: 'Rapports',
    group: 2,
    title: 'Un projet, une vue complète.',
    description:
      'Choisissez un projet et les informations à réunir dans son rapport PDF : documents, temps, achats et suivi.',
    detail:
      'Vous décidez du contenu à partager. Le rapport reprend les informations disponibles dans le projet.',
  },
  {
    id: 'parametres',
    label: 'Paramètres',
    group: 2,
    title: 'Zentra, à votre façon.',
    description:
      'Entreprise, documents, compte et apparence : retrouvez les réglages dans des rubriques dédiées.',
    detail:
      'Personnalisez votre environnement sans perdre le fil de votre activité.',
  },
] as const;
export type TourScreen = (typeof appTourScreens)[number];
export type TourDevice = 'desktop' | 'mobile';
export function tourImage(id: string, device: TourDevice) {
  return `/tour/gestion/${id}-${device}.webp`;
}
