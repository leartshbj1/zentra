import type { Workspace } from './types';
import { newestDocumentsFirst } from './documentOrder';
import { documentTotals, searchText } from './utils';

export function clientFolderDocuments(clientId: string, workspace: Pick<Workspace, 'quotes' | 'invoices'>, query = '') {
  return newestDocumentsFirst([
    ...workspace.quotes.filter(row => row.clientId === clientId).map(row => ({ ...row, entity: 'quotes' as const, kind: 'Devis', totalCents: documentTotals(row.lines).totalCents })),
    ...workspace.invoices.filter(row => row.clientId === clientId).map(row => ({ ...row, entity: 'invoices' as const, kind: row.type === 'credit_note' ? 'Avoir' : 'Facture', totalCents: documentTotals(row.lines).totalCents })),
  ]).filter(row => searchText([row.number, row.title, row.kind, row.issueDate], query));
}
