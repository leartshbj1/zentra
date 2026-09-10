import type { CSSProperties, ReactNode } from 'react';

export function SectionTabs<T extends string>({ items, value, onChange, label }: {
  items: Array<[T, string, ReactNode]>; value: T; onChange: (value: T) => void; label: string;
}) {
  const columns = Math.max(1, items.length);
  const compactColumns = Math.ceil(columns / Math.ceil(columns / 3));
  return <div className="section-navigation" style={{ '--section-columns': columns, '--section-compact-columns': compactColumns } as CSSProperties}>
    <label className="section-navigation__mobile"><span>{label}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>{items.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
    <div className="tab-strip section-navigation__tabs" role="tablist" aria-label={label}>
      {items.map(([id, title, icon], index) => <button type="button" role="tab" key={id} aria-selected={value === id} tabIndex={value === id ? 0 : -1} className={value === id ? 'is-active' : ''} onClick={() => onChange(id)} onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); onChange(items[next][0]);
        const button = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
        button?.focus(); button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }}><span className="section-navigation__icon" aria-hidden="true">{icon}</span><span className="section-navigation__title">{title}</span></button>)}
    </div>
  </div>;
}
