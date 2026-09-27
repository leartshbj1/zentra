import { t } from './language';
import { useAppLanguage } from './language';
import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Search, X, type LucideIcon } from 'lucide-react';
import { matchesSettingsSearch, settingsGroups, settingsNavigationSession, settingsScopes, settingsSearchTerms } from './settingsNavigation';
import './settings-navigation.css';

type CategoryProps = {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
  lazy?: boolean;
  groupName?: string;
  initiallyOpen?: boolean;
  onOpenChange?: (id: string, open: boolean) => void;
};

const CategoryVisited = createContext(true);

/** Keep settings targets available, while expensive panels wait for their category's first visit. */
export function SettingsAfterOpen({ children }: { children: ReactNode }) {
  return useContext(CategoryVisited) ? children : null;
}

function openSettingsCategory(detail: HTMLDetailsElement) {
  const browser = detail.closest<HTMLElement>('.settings-browser');
  // Also enforce one page on older WebViews without exclusive details support.
  browser?.querySelectorAll<HTMLDetailsElement>('.settings-category[open]').forEach(other => {
    if (other !== detail) other.open = false;
  });
  if (browser) browser.dataset.settingsOpen = 'true';
  detail.open = true;
}

/** Native details retain drafts and keep links from setup/update screens working. */
export function SettingsBrowser({ children, initialCategory, hasDraft = false }: { children: ReactNode; initialCategory?: string | null; hasDraft?: boolean }) {
  useAppLanguage();
  const root = useRef<HTMLDivElement>(null);
  const groupName = useId();
  const categories = Children.toArray(children).filter((child): child is ReactElement<CategoryProps> => isValidElement<CategoryProps>(child));
  const [initial] = useState(() => {
    const requested = initialCategory !== undefined ? initialCategory : settingsNavigationSession.category;
    if (requested === null || categories.some(child => child.props.id === requested)) return requested;
    return window.matchMedia('(min-width: 1101px)').matches ? categories[0]?.props.id : null;
  });
  const [active, setActive] = useState<string | null>(initial ?? null);
  const [query, setQuery] = useState(settingsNavigationSession.query);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { settingsNavigationSession.category = active; }, [active]);
  useEffect(() => { settingsNavigationSession.query = query; }, [query]);
  const matches = categories.filter(({ props: { id, title, description } }) => matchesSettingsSearch(query, [
    title, t(title), description, t(description), settingsSearchTerms[id] || '', t(settingsSearchTerms[id] || ''),
  ]));
  const groups = settingsGroups.map(group => ({ ...group, categories: group.ids.flatMap(id => matches.filter(child => child.props.id === id)) }));
  const knownIds: readonly string[] = settingsGroups.flatMap(group => [...group.ids]);
  const other = matches.filter(child => !knownIds.includes(child.props.id));

  function openCategory(id: string) {
    const detail = root.current?.querySelector<HTMLDetailsElement>(`[data-settings-id="${id}"]`);
    if (!detail) return;
    openSettingsCategory(detail);
    setActive(id);
    detail.querySelector('summary')?.focus({ preventScroll: true });
    // A previous category can leave the page far down. Reveal the new heading
    // on desktop too, accounting for the sticky application toolbar.
    if (root.current) {
      root.current.style.scrollMarginTop = `${(document.querySelector('.topbar')?.getBoundingClientRect().height || 0) + 16}px`;
      root.current.scrollIntoView({ block: 'start' });
    }
  }

  function goBack() {
    const selected = root.current?.querySelector<HTMLElement>('.settings-category[open]')?.dataset.settingsId || active;
    root.current?.querySelectorAll<HTMLDetailsElement>('.settings-category[open]').forEach(detail => { detail.open = false; });
    if (root.current) delete root.current.dataset.settingsOpen;
    setActive(null);
    const previous = root.current?.querySelector<HTMLButtonElement>(`[data-settings-link="${selected}"]`);
    if (previous) previous.focus({ preventScroll: true });
    else {
      setQuery('');
      requestAnimationFrame(() => {
        root.current?.querySelector<HTMLButtonElement>(`[data-settings-link="${selected}"]`)?.focus({ preventScroll: true });
      });
    }
    root.current?.scrollIntoView({ block: 'start' });
  }

  function link({ props: { id, title, description, icon: Icon } }: ReactElement<CategoryProps>) {
    return <button
        key={id} type="button" data-settings-link={id} aria-current={active === id ? 'true' : undefined}
        aria-controls={`${groupName}-${id}`} onClick={() => openCategory(id)}
      >
        <span className="settings-browser__icon"><Icon size={19} aria-hidden="true" /></span>
        <span><strong>{t(title)}</strong><small>{t(description)}</small></span><ChevronRight size={16} aria-hidden="true" />
      </button>;
  }

  return <div ref={root} className="settings-browser settings-browser--guided" data-settings-open={active ? 'true' : undefined} data-company-draft={hasDraft || undefined}>
    <nav className="settings-browser__navigation" data-settings-navigation aria-label={t("Rubriques des paramètres")} data-searching={query.trim() ? 'true' : undefined}>
      <div className="settings-browser__search">
        <Search size={18} aria-hidden="true" />
        <input ref={search} type="search" value={query} aria-label={t('Rechercher un réglage')} placeholder={t('Rechercher un réglage')} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
          if (event.key === 'Enter' && matches.length === 1) { event.preventDefault(); openCategory(matches[0].props.id); }
        }} />
        {query && <button type="button" aria-label={t('Effacer la recherche des paramètres')} onClick={() => { setQuery(''); search.current?.focus(); }}><X size={18} aria-hidden="true" /></button>}
      </div>
      {query.trim() && <p className="settings-browser__count" role="status">{matches.length === 1 ? t('1 rubrique trouvée') : t('{count} rubriques trouvées', { count: String(matches.length) })}</p>}
      {groups.filter(group => group.categories.length).map(group => <section className="settings-browser__group" key={group.title} aria-labelledby={`${groupName}-${group.ids[0]}-group`}>
        <h2 id={`${groupName}-${group.ids[0]}-group`}>{t(group.title)}</h2>
        {group.categories.map(link)}
      </section>)}
      {other.map(link)}
      {!matches.length && <div className="settings-browser__no-results"><strong>{t('Aucun réglage trouvé')}</strong><p>{t('Essayez un autre mot, comme logo, assurance ou sauvegarde.')}</p></div>}
    </nav>
    <div className="settings-browser__detail">
      <button type="button" className="settings-browser__back" onClick={goBack}><ChevronLeft size={19} aria-hidden="true" />{t(" Tous les paramètres")}</button>
      <div className="settings-categories">{categories.map(child => cloneElement(child, {
        groupName,
        initiallyOpen: child.props.id === initial,
        onOpenChange: (id, open) => setActive(current => open ? id : current === id ? null : current),
      }))}</div>
      <p className="settings-browser__empty">{t("Choisissez une rubrique pour retrouver ses réglages.")}</p>
    </div>
  </div>;
}

export function SettingsCategory({ id, title, description, icon: Icon, children, lazy = false, groupName, initiallyOpen = false, onOpenChange }: CategoryProps) {
  const [visited, setVisited] = useState(initiallyOpen);
  return <details id={groupName ? `${groupName}-${id}` : id} data-settings-id={id} className="settings-category" name={groupName || 'settings-categories'} open={initiallyOpen || undefined} onToggle={event => {
    const open = event.currentTarget.open;
    if (open) setVisited(true);
    onOpenChange?.(id, open);
  }}>
    <summary><Icon size={22} aria-hidden="true" /><span><strong role="heading" aria-level={2}>{t(title)}</strong><small>{t(description)}</small>{settingsScopes[id] && <span className="settings-category__scope">{t(settingsScopes[id])}</span>}</span><ChevronDown size={18} aria-hidden="true" /></summary>
    <div className="settings-category__content settings-layout"><CategoryVisited.Provider value={visited || initiallyOpen}>{!lazy || visited ? children : null}</CategoryVisited.Provider></div>
  </details>;
}

export function revealSettingsTarget(target: HTMLElement | null) {
  let parent = target?.parentElement;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) {
      if (parent.classList.contains('settings-category')) openSettingsCategory(parent);
      else parent.open = true;
    }
    parent = parent.parentElement;
  }
}
