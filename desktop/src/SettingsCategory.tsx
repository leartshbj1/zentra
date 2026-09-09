import { Children, cloneElement, isValidElement, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';

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
export function SettingsBrowser({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const groupName = useId();
  const categories = Children.toArray(children).filter((child): child is ReactElement<CategoryProps> => isValidElement<CategoryProps>(child));
  const [initial] = useState(() => window.matchMedia('(min-width: 1101px)').matches ? categories[0]?.props.id : null);
  const [active, setActive] = useState<string | null>(initial ?? null);

  function openCategory(id: string) {
    const detail = root.current?.querySelector<HTMLDetailsElement>(`[data-settings-id="${id}"]`);
    if (!detail) return;
    openSettingsCategory(detail);
    if (window.matchMedia('(max-width: 1100px)').matches) {
      detail.querySelector('summary')?.focus({ preventScroll: true });
      root.current?.scrollIntoView({ block: 'start' });
    }
  }

  function goBack() {
    const selected = root.current?.querySelector<HTMLElement>('.settings-category[open]')?.dataset.settingsId || active;
    root.current?.querySelectorAll<HTMLDetailsElement>('.settings-category[open]').forEach(detail => { detail.open = false; });
    if (root.current) delete root.current.dataset.settingsOpen;
    const previous = root.current?.querySelector<HTMLButtonElement>(`[data-settings-link="${selected}"]`);
    previous?.focus({ preventScroll: true });
    root.current?.scrollIntoView({ block: 'start' });
  }

  return <div ref={root} className="settings-browser" data-settings-open={active ? 'true' : undefined}>
    <nav className="settings-browser__navigation" aria-label="Rubriques des paramètres">
      {categories.map(({ props: { id, title, description, icon: Icon } }) => <button
        key={id} type="button" data-settings-link={id} aria-current={active === id ? 'true' : undefined}
        aria-controls={`${groupName}-${id}`} onClick={() => openCategory(id)}
      >
        <span className="settings-browser__icon"><Icon size={19} aria-hidden="true" /></span>
        <span><strong>{title}</strong><small>{description}</small></span><ChevronRight size={16} aria-hidden="true" />
      </button>)}
    </nav>
    <div className="settings-browser__detail">
      <button type="button" className="settings-browser__back" onClick={goBack}><ChevronLeft size={19} aria-hidden="true" /> Tous les paramètres</button>
      <div className="settings-categories">{categories.map(child => cloneElement(child, {
        groupName,
        initiallyOpen: child.props.id === initial,
        onOpenChange: (id, open) => setActive(current => open ? id : current === id ? null : current),
      }))}</div>
      <p className="settings-browser__empty">Choisissez une rubrique pour retrouver ses réglages.</p>
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
    <summary><Icon size={22} aria-hidden="true" /><span><strong>{title}</strong><small>{description}</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
    <div className="settings-category__content settings-layout">{!lazy || visited ? children : null}</div>
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
