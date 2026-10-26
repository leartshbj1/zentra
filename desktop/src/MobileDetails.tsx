import { Children, Fragment, cloneElement, isValidElement, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
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
  const menu = useRef<HTMLDetailsElement>(null);
  // Placed against the window so a table panel never clips it; opens upwards near the bottom.
  const [place, setPlace] = useState<CSSProperties>();
  useEffect(() => {
    const close = (event: Event) => {
      const element = menu.current;
      if (element?.open && !element.contains(event.target as Node)) element.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const element = menu.current;
      if (event.key === 'Escape' && element?.open) { element.open = false; element.querySelector('summary')?.focus(); }
    };
    const scrolled = (event: Event) => {
      const element = menu.current;
      if (element?.open && !element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', scrolled, true);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); window.removeEventListener('scroll', scrolled, true); };
  }, []);
  const toggled = () => {
    const element = menu.current;
    if (!element?.open) return;
    const anchor = element.querySelector('summary')!.getBoundingClientRect();
    const height = element.querySelector<HTMLElement>('.document-actions__menu')?.offsetHeight ?? 0;
    const below = window.innerHeight - anchor.bottom;
    const right = Math.max(8, window.innerWidth - anchor.right);
    setPlace(below < height + 16 && anchor.top > below
      ? { position: 'fixed', right, bottom: window.innerHeight - anchor.top + 6, top: 'auto' }
      : { position: 'fixed', right, top: anchor.bottom + 6 });
  };
  return <details ref={menu} className="document-actions__more" onToggle={toggled}>
    <summary title={t('Autres actions')} aria-label={t('Autres actions')}><MoreHorizontal size={18} aria-hidden="true" /></summary>
    {/* An action closes the menu; its own dialog or result then takes over. */}
    <div className="document-actions__menu" style={place} role="group" aria-label={t('Actions du document')} onClick={event => { if ((event.target as HTMLElement).closest('button') && menu.current) menu.current.open = false; }}>
      {children}
    </div>
  </details>;
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
