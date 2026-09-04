import type { ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';

export function SettingsCategory({ title, description, icon: Icon, children }: {
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return <details className="settings-category" name="settings-categories">
    <summary><Icon size={22} aria-hidden="true" /><span><strong>{title}</strong><small>{description}</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
    <div className="settings-category__content settings-layout">{children}</div>
  </details>;
}

export function revealSettingsTarget(target: HTMLElement | null) {
  let parent = target?.parentElement;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
}
