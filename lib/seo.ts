import { absoluteSiteUrl } from './site-url';

export const homeQuestions = [
  {
    question: 'À qui s’adresse Zentra Gestion ?',
    answer: 'Zentra Gestion est un logiciel de gestion pour les PME suisses. Il réunit les devis, les QR-factures, les achats, la comptabilité, les salaires, les projets, les heures et le rapprochement bancaire par import CAMT.',
    href: '/features', label: 'Explorer les fonctionnalités de Gestion',
  },
  {
    question: 'Quelle différence entre Gestion, Support et Automation ?',
    answer: 'Zentra Gestion organise les opérations de votre entreprise. Zentra Support classe et oriente les tickets de service client dans les outils connectés. Ces deux produits ont des abonnements distincts. Zentra Automation est une option de Gestion qui propose des classements et des suggestions à vérifier avant validation.',
    href: '/automation', label: 'Comprendre l’option Automation',
  },
  {
    question: 'Combien coûte Zentra Gestion ?',
    answer: 'Zentra Gestion propose Solo à 49 CHF par mois pour 1 personne, Start à 59 CHF pour 3 personnes et Pro à 89 CHF pour 10 personnes. Les fonctions de gestion sont incluses. Automation est une option distincte à 15 CHF par mois par entreprise.',
    href: '/pricing', label: 'Comparer les tarifs Gestion',
  },
  {
    question: 'Sur quels ordinateurs utiliser Zentra ?',
    answer: 'Zentra Gestion se télécharge pour Windows et macOS. Les données métier sont conservées d’abord dans une base locale. Les fonctions de compte, de licence et les services connectés peuvent nécessiter une connexion Internet. La page de téléchargement précise les versions disponibles.',
    href: '/download', label: 'Télécharger Zentra pour Windows ou macOS',
  },
  {
    question: 'Zentra permet-il de créer des factures suisses avec QR ?',
    answer: 'Oui. Zentra Gestion permet de préparer des devis et des factures avec QR suisse, puis de suivre leurs paiements. Les relevés CAMT.053 et CAMT.054 peuvent être importés pour proposer des rapprochements à contrôler avant validation.',
    href: '/demo-facture', label: 'Voir la démonstration de facturation',
  },
  {
    question: 'Le module de salaires est-il certifié Swissdec ?',
    answer: 'Non. Zentra propose des calculs de salaires et des fiches PDF à contrôler, mais n’est pas certifié Swissdec. Aucune déclaration ELM n’est générée ou transmise.',
    href: '/features#salaires', label: 'Consulter les fonctions et limites des salaires',
  },
] as const;

export function identityData() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': absoluteSiteUrl('/#organization'), name: 'Zentra', url: absoluteSiteUrl('/'), logo: absoluteSiteUrl('/brand/zentra-wordmark.png'), email: 'info@zentraapp.ch' },
      { '@type': 'WebSite', '@id': absoluteSiteUrl('/#website'), name: 'Zentra', url: absoluteSiteUrl('/'), inLanguage: 'fr-CH', publisher: { '@id': absoluteSiteUrl('/#organization') } },
    ],
  };
}

export function faqData() {
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage', '@id': absoluteSiteUrl('/#questions'),
    mainEntity: homeQuestions.map(({ question, answer }) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })),
  };
}

const products = {
  gestion: { name: 'Zentra Gestion', path: '/gestion', operatingSystem: 'Windows, macOS', description: 'Logiciel de gestion pour PME suisses : devis, QR-factures, achats, comptabilité, salaires, projets et import bancaire CAMT.' },
  support: { name: 'Zentra Support', path: '/support', operatingSystem: 'Web', description: 'Classement, priorisation et orientation des tickets de service client dans les outils connectés. Abonnement indépendant de Zentra Gestion.' },
  automation: { name: 'Zentra Automation', path: '/automation', operatingSystem: 'Windows, macOS', description: 'Option de Zentra Gestion pour suggérer le classement des opérations bancaires et aider au traitement des documents, avec validation humaine.' },
};

export function productData(product: keyof typeof products) {
  const { path, ...data } = products[product];
  return {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication',
    '@id': absoluteSiteUrl(`${path}#software`), ...data,
    url: absoluteSiteUrl(path), applicationCategory: 'BusinessApplication', inLanguage: 'fr-CH',
    publisher: { '@id': absoluteSiteUrl('/#organization') },
  };
}

export function breadcrumbData(path: string, name: string) {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Zentra', item: absoluteSiteUrl('/') },
      { '@type': 'ListItem', position: 2, name, item: absoluteSiteUrl(path) },
    ],
  };
}

export function serializeStructuredData(data: unknown) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
