import { absoluteSiteUrl } from './site-url';

export const homeQuestions = [
  {
    question: 'À qui s’adresse Zentra Gestion ?',
    answer: 'Zentra Gestion est un logiciel de gestion pour les PME suisses. Il réunit les devis, les QR-factures, les achats, la comptabilité, les salaires, les projets, les heures et le rapprochement bancaire par import CAMT.',
    href: '/features', label: 'Explorer les fonctionnalités de Gestion',
  },
  {
    question: 'Quelle différence entre Gestion, Support et Automation ?',
    answer: 'Gestion rassemble les opérations de votre entreprise. Support organise ses messages et tickets. Automation est une option de Gestion qui prépare des classements et applique les traitements autorisés. En reliant Support à la même entreprise, vous pouvez aussi traiter les factures reçues et les confirmations de rendez-vous. Gestion et Support ont des abonnements distincts ; Automation coûte 15 CHF par mois par entreprise.',
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
    href: '/demo-facture#factures', label: 'Voir l’écran des factures',
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
  support: { name: 'Zentra Support', path: '/support', operatingSystem: 'Web', description: 'Espace de réception et de traitement des demandes clients. Classement et routage automatique avec Automation pour une entreprise Gestion reliée.' },
  automation: { name: 'Zentra Automation', path: '/automation', operatingSystem: 'Windows, macOS, iOS, Android, Web', description: 'Option de Gestion pour préparer les factures fournisseurs, les rendez-vous, les classements et les tâches selon vos règles. Avec Support relié, les messages alimentent les parcours de Gestion ; les cas incertains restent à vérifier.' },
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
