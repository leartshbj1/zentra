// Sequence identifiers stay decimal strings, including beyond JS precision.
export type BusinessConflictImage = {
  fields: Record<string, { value: string | number | boolean | null; truncated: boolean; exact_integer: boolean }>;
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

// A verified preview is intentionally distinct from an installation result.
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
