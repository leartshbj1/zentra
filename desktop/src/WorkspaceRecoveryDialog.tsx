import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { Button, ErrorPanel, Modal } from './ui';
import { errorMessage } from './utils';
import './WorkspaceRecoveryDialog.css';

export function WorkspaceRecoveryDialog({ reason, onReload }: { reason: string; onReload: () => Promise<void> }) {
  const contentRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState('');
  useEffect(() => {
    const backdrop = contentRef.current?.closest('.modal-backdrop');
    if (!backdrop) return;
    const previous = new Map<Element, { inert: boolean; hidden: string | null }>();
    const protectBackground = () => {
      for (const element of document.body.children) {
        if (element === backdrop || ['SCRIPT', 'STYLE'].includes(element.tagName) || previous.has(element)) continue;
        previous.set(element, { inert: element.hasAttribute('inert'), hidden: element.getAttribute('aria-hidden') });
        element.setAttribute('inert', '');
        element.setAttribute('aria-hidden', 'true');
      }
    };
    protectBackground();
    const observer = new MutationObserver(protectBackground);
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      for (const [element, attributes] of previous) {
        if (!attributes.inert) element.removeAttribute('inert');
        if (attributes.hidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', attributes.hidden);
      }
    };
  }, []);
  return <Modal title="Enregistrement effectué" description="Les données doivent être actualisées avant de continuer." dismissible={false} onClose={() => {}}>
    <form ref={contentRef} className="workspace-recovery" onSubmit={async (event) => {
      event.preventDefault();
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setRetryError('');
      try { await onReload(); }
      catch (cause) { setRetryError(errorMessage(cause, 'La lecture des données reste indisponible.')); }
      finally { inFlight.current = false; setBusy(false); }
    }}>
      <div className="workspace-recovery__saved"><CheckCircle2 size={28} /><p>Votre opération est sauvegardée. L’actualisation relira les données sans recommencer l’enregistrement.</p></div>
      <p>La consultation et les modifications reprendront dès que les données enregistrées seront chargées.</p>
      <details><summary>Détail du problème</summary><p>{reason}</p></details>
      {retryError ? <ErrorPanel title="Actualisation impossible" message={retryError} reveal /> : null}
      <div className="form-actions"><Button type="submit" disabled={busy} data-modal-initial-focus><RefreshCw size={18} className={busy ? 'spin' : undefined} />{busy ? 'Actualisation…' : 'Actualiser les données'}</Button></div>
    </form>
  </Modal>;
}
