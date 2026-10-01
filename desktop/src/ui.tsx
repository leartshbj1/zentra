import { AssistantHelpButton, useAssistantScreen } from './assistantContext';
import { t, useAppLanguage } from './language';
import { createContext, useContext, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ButtonHTMLAttributes, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { Archive, ChevronRight, Inbox, LoaderCircle, X } from 'lucide-react';
import { ErrorGuidance } from './ErrorGuidance';
import type { UserErrorOperation } from './userErrors';

export function Button({
  variant = 'primary',
  size = 'normal',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark';
  size?: 'small' | 'normal' | 'large' | 'icon';
}) {
  return (
    <button className={`button button--${variant} button--${size} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`field ${wide ? 'field--wide' : ''} ${error ? 'field--error' : ''}`}>
      <span className="field__label">
        {label} {required ? <em>{t('obligatoire')}</em> : null}
      </span>
      {children}
      {error ? <span className="field__error" role="alert">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {eyebrow ? <p className="section-heading__context">{eyebrow}</p> : null}
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="section-heading__action">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  actionLabel,
  actionVariant = 'primary',
  onAction,
  disabled,
}: {
  icon?: ReactNode;
  title: string;
  text: string;
  actionLabel?: string;
  actionVariant?: 'primary' | 'secondary';
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon ?? <Inbox size={24} />}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {actionLabel && onAction ? (
        <Button variant={actionVariant} onClick={onAction} disabled={disabled}>
          {actionLabel} <ChevronRight size={16} />
        </Button>
      ) : null}
    </div>
  );
}

const modalFocusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function modalFocusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(modalFocusableSelector)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !element.closest('[hidden], [aria-hidden="true"], [inert]') &&
      element.getClientRects().length > 0,
  );
}

// Keep stacked shared modals out of each other's focus and accessibility tree.
// Preserve pre-existing attributes and restore them when the last layer closes.
const modalLayers: HTMLElement[] = [];
const modalIsolation = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();

function restoreModalIsolation(element: HTMLElement) {
  const previous = modalIsolation.get(element);
  if (!previous) return;
  element.inert = previous.inert;
  if (previous.ariaHidden === null) element.removeAttribute('aria-hidden');
  else element.setAttribute('aria-hidden', previous.ariaHidden);
  modalIsolation.delete(element);
}

function isolateModalLayer(active: HTMLElement) {
  for (const sibling of document.body.children) {
    if (!(sibling instanceof HTMLElement) || sibling === active) continue;
    if (!modalIsolation.has(sibling)) {
      modalIsolation.set(sibling, { inert: sibling.inert, ariaHidden: sibling.getAttribute('aria-hidden') });
    }
    sibling.inert = true;
    sibling.setAttribute('aria-hidden', 'true');
  }
}

export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
  dismissible = true,
  className = '',
  assistantHelp = true,
}: {
  title: string;
  assistantHelp?: boolean;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
  className?: string;
}) {
  useAppLanguage();
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const layer = dialog?.parentElement;
    if (!dialog || !layer) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalLayers.push(layer);
    restoreModalIsolation(layer);
    const focusFrame = window.requestAnimationFrame(() => {
      if (modalLayers.at(-1) !== layer) return;
      if (!dialog.contains(document.activeElement)) {
        const focusableElements = modalFocusableElements(dialog);
        const preferredFocus = dialog.querySelector<HTMLElement>(
          '[autofocus], [data-modal-initial-focus]',
        );
        (preferredFocus && focusableElements.includes(preferredFocus) ? preferredFocus : dialog)
          .focus({ preventScroll: true });
      }
      // Move focus first: aria-hidden must never enclose the active control.
      isolateModalLayer(layer);
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      const wasTop = modalLayers.at(-1) === layer;
      const index = modalLayers.indexOf(layer);
      if (index !== -1) modalLayers.splice(index, 1);
      const nextLayer = modalLayers.at(-1);
      if (nextLayer) restoreModalIsolation(nextLayer);
      else for (const element of [...modalIsolation.keys()]) restoreModalIsolation(element);
      if (wasTop && previouslyFocused?.isConnected && !previouslyFocused.closest('[inert]')) {
        previouslyFocused.focus({ preventScroll: true });
      } else if (wasTop && nextLayer) {
        nextLayer.querySelector<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
      }
      if (nextLayer) isolateModalLayer(nextLayer);
    };
  }, []);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented) return;
    // React portals bubble through their logical parent. Only trap this dialog.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (dismissible) onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusableElements = modalFocusableElements(dialog);
    if (!focusableElements.length) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;
    if (
      event.shiftKey &&
      (activeElement === firstFocusable ||
        activeElement === dialog ||
        !dialog.contains(activeElement))
    ) {
      event.preventDefault();
      lastFocusable.focus();
    } else if (
      !event.shiftKey &&
      (activeElement === lastFocusable ||
        activeElement === dialog ||
        !dialog.contains(activeElement))
    ) {
      event.preventDefault();
      firstFocusable.focus();
    }
  }

  const content = (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => dismissible && event.target === event.currentTarget && onClose()}>
      <section
        ref={dialogRef}
        className={`modal ${wide ? 'modal--wide' : ''} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        {assistantHelp && <ModalAssistantContext title={title} />}
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <div className="modal__header-actions">{assistantHelp && <AssistantHelpButton compact />}
          {dismissible ? <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label={t('Fermer « {title} »', { title })}>
            <X size={19} />
          </Button> : null}</div>
        </header>
        <div className="modal__body">{children}</div>
      </section>
    </div>
  );
  // Cover the viewport even inside a scrolling or transformed card.
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

function ModalAssistantContext({ title }: { title: string }) {
  useAssistantScreen({screen:title,actions:[]},10);
  return null;
}

const ReadOnlyFormContext = createContext(false);

export function ReadOnlyFormScope({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  return <ReadOnlyFormContext.Provider value={readOnly}>{children}</ReadOnlyFormContext.Provider>;
}

export function FormActions({
  onCancel,
  busy,
  disabled = false,
  submitLabel = 'Enregistrer',
  cancelLabel = 'Annuler',
}: {
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
  submitLabel?: string;
  cancelLabel?: string;
}) {
  const readOnly = useContext(ReadOnlyFormContext);
  useAppLanguage();
  return (
    <div className={`form-actions${readOnly ? ' form-actions--read-only' : ''}`}>
      {readOnly ? <p className="form-actions__read-only" role="status">{t('Mode lecture seule : les modifications ne peuvent pas être enregistrées.')}</p> : null}
      <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
        {t(cancelLabel)}
      </Button>
      <Button type="submit" disabled={busy || disabled || readOnly}>
        {busy ? <LoaderCircle className="spin" size={17} /> : null}
        {t(busy ? 'Enregistrement…' : submitLabel)}
      </Button>
    </div>
  );
}

const statusLabels: Record<string, string> = {
  active: 'Actif',
  planned: 'Planifié',
  in_progress: 'En cours',
  paused: 'En pause',
  completed: 'Terminé',
  closed: 'Clôturé',
  draft: 'Brouillon',
  issued: 'Émis',
  due: 'À envoyer',
  accepted: 'Accepté',
  refused: 'Refusé',
  expired: 'Expiré',
  partially_paid: 'Partiellement payée',
  partial: 'Partiellement payée',
  pending: 'En attente',
  paid: 'Payée',
  cancelled: 'Annulée',
  entered: 'Saisi',
  approved: 'Approuvé',
  locked: 'Verrouillé',
  incomplete: 'Incomplet',
  review_required: 'À contrôler',
  validated: 'Validé',
  posted: 'Comptabilisé',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  useAppLanguage();
  return <span className={`status status--${status}`}>{label ?? t(statusLabels[status] ?? status)}</span>;
}

export function DangerZone({ label, onArchive }: { label: string; onArchive: () => void }) {
  return (
    <Button variant="ghost" size="small" onClick={onArchive} aria-label={`Archiver ${label}`}>
      <Archive size={15} /> Archiver
    </Button>
  );
}

export function ErrorPanel({
  message,
  onRetry,
  title,
  reveal = false,
  fallback,
  operation,
  onReconnect,
  onReview,
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
  reveal?: boolean;
  fallback?: string;
  operation?: UserErrorOperation;
  onReconnect?: () => void;
  onReview?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useAppLanguage();
  useEffect(() => {
    if (!reveal) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const body = panel.closest<HTMLElement>('.modal__body');
      const actions = (panel.closest('form') || body)?.querySelector('.form-actions');
      if (body) {
        const modal = panel.closest<HTMLElement>('.modal');
        const scroller = body.scrollHeight > body.clientHeight + 1 ? body : modal || body;
        const frame = scroller.getBoundingClientRect();
        const header = modal?.querySelector('.modal__header');
        const top = Math.max(0, frame.top, header?.getBoundingClientRect().bottom || 0) + 8;
        const bottom = Math.min(innerHeight, frame.bottom) - 8;
        const contentBottom = Math.max(panel.getBoundingClientRect().bottom, actions?.getBoundingClientRect().bottom || 0);
        if (contentBottom > bottom) scroller.scrollTop += contentBottom - bottom;
        const visibleBottom = Math.min(bottom, actions?.getBoundingClientRect().top ?? bottom);
        if (panel.getBoundingClientRect().bottom > visibleBottom - 8)
          scroller.scrollTop += panel.getBoundingClientRect().bottom - visibleBottom + 8;
        if (panel.getBoundingClientRect().top < top)
          scroller.scrollTop += panel.getBoundingClientRect().top - top;
        return;
      }
      panel.style.scrollMarginBlockEnd = `${(actions?.getBoundingClientRect().height || 0) + 16}px`;
      panel.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [message, reveal]);
  return <ErrorGuidance panelRef={panelRef} error={message} title={title} fallback={fallback} operation={operation ?? (onRetry ? 'read' : 'mutation')} onReload={onRetry} onReconnect={onReconnect} onReview={onReview} />;
}

export function submitForm(handler: (form: FormData) => void | Promise<void>) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handler(new FormData(event.currentTarget));
  };
}
