import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';
import './DocumentWorkbench.css';
import { t, useAppLanguage } from './language';

/** Moving one portal host keeps the editor, selection bookmarks and undo history mounted. */
export function DocumentWorkbench({ expanded, busy, onClose, children }: {
  expanded: boolean; busy: boolean; onClose: () => void; children: ReactNode;
}) {
  useAppLanguage();
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
        // The embedded opener is hidden while the portal is expanded. Wait for
        // React to restore it before returning keyboard focus, including mobile.
        const oldFocus = previousFocus.current;
        queueMicrotask(() => {
          if (!embedded.current?.isConnected || modal.open) return;
          const opener = [...host.querySelectorAll<HTMLElement>('[data-document-workbench-trigger]')]
            .find(element => element.getClientRects().length > 0);
          const target = oldFocus?.isConnected && oldFocus !== document.body && oldFocus.getClientRects().length ? oldFocus : opener;
          target?.focus({ preventScroll: true });
        });
      };
    }
    embedded.current?.append(host);
  }, [expanded, host]);
  return <>
    <div ref={embedded} className="document-workbench-anchor settings-card--wide" />
    <dialog ref={dialog} className="document-workbench" aria-label={t('Atelier de personnalisation des documents')} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="document-workbench__header">
        <button ref={closeButton} type="button" disabled={busy} onClick={onClose}><ArrowLeft size={18} aria-hidden="true" /><span>{t('Revenir aux paramètres')}</span></button>
        <div><strong>{t('Votre atelier de documents')}</strong><span>{t('Vos réglages restent présents en quittant cet espace.')}</span></div>
      </header>
    </dialog>
    {createPortal(children, host)}
  </>;
}
