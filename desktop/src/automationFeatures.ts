import type { AutomationFeature } from './automation';
export const automationFeatures: Record<AutomationFeature, { title: string; description: string }> = {
  transaction_classification: { title: 'Opérations bancaires', description: 'Proposer une catégorie à partir du libellé.' },
  document_routing: { title: 'Documents', description: 'Reconnaître le document et retrouver le bon écran.' },
  supplier_routing: { title: 'Factures fournisseurs', description: 'Préparer le fournisseur, le projet et la catégorie du brouillon.' },
  agent_routing: { title: 'Assistant Zentra', description: 'Retrouver le bon formulaire à partir de votre demande.' },
  anomaly_detection: { title: 'Opérations inhabituelles', description: 'Signaler les opérations bancaires à examiner.' },
  priority: { title: 'Priorités', description: 'Vous aider à examiner les échéances.' },
  email_classification: { title: 'E-mails importés', description: 'Reconnaître le sujet des messages déjà importés.' },
  import_mapping: { title: 'Import de données', description: 'Proposer les colonnes du catalogue avant import.' },
};
