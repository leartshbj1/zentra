import type { Attachment, Workspace } from './types';
import { newestDocumentsFirst } from './documentOrder';

export const PROJECT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const PROJECT_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.txt,.csv,.docx,.xlsx,.pptx,.odt,.ods,.odp';

export function projectDocuments(workspace: Workspace, projectId: string) {
  return {
    files: newestDocumentsFirst((workspace.attachments ?? []).filter((file) => file.projectId === projectId).map(file => ({
      id: file.id, createdAt: file.createdAt, issueDate: file.createdAt, number: file.originalName || '', file,
    }))).map(entry => entry.file),
    quotes: newestDocumentsFirst(workspace.quotes.filter((quote) => quote.projectId === projectId)),
    invoices: newestDocumentsFirst(workspace.invoices.filter((invoice) => invoice.projectId === projectId)),
    orders: workspace.salesOrders.filter((order) => order.projectId === projectId),
    purchases: workspace.supplierInvoices.filter((invoice) => invoice.projectId === projectId),
  };
}

export function projectFileError(file: Pick<File, 'name' | 'size'>): string | null {
  if (!file.name.trim() || /[/\\\x00-\x1f\x7f]/.test(file.name)) return 'Renommez le fichier avec un nom simple avant de l’ajouter.';
  if ([...file.name.trim()].length > 255) return 'Le nom du fichier est trop long. Raccourcissez-le avant de l’ajouter.';
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

export async function fileBase64(file: File, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('Lecture du fichier interrompue.', 'AbortError');
  const error = projectFileError(file);
  if (error) throw new Error(error);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const interrupted = () => { cleanup(); reject(new DOMException('Lecture du fichier interrompue.', 'AbortError')); };
    const abort = () => { reader.abort(); interrupted(); };
    reader.onabort = interrupted;
    reader.onerror = () => { cleanup(); reject(new Error(`Impossible de lire ${file.name}.`)); };
    reader.onload = () => { cleanup(); resolve(String(reader.result).split(',')[1]); };
    signal?.addEventListener('abort', abort, { once: true });
    try { reader.readAsDataURL(file); } catch (reason) { cleanup(); reject(reason); }
  });
}
