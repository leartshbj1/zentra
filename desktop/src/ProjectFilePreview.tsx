import { lazy, Suspense, useState } from 'react';
import { Download, ExternalLink, FileText } from 'lucide-react';
import { desktopApi } from './bridge';
import { isMobileRuntime } from './mobileRuntime';
import { fileSizeLabel } from './projectDocuments';
import type { Attachment } from './types';
import { Button, EmptyState, ErrorPanel, Modal } from './ui';
import { errorMessage } from './utils';
import './projectFilePreview.css';

const PdfAttachmentPreview = lazy(() => import('./PdfAttachmentPreview'));

export function ProjectFilePreview({ file, bytes, url, onClose }: {
  file: Attachment; bytes: Uint8Array; url: string; onClose: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  async function openExternal() {
    if (opening) return;
    setOpening(true); setError('');
    try { await desktopApi.openAttachment(file.id); }
    catch (reason) { setError(errorMessage(reason, 'Ouverture impossible. Réessayez.')); }
    finally { setOpening(false); }
  }
  return <Modal title={file.originalName} description={fileSizeLabel(file.sizeBytes)} onClose={onClose} wide className="attachment-preview-dialog">
    <div className="attachment-preview">
      <div className="attachment-preview__content">
        {file.mimeType === 'application/pdf' ? <Suspense fallback={<p className="attachment-preview__status" role="status">Préparation du lecteur…</p>}><PdfAttachmentPreview bytes={bytes} name={file.originalName} /></Suspense>
          : file.mimeType.startsWith('image/') && !imageFailed ? <div className="attachment-preview__image"><img src={url} alt={file.originalName} onError={() => setImageFailed(true)} /></div>
          : <EmptyState icon={<FileText size={28} />} title={imageFailed ? 'Aperçu indisponible' : 'Document prêt'} text={imageFailed ? 'Cette image ne peut pas être affichée ici. Ouvrez-la dans une application compatible ou enregistrez-la.' : 'Ouvrez ou enregistrez ce fichier avec une application compatible.'} />}
      </div>
      <footer className="attachment-preview__footer">
        {error ? <ErrorPanel message={error} /> : null}
        <div className="attachment-preview__actions">
          {!isMobileRuntime() ? <a className="button button--secondary button--normal" href={url} download={file.originalName}><Download size={17} /> Enregistrer</a> : null}
          <Button onClick={() => void openExternal()} disabled={opening}><ExternalLink size={17} />{opening ? 'Ouverture…' : isMobileRuntime() ? 'Enregistrer ou partager' : 'Ouvrir avec une application'}</Button>
        </div>
      </footer>
    </div>
  </Modal>;
}
