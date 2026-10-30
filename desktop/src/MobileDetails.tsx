import { Children, Fragment, cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { t, useAppLanguage } from './language';

const compactQuery = '(max-width: 860px)';
function subscribe(callback: () => void) {
  const media = window.matchMedia(compactQuery);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

/** Keep every existing action and its permissions, with preview always within reach. */
export function MobileDocumentActions({ children, metadata }: { children: ReactNode; metadata?: ReactNode }) {
  useAppLanguage();
  const compact = useCompactLayout();
  // Action titles were previously just tooltips. They become visible labels in
  // the menus, so localize them, including buttons inside conditional fragments.
  const labelAction = (node: ReactNode): ReactNode => {
    if (!isValidElement<{ title?: string; children?: ReactNode }>(node)) return node;
    if (node.type === Fragment) return cloneElement(node, {}, Children.map(node.props.children, labelAction));
    return node.props.title ? cloneElement(node, { title: t(node.props.title) }) : node;
  };
  const actions = Children.toArray(children).map(labelAction);
  const isPreview = (node: ReactNode) => isValidElement<{ className?: string }>(node)
    && node.props.className?.split(' ').includes('document-preview-action');
  if (!compact) {
    // Desktop: the preview stays visible, every other action sits behind one « … » button.
    const rest = actions.filter(node => !isPreview(node) && hasContent(node));
    return <div className="document-actions document-actions--menu">
      {actions.filter(isPreview)}
      {rest.length ? <DocumentMoreMenu>{rest}</DocumentMoreMenu> : null}
    </div>;
  }
  return <div className="document-actions document-actions--compact">
    {actions.filter(isPreview)}
    <MobileDetails title="Actions du document">{metadata}{actions.filter(node => !isPreview(node))}</MobileDetails>
  </div>;
}
function hasContent(node: ReactNode): boolean {
  if (node === null || node === undefined || typeof node === 'boolean' || node === '') return false;
  if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) return Children.toArray(node.props.children).some(hasContent);
  return true;
}

function DocumentMoreMenu({ children }: { children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // The panel lives at the top of the app (portal), placed against the window from its button:
  // animated cards, table panels and status badges can then neither move, clip nor cover it.
  const [place, setPlace] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const { offsetHeight: height, offsetWidth: width } = panel.current;
    const below = window.innerHeight - anchor.bottom;
    const up = below < height + 16 && anchor.top > below;
    const left = Math.min(Math.max(8, anchor.right - width), window.innerWidth - width - 8);
    setPlace(up
      ? { position: 'fixed', left, top: 'auto', bottom: window.innerHeight - anchor.top + 6 }
      : { position: 'fixed', left, top: anchor.bottom + 6, bottom: 'auto' });
    panel.current.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => !!target && (trigger.current?.contains(target as Node) || panel.current?.contains(target as Node));
    const close = (event: Event) => { if (!inside(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    const away = () => setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', close, true); window.removeEventListener('resize', away);
    };
  }, [open]);
  useEffect(() => { if (!open) setPlace(current => ({ ...current, visibility: 'hidden' })); }, [open]);
  const host = typeof document === 'undefined' ? null : document.querySelector('.desktop-app') ?? document.body;
  const menu = <div ref={panel} className="document-actions__menu" style={place} hidden={!open} role="group" aria-label={t('Actions du document')}
    // An action closes the menu; its own dialog or result then takes over.
    onClick={event => { if ((event.target as HTMLElement).closest('button')) setOpen(false); }}>
    {children}
  </div>;
  return <div className="document-actions__more">
    <button ref={trigger} type="button" className="document-actions__trigger" aria-haspopup="true" aria-expanded={open}
      title={t('Autres actions')} aria-label={t('Autres actions')} onClick={() => setOpen(value => !value)}>
      <MoreHorizontal size={18} aria-hidden="true" />
    </button>
    {host ? createPortal(menu, host) : menu}
  </div>;
}

export function useCompactLayout() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(compactQuery).matches, () => false);
}

/** Secondary information stays one tap away on phones. Desktop keeps its original markup. */
export function MobileDetails({ title, children, className = '', badge }: {
  title: string; children: ReactNode; className?: string; badge?: string | number;
}) {
  useAppLanguage();
  const compact = useCompactLayout();
  if (!compact) return <>{children}</>;
  return <details className={`mobile-details ${className}`}>
    <summary><span>{t(title)}</span>{badge !== undefined && <small>{badge}</small>}<ChevronDown size={17} aria-hidden="true" /></summary>
    <div className="mobile-details__content">{children}</div>
  </details>;
}
