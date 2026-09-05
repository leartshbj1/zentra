import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';

/** UI-only storage; native tests verify actual validation, hashes, transactions and backups. */
export function installRefundAttachmentFixture(persisted: Workspace) {
  const attachments = persisted.attachments ??= [];
  let readFailures = 0;
  const load = desktopApi.loadWorkspace;
  desktopApi.loadWorkspace = async () => {
    if (readFailures > 0) { readFailures--; throw new Error('Lecture interrompue après ajout du justificatif.'); }
    return load();
  };
  const contents = new Map<string, string>();
  async function attach(refundId: string, file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2,'0')).join('');
    const existing = attachments.find(item => item.entityId === refundId && item.sha256 === hash);
    if (existing) return;
    const id = `refund-file-${contents.size}`;
    attachments.push({ id, entityId: refundId, entityType: 'expense_refund', projectId: persisted.expenses.find(expense => expense.refunds?.some(refund => refund.id === refundId))?.projectId ?? null, originalName: file.name, mimeType: file.type, sizeBytes: file.size, sha256: hash, createdAt: '2026-09-05T12:00:00Z', updatedAt: '2026-09-05T12:00:00Z' });
    contents.set(id, btoa(String.fromCharCode(...bytes)));
    sessionStorage.setItem('qa-refund-attachment-count', String(contents.size));
  }
  desktopApi.addExpenseRefundAttachment = async (refundId, file) => {
    sessionStorage.setItem('qa-refund-attachment-attempts', String(1 + Number(sessionStorage.getItem('qa-refund-attachment-attempts') || '0')));
    if (sessionStorage.getItem('qa-refund-attachment-deny') === '1') { sessionStorage.removeItem('qa-refund-attachment-deny'); throw new Error('Ajout refusé : le fichier ne peut pas être copié.'); }
    await attach(refundId, file);
    if (sessionStorage.getItem('qa-refund-attachment-read-fail') === '1') { sessionStorage.removeItem('qa-refund-attachment-read-fail'); readFailures = 2; }
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
  desktopApi.openAttachment = async id => {
    if (sessionStorage.getItem('qa-refund-attachment-open-fail') === '1') { sessionStorage.removeItem('qa-refund-attachment-open-fail'); throw new Error('Fichier momentanément indisponible.'); }
    if (!contents.has(id)) throw new Error('Justificatif absent de la recette.');
    sessionStorage.setItem('qa-refund-opened', id);
    return id;
  };
  desktopApi.readProjectDocument = async id => { const data = contents.get(id); if (!data) throw new Error('Justificatif absent.'); return data; };
  return attach;
}
