import type { Attachment, Workspace } from './types';
import { newestDocumentsFirst } from './documentOrder';

export const PROJECT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const PROJECT_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.txt,.csv,.docx,.xlsx,.pptx,.odt,.ods,.odp';

export function projectDocuments(workspace: Workspace, projectId: string) {
  return {
    files: (workspace.attachments ?? []).filter((file) => file.projectId === projectId),
    quotes: newestDocumentsFirst(workspace.quotes.filter((quote) => quote.projectId === projectId)),
    invoices: newestDocumentsFirst(workspace.invoices.filter((invoice) => invoice.projectId === projectId)),
    orders: workspace.salesOrders.filter((order) => order.projectId === projectId),
    purchases: workspace.supplierInvoices.filter((invoice) => invoice.projectId === projectId),
  };
}

export function projectFileError(file: Pick<File, 'name' | 'size'>): string | null {
  if (!file.size) return `${file.name} est vide.`;
  if (file.size > PROJECT_FILE_MAX_BYTES) return `${file.name} dépasse 25 Mo.`;
  const extension = `.${file.name.split('.').at(-1)?.toLowerCase()}`;
  if (!PROJECT_FILE_ACCEPT.split(',').includes(extension)) return `Le format de ${file.name} n’est pas pris en charge.`;
  return null;
}

export function fileSizeLabel(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export function isProjectFile(file: Attachment) {
  return file.entityType === 'project' && file.entityId === file.projectId;
}

export async function fileBase64(file: File): Promise<string> {
  const error = projectFileError(file);
  if (error) throw new Error(error);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Impossible de lire ${file.name}.`));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}
