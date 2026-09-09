import { useId, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';

export function DocumentListToolbar({ children, count, orderLabel, filtered }: {
  children: ReactNode;
  count: string;
  orderLabel: string;
  filtered: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return <div className="document-list-tools" data-expanded={expanded}>
    <div className="document-list-tools__compact">
      <div><output>{count}</output><small>{orderLabel}</small></div>
      <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
        <SlidersHorizontal size={17} aria-hidden="true" /><span>{filtered ? 'Filtres actifs' : 'Filtrer et trier'}</span>
      </button>
    </div>
    <div id={id} className="sales-list-toolbar">{children}<output className="document-list-tools__count">{count}</output></div>
  </div>;
}
