import type { ButtonHTMLAttributes, FormEvent, ReactNode } from 'react';
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
  required,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`field ${wide ? 'field--wide' : ''}`}>
      <span className="field__label">
        {label} {required ? <em>obligatoire</em> : null}
      </span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
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
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header">
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Fermer">
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
  submitLabel = 'Enregistrer',
}: {
  onCancel: () => void;
  busy: boolean;
  submitLabel?: string;
}) {
  return (
    <div className="form-actions">
      <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
        Annuler
      </Button>
      <Button type="submit" disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={17} /> : null}
        {busy ? 'Enregistrement…' : submitLabel}
      </Button>
    </div>
  );
}

const statusLabels: Record<string, string> = {
  planned: 'Planifié',
  in_progress: 'En cours',
  paused: 'En pause',
  completed: 'Terminé',
  closed: 'Clôturé',
  draft: 'Brouillon',
  issued: 'Émis',
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
  validated: 'Validé',
  posted: 'Comptabilisé',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status status--${status}`}>{statusLabels[status] ?? status}</span>;
}

export function DangerZone({ label, onArchive }: { label: string; onArchive: () => void }) {
  return (
    <Button variant="ghost" size="small" onClick={onArchive} aria-label={`Archiver ${label}`}>
      <Archive size={15} /> Archiver
    </Button>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-panel" role="alert">
      <AlertTriangle size={22} />
      <div>
        <strong>Action impossible</strong>
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
