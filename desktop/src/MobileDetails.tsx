import { Children, Fragment, cloneElement, isValidElement, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
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
  if (!compact) return <div className="document-actions">{children}</div>;
  // Action titles were previously just tooltips. They become visible labels on
  // mobile, so localize them, including buttons inside conditional fragments.
  const labelAction = (node: ReactNode): ReactNode => {
    if (!isValidElement<{ title?: string; children?: ReactNode }>(node)) return node;
    if (node.type === Fragment) return cloneElement(node, {}, Children.map(node.props.children, labelAction));
    return node.props.title ? cloneElement(node, { title: t(node.props.title) }) : node;
  };
  const actions = Children.toArray(children).map(labelAction);
  const isPreview = (node: ReactNode) => isValidElement<{ className?: string }>(node)
    && node.props.className?.split(' ').includes('document-preview-action');
  return <div className="document-actions document-actions--compact">
    {actions.filter(isPreview)}
    <MobileDetails title="Actions du document">{metadata}{actions.filter(node => !isPreview(node))}</MobileDetails>
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
