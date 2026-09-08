export const BUSINESS_HISTORY_CHANGED = 'zentra-business-bootstrap-changed';
export const BUSINESS_HISTORY_STATUS = 'zentra-business-bootstrap-status';
export const BUSINESS_HISTORY_ERROR = 'zentra-business-bootstrap-error';
export type BusinessHistoryState = {
  connected: boolean;
  organization_id?: string;
  state?:
    | 'not_prepared'
    | 'prepared'
    | 'preparing'
    | 'checking'
    | 'publishing'
    | 'installed'
    | 'needs_reconciliation';
  can_publish?: boolean;
  can_import?: boolean;
  has_remote_history?: boolean;
  remote_transfer_id?: string;
  publication_pending?: boolean;
  pending_transactions?: number;
};
export type BusinessHistoryReception = {
  state: 'receiving' | 'history_received' | 'uninitialized';
  transfer_id?: string;
  rows?: number;
  files?: number;
  received_parts?: number;
  replication_active: false;
};
