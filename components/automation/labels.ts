import type { Feature } from '@/lib/automation/types';
export const FEATURE_LABELS: Record<Feature, string> = {
  transaction_classification: 'Opérations bancaires',
  document_routing: 'Documents',
  supplier_routing: 'Factures fournisseurs',
  agent_routing: 'Assistant Zentra',
  anomaly_detection: 'Opérations inhabituelles',
  priority: 'Priorités',
  email_classification: 'E-mails importés',
  import_mapping: 'Import de données',
};
