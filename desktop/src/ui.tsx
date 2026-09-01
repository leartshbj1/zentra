import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { AlertTriangle, Archive, ChevronRight, Inbox, LoaderCircle, X } from 'lucide-react';

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
        {label} {required ? <em>obligatoire</em> : null}
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
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
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
  onAction,
  disabled,
}: {
  icon?: ReactNode;
  title: string;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon ?? <Inbox size={24} />}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {actionLabel && onAction ? (
        <Button onClick={onAction} disabled={disabled}>
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

export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(document.activeElement)) return;

      const focusableElements = modalFocusableElements(dialog);
      const preferredFocus = dialog.querySelector<HTMLElement>(
        '[autofocus], [data-modal-initial-focus]',
      );
      if (preferredFocus && focusableElements.includes(preferredFocus)) {
        preferredFocus.focus({ preventScroll: true });
        return;
      }
      dialog.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
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

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        ref={dialogRef}
        className={`modal ${wide ? 'modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label={`Fermer « ${title} »`}>
            <X size={19} />
          </Button>
        </header>
        <div className="modal__body">{children}</div>
      </section>
    </div>
  );
}

export function FormActions({
  onCancel,
  busy,
  disabled = false,
  submitLabel = 'Enregistrer',
}: {
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
  submitLabel?: string;
}) {
  return (
    <div className="form-actions">
      <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
        Annuler
      </Button>
      <Button type="submit" disabled={busy || disabled}>
        {busy ? <LoaderCircle className="spin" size={17} /> : null}
        {busy ? 'Enregistrement…' : submitLabel}
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
  return <span className={`status status--${status}`}>{label ?? statusLabels[status] ?? status}</span>;
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
  title = 'Action impossible',
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="error-panel" role="alert">
      <AlertTriangle size={22} />
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <Button variant="secondary" size="small" onClick={onRetry}>
          Réessayer
        </Button>
      ) : null}
    </div>
  );
}

export function submitForm(handler: (form: FormData) => void | Promise<void>) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handler(new FormData(event.currentTarget));
  };
}
