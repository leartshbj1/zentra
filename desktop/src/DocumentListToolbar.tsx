import { useId, useRef, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useCompactLayout } from './MobileDetails';
import { t } from './language';

export function DocumentListToolbar({ children, count, orderLabel, filtered, search, tools }: {
  children: ReactNode;
  count: string;
  orderLabel: string;
  filtered: boolean;
  search?: { value: string; onChange: (value:string)=>void; label:string };
  tools?: ReactNode;
}) {
  const id = useId();
  const compact=useCompactLayout();
  const toggle=useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const close=()=>{setExpanded(false);toggle.current?.focus();};
  return <div className="document-list-tools" data-expanded={expanded} onKeyDown={event=>{if(compact&&expanded&&event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
    <div className="document-list-tools__compact">
      <div><output>{count}</output><small>{t(orderLabel)}</small></div>
      <button ref={toggle} type="button" aria-label={t(search ? 'Rechercher et filtrer' : 'Filtrer et trier')} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
        <SlidersHorizontal size={17} aria-hidden="true" /><span>{t(filtered || search?.value ? 'Filtres actifs' : 'Filtres')}</span>
      </button>
    </div>
    <div id={id} className="sales-list-toolbar">
      {compact&&search&&<label className="document-list-search"><span>{t(search.label)}</span><input type="search" value={search.value} onChange={event=>search.onChange(event.target.value)} aria-label={t(search.label)}/></label>}
      {children}
      {compact&&search?.value&&<button type="button" className="button button--secondary document-search-clear" onClick={()=>search.onChange('')}>{t('Effacer la recherche')}</button>}
      <output className="document-list-tools__count">{count}</output>
      {compact&&tools}
      {compact&&<button type="button" className="button button--secondary document-filters-done" onClick={close}>{t('Afficher les résultats')}</button>}
    </div>
  </div>;
}
