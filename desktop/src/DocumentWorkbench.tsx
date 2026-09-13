import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';
import './DocumentWorkbench.css';

/** Moving one portal host keeps the editor, selection bookmarks and undo history mounted. */
export function DocumentWorkbench({ expanded, busy, onClose, children }: {
  expanded: boolean; busy: boolean; onClose: () => void; children: ReactNode;
}) {
  const [host] = useState(() => document.createElement('div'));
  const embedded = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const modal = dialog.current!;
    if (expanded && typeof modal.showModal === 'function') {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      modal.append(host);
      modal.showModal();
      closeButton.current?.focus({ preventScroll: true });
      const overflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        modal.close();
        embedded.current?.append(host);
        document.body.style.overflow = overflow;
        if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
      };
    }
    embedded.current?.append(host);
  }, [expanded, host]);
  return <>
    <div ref={embedded} className="document-workbench-anchor settings-card--wide" />
    <dialog ref={dialog} className="document-workbench" aria-label="Atelier de personnalisation des documents" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="document-workbench__header">
        <button ref={closeButton} type="button" disabled={busy} onClick={onClose}><ArrowLeft size={18} aria-hidden="true" /><span>Revenir aux paramètres</span></button>
        <div><strong>Votre atelier de documents</strong><span>Vos réglages restent présents en quittant cet espace.</span></div>
      </header>
    </dialog>
    {createPortal(children, host)}
  </>;
}
