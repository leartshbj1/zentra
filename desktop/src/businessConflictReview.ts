// Sequence identifiers stay decimal strings, including beyond JS precision.
export type BusinessConflictImage = {
  fields: Record<string, { value: string | number | boolean | null; truncated: boolean; exact_integer: boolean; text_sha256?: string }>;
  truncated: boolean;
} | null;

export type BusinessConflictChoice = 'local' | 'shared';
export type BusinessResolutionRequest = {
  review_id: string;
  decisions: Array<{ transaction_id: string; choice: BusinessConflictChoice }>;
  after_sequence?: string;
};

export type BusinessConflictReview = {
  state: 'conflict_review';
  review_id: string;
  transaction_id: string;
  organization_id: string;
  revision: number;
  receipt_sha256: string;
  confirmed_transaction_id: string | null;
  decision_scope: 'whole_transaction';
  conflict_count: number;
  pending_changes: number;
  can_choose: boolean;
  transactions: Array<{
    transaction_id: string;
    first_sequence: string;
    last_sequence: string;
    change_count: number;
    tables: Array<{ table: string; change_count: number }>;
    conflict: {
      sequence: string;
      table: string;
      key_json: string;
      base: BusinessConflictImage;
      local: BusinessConflictImage;
      shared: BusinessConflictImage;
    } | null;
  }>;
  next_after_sequence: string | null;
  installed: false;
  acknowledged: false;
  replication_active: false;
};

export type BusinessConflictChange = {
  sequence: string;
  table: string;
  key_json: string;
  operation: 'insert' | 'update' | 'delete';
  base: BusinessConflictImage;
  local: BusinessConflictImage;
  shared: BusinessConflictImage;
  first_conflict: boolean;
};
export type BusinessConflictChangesRequest = { review_id: string; local_transaction_id: string; after_sequence?: string };
export type BusinessConflictChanges = {
  state: 'conflict_changes'; review_id: string; local_transaction_id: string;
  changes: BusinessConflictChange[]; change_count: number; next_after_sequence: string | null;
  shared_image_scope: 'received_revision';
};
export type BusinessConflictTextRequest = {
  review_id: string; local_transaction_id: string; sequence: string;
  image: 'base' | 'local' | 'shared'; field: string; offset: number;
};
export type BusinessConflictText = {
  state: 'conflict_text'; review_id: string; local_transaction_id: string; sequence: string;
  text: string; offset: number; total_characters: number; next_offset: number | null;
};
export type BusinessSavedResolutions = {
  state: 'saved_resolutions'; review_id: string;
  proposals: Array<{ resolution_id: string; created_at: string }>;
};

const labels: Record<string, string> = {
  clients: 'Client', projects: 'Projet', quotes: 'Devis', quote_items: 'Ligne de devis', invoices: 'Facture', invoice_items: 'Ligne de facture',
  audit_log: 'Historique de l’opération', project_documents: 'Document du projet', company_settings: 'Entreprise',
  payments: 'Paiement', employees: 'Collaborateur', payslips: 'Fiche de salaire', journal_entries: 'Écriture comptable', journal_lines: 'Ligne comptable',
  name: 'Nom', title: 'Titre', description: 'Description', notes: 'Notes', status: 'Statut', quantity: 'Quantité', unit: 'Unité',
  unit_price_cents: 'Prix unitaire', total_cents: 'Total', vat_bp: 'TVA',
  discount_bp: 'Remise', address_line1: 'Adresse', postal_code: 'Code postal', city: 'Ville',
  country: 'Pays', email: 'E-mail', phone: 'Téléphone', document_number: 'Numéro', created_at: 'Création', updated_at: 'Modification',
};
export function conflictLabel(value: string) { return labels[value] ?? value.replaceAll('_', ' '); }
export function conflictTechnicalField(table: string, key: string) {
  return table === 'audit_log' || key === 'id' || /(_id|_sha256|_hash)$/.test(key) || ['created_at', 'updated_at', 'deleted_at', 'revision'].includes(key);
}
export function conflictValue(key: string, value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) return 'Non renseigné';
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (value === '') return 'Vide';
  if (/(?:_cents|_bp)$/.test(key) && /^-?\d+$/.test(String(value))) {
    const integer = BigInt(String(value)), magnitude = integer < 0n ? -integer : integer;
    return `${integer < 0n ? '−' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}${key.endsWith('_bp') ? ' %' : ''}`;
  }
  return String(value);
}
export function conflictFields(change: BusinessConflictChange) {
  const images = [change.base, change.local, change.shared];
  return [...new Set(images.flatMap(image => Object.keys(image?.fields ?? {})))].map(key => ({
    key, changed: new Set(images.map(image => JSON.stringify(image?.fields[key] ?? null))).size > 1,
  })).sort((a, b) => Number(b.changed) - Number(a.changed) || a.key.localeCompare(b.key, 'fr'));
}

// A preview never authorizes installation. The separate explicit application
// command rechecks the saved proposal and obtains the interface write barrier.
export type BusinessResolutionPreview = Omit<BusinessConflictReview, 'state'> & {
  state: 'resolution_preview' | 'resolution_needs_review';
  native_guards_validated: boolean;
  proposed_state_sha256: string | null;
  decision_sha256: string;
  decisions: Record<string, BusinessConflictChoice>;
  can_install: false;
  documents_verified: boolean;
  documents: {
    final_count: number;
    files_to_replace: number;
    total_size_bytes: number;
    plan_sha256: string;
  } | null;
};

export type BusinessResolutionSaved = Omit<BusinessResolutionPreview, 'state'> & {
  state: 'resolution_saved';
  saved: {
    resolution_id: string;
    created_at: string;
    candidate_and_documents_preserved: true;
    server_retirement_requested: false;
  };
};
