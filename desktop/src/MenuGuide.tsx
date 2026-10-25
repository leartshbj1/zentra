import { useState } from 'react';
import { ChevronDown, CircleHelp } from 'lucide-react';
import { guideLessons } from './guideLessons';
import { t, useAppLanguage } from './language';

const lessonFor: Record<string, string> = {
  dashboard: 'overview',
  team: 'payroll',
  expenses: 'purchases',
  orders: 'recurring-documents',
};
const replacedActions: Record<string, string> = {
  'Fermez le guide, puis choisissez « Nouveau client ».': 'Choisissez « Nouveau client » en haut à droite.',
};
const storageKey = 'zentra.menu-guide.hidden.v1';

function hiddenViews(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Three plain steps under each menu's title, so a first-time user knows what to
 * do here. Folded into one quiet line by default: the screen's own content
 * comes first, the steps are one click away.
 */
export function MenuGuide({ view }: { view: string }) {
  useAppLanguage();
  const [hidden, setHidden] = useState(() => hiddenViews().includes(view));
  const lesson = guideLessons[lessonFor[view] ?? view];
  if (hidden || !lesson || view === 'dashboard' || view === 'settings') return null;
  const hide = () => {
    setHidden(true);
    try { localStorage.setItem(storageKey, JSON.stringify([...new Set([...hiddenViews(), view])])); } catch { /* Hidden for this visit. */ }
  };
  return <details className="menu-guide-line" aria-label={t('Comment ça marche')}>
    <summary><CircleHelp size={16} aria-hidden="true" /><span>{t('Comment ça marche')}</span><ChevronDown size={16} aria-hidden="true" className="menu-guide-line__chevron" /></summary>
    <ol>{lesson.actions.slice(0, 3).map((action, index) => <li key={action}><span>{index + 1}</span><p>{t(replacedActions[action] ?? action)}</p></li>)}</ol>
    <button type="button" onClick={hide}>{t('Masquer le mode d’emploi')}</button>
  </details>;
}
