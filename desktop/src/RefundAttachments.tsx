import { useRef, useState } from 'react';
import { FolderOpen, Paperclip, X } from 'lucide-react';
import { desktopApi } from './bridge';
import { fileSizeLabel, PROJECT_FILE_MAX_BYTES } from './projectDocuments';
import type { Attachment, ExpenseRefund, Workspace } from './types';
import { Button, ErrorPanel, Field, FormActions, Modal } from './ui';
import { errorMessage } from './utils';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (error: unknown) => void) => Promise<boolean>;

export function RefundReceiptPicker({ receipt, onChange, disabled, onError }: {
  receipt: File | null; onChange: (file: File | null) => void; disabled: boolean; onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="refund-receipt-picker"><Field label="Justificatif de l’avoir" wide hint="PDF, JPG, PNG ou WebP · 25 Mo maximum. La pièce sera aussi classée dans le projet de la dépense.">
    <input ref={input} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" disabled={disabled} onChange={(event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.size || file.size > PROJECT_FILE_MAX_BYTES || !/\.(pdf|jpe?g|png|webp)$/i.test(file.name)) {
        onChange(null); event.target.value = ''; onError('Choisissez un PDF ou une image JPG, PNG ou WebP de 1 octet à 25 Mo.'); return;
      }
      onChange(file); onError('');
    }} />
    </Field>
    {receipt ? <span className="refund-receipt-selection"><span><strong>{receipt.name}</strong> · {fileSizeLabel(receipt.size)}</span><Button type="button" variant="ghost" size="small" disabled={disabled} onClick={() => { onChange(null); if (input.current) input.current.value = ''; }} aria-label="Retirer le justificatif sélectionné"><X size={16} /></Button></span> : null}
  </div>;
}

export function RefundAttachmentList({ attachments }: { attachments: Attachment[] }) {
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState('');
  if (!attachments.length) return null;
  return <div className="refund-attachments" aria-label="Justificatifs du remboursement">
    {attachments.map((file) => <div className="refund-attachments__file" key={file.id}>
      <Paperclip size={16} /><span><strong>{file.originalName}</strong><small>{fileSizeLabel(file.sizeBytes)}</small></span>
      <Button type="button" variant="secondary" size="small" disabled={opening !== null} aria-label={`Ouvrir ${file.originalName}`} onClick={async () => {
        setOpening(file.id); setError('');
        try { await desktopApi.openAttachment(file.id); }
        catch (failure) { setError(errorMessage(failure, 'Le justificatif ne peut pas être ouvert.')); }
        finally { setOpening(null); }
      }}><FolderOpen size={14} /> {opening === file.id ? 'Ouverture…' : 'Ouvrir'}</Button>
    </div>)}
    {error ? <ErrorPanel title="Justificatif indisponible" message={error} reveal /> : null}
  </div>;
}

export function RefundAttachmentForm({ refund, busy, close, act }: { refund: ExpenseRefund; busy: boolean; close: () => void; act: ActionRunner }) {
  const [receipt, setReceipt] = useState<File | null>(null);
  const [error, setError] = useState('');
  const saving = useRef(false);
  return <Modal title="Joindre un justificatif au remboursement" description={refund.reference} onClose={close} dismissible={!busy}>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (!receipt || busy || saving.current) return;
      saving.current = true; setError('');
      try {
        const saved = await act(async () => {
          try { return await desktopApi.addExpenseRefundAttachment(refund.id, receipt); }
          catch (failure) { if (!(failure instanceof WorkspaceRefreshAfterMutationError)) setError(errorMessage(failure, 'Le justificatif n’a pas pu être ajouté.')); throw failure; }
        }, 'Le justificatif est lié au remboursement et à son projet.', false, () => {});
        if (saved) close();
      } finally { saving.current = false; }
    }}>
      <p className="field__hint">Cette pièce complète l’historique conservé. Les dates, montants et écritures du remboursement restent inchangés.</p>
      <RefundReceiptPicker receipt={receipt} onChange={setReceipt} disabled={busy} onError={setError} />
      {error ? <ErrorPanel title="Justificatif à contrôler" message={error} reveal /> : null}
      <FormActions onCancel={close} busy={busy} disabled={!receipt} submitLabel="Ajouter le justificatif" />
    </form>
  </Modal>;
}
