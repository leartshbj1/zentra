import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Paperclip, ReceiptText, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { desktopApi } from './bridge';
import type { Attachment, SupplierInvoice, Workspace } from './types';
import { errorMessage } from './utils';
import { Button, ErrorPanel } from './ui';
import { t, useAppLanguage, getAppLocale } from './language';
import { purchaseNativeMessage } from './purchaseLanguage';
type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;

export function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return t("{size} o", { size: sizeBytes });
  if (sizeBytes < 1_024 * 1_024) return t("{size} Ko", { size: (sizeBytes / 1_024).toLocaleString(getAppLocale(), { maximumFractionDigits: 1 }) });
  return t("{size} Mo", { size: (sizeBytes / (1_024 * 1_024)).toLocaleString(getAppLocale(), { maximumFractionDigits: 1 }) });
}

function attachmentTypeLabel(attachment: Attachment): string {
  return ({ 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP' } as Record<string, string>)[attachment.mimeType] ?? t('Document');
}

export function SupplierInvoiceAttachments({ invoice, canEdit, busy, act, onPending }: { invoice?: SupplierInvoice; canEdit: boolean; busy: boolean; act?: ActionRunner; onPending?: (pending: boolean) => void }) {
  useAppLanguage();
  const [localError, setLocalError] = useState<{ source: string; fallback: string } | null>(null);
  const [pending, setPending] = useState(false);
  const operation = useRef(false), alive = useRef(true), editable = useRef(canEdit);
  editable.current = canEdit && invoice?.documentStatus === 'draft';
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function markPending(value: boolean) { operation.current = value; setPending(value); onPending?.(value); }

  function reportError(reason: unknown, fallback: string) { setLocalError({ source: errorMessage(reason, fallback), fallback }); }

  async function addAttachment() {
    if (!invoice || !act || busy || operation.current || !editable.current) return;
    markPending(true);
    setLocalError(null);
    try {
      const sourcePath = await desktopApi.chooseSupplierInvoiceAttachment();
      if (!sourcePath || !alive.current || !editable.current) return;
      await act(
        () => desktopApi.addSupplierInvoiceAttachment(invoice.id, sourcePath),
        t("Le justificatif a été copié et vérifié dans les données locales Zentra."),
        false,
        (reason) => reportError(reason, 'Le justificatif n’a pas pu être ajouté. Réessayez avec un PDF ou une image.'),
      );
    } catch (reason) {
      reportError(reason, 'Le justificatif n’a pas pu être ajouté.');
    } finally {
      markPending(false);
    }
  }

  async function openAttachment(attachment: Attachment) {
    setLocalError(null);
    try {
      await desktopApi.openAttachment(attachment.id);
    } catch (reason) {
      reportError(reason, 'Le justificatif local n’a pas pu être ouvert.');
    }
  }

  async function deleteAttachment(attachment: Attachment) {
    if (!invoice || !act || busy || operation.current || !editable.current || !window.confirm(t("Supprimer le justificatif « {name} » ?", { name: attachment.originalName }))) return;
    markPending(true);
    setLocalError(null);
    try { await act(
      () => desktopApi.deleteSupplierInvoiceAttachment(attachment.id),
      t("Le justificatif a été supprimé du stockage local."),
      false,
      (reason) => reportError(reason, 'Le justificatif n’a pas pu être supprimé.'),
    ); } catch (reason) { reportError(reason, 'Le justificatif n’a pas pu être supprimé.'); }
    finally { markPending(false); }
  }

  busy = busy || pending;
  return <section className="supplier-attachments" aria-busy={busy}>
    <header><div><strong><Paperclip size={16} /> {t("Justificatifs")}</strong><small>{t("PDF ou image · 25 Mio maximum · conservé sur cet appareil")}</small></div>{canEdit && invoice ? <Button type="button" variant="secondary" size="small" disabled={busy || invoice.attachments.length >= 20} onClick={() => void addAttachment()}><Upload size={14} /> {t("Ajouter un justificatif")}</Button> : null}</header>
    {!invoice ? <div className="supplier-attachments__empty"><Paperclip size={20} /><span>{t("Enregistrez d’abord le brouillon pour joindre le document original.")}</span></div> : invoice.attachments.length ? <div className="supplier-attachments__list">{invoice.attachments.map((attachment) => <article key={attachment.id}>
      <span className="supplier-attachments__icon"><ReceiptText size={17} /></span>
      <div><strong>{attachment.originalName}</strong><small>{attachmentTypeLabel(attachment)} · {formatAttachmentSize(attachment.sizeBytes)}</small></div>
      <div className="row-actions">
        <Button type="button" variant="ghost" size="small" onClick={() => void openAttachment(attachment)}><FolderOpen size={14} /> {t("Ouvrir")}</Button>
        {canEdit ? <Button type="button" variant="ghost" size="icon" disabled={busy} onClick={() => void deleteAttachment(attachment)} title={t("Supprimer le justificatif")} aria-label={t("Supprimer {name}", { name: attachment.originalName })}><Trash2 size={15} /></Button> : null}
      </div>
    </article>)}</div> : <div className="supplier-attachments__empty"><Paperclip size={20} /><span>{t("Aucun justificatif joint.")}{canEdit ? t(' Vous pourrez valider sans pièce après une confirmation explicite.') : ''}</span></div>}
    {invoice && invoice.attachments.length >= 20 && canEdit ? <div className="info-strip"><ShieldCheck size={16} /><span>{t("La limite de 20 justificatifs pour cette facture est atteinte.")}</span></div> : null}
    {localError ? <><ErrorPanel title={t("Vérifions le justificatif")} message={purchaseNativeMessage(localError.source, localError.fallback)} reveal />{purchaseNativeMessage(localError.source, localError.fallback) !== localError.source && <details className="supplier-preparation__technical"><summary>{t("Voir le message détaillé")}</summary><p>{localError.source}</p></details>}</> : null}
  </section>;
}
