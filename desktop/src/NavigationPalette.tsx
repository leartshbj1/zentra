import { useId, useState } from 'react';
import { ArrowRight, Search, type LucideIcon } from 'lucide-react';
import { Modal } from './ui';

export interface NavigationDestination<T extends string = string> {
  id: T;
  label: string;
  description: string;
  icon: LucideIcon;
}

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');

/** A local module switcher: no network requests or customer data indexing. */
export function NavigationPalette<T extends string>({ destinations, onSelect, onClose }: {
  destinations: NavigationDestination<T>[];
  onSelect: (id: T) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const resultId = useId();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const normalizedQuery = terms.join(' ');
  const rank = (item: NavigationDestination<T>) => {
    const label = normalize(item.label);
    return label === normalizedQuery ? 0 : label.startsWith(normalizedQuery) ? 1 : terms.every((term) => label.includes(term)) ? 2 : 3;
  };
  const results = destinations.filter((item) => terms.every((term) => normalize(`${item.label} ${item.description}`).includes(term))).sort((left, right) => rank(left) - rank(right));

  return (
    <Modal title="Aller à…" description="Retrouvez un écran de votre espace de travail." onClose={onClose}>
      <div className="navigation-palette">
        <label className="navigation-palette__search">
          <Search size={20} aria-hidden="true" />
          <input type="search" aria-label="Rechercher un écran" placeholder="Projets, factures, banque…" data-modal-initial-focus value={query} onChange={(event) => setQuery(event.target.value)} aria-controls={resultId} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && results.length) { event.preventDefault(); onSelect(results[0].id); }
            if (event.key === 'ArrowDown') { event.preventDefault(); document.getElementById(resultId)?.querySelector('button')?.focus(); }
          }} />
        </label>
        <p className="navigation-palette__count" role="status">{results.length ? `${results.length} écran${results.length > 1 ? 's' : ''}` : 'Aucun écran trouvé. Essayez un autre mot.'}</p>
        <div id={resultId} className="navigation-palette__results" onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}>
          {results.map(({ id, label, description, icon: Icon }) => (
            <button type="button" key={id} onClick={() => onSelect(id)}>
              <Icon size={20} aria-hidden="true" />
              <span><strong>{label}</strong><small>{description}</small></span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
