import { useState } from 'react';
import { X } from 'lucide-react';
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

/** Three plain steps under each menu's title, so a first-time user knows what to do here. */
export function MenuGuide({ view }: { view: string }) {
  useAppLanguage();
  const [hidden, setHidden] = useState(() => hiddenViews().includes(view));
  const lesson = guideLessons[lessonFor[view] ?? view];
  if (hidden || !lesson || view === 'dashboard' || view === 'settings') return null;
  const hide = () => {
    setHidden(true);
    try { localStorage.setItem(storageKey, JSON.stringify([...new Set([...hiddenViews(), view])])); } catch { /* Hidden for this visit. */ }
  };
  return <section className="menu-guide" aria-label={t('Comment ça marche')}>
    <header>
      <h2>{t('Comment ça marche')}</h2>
      <button type="button" onClick={hide} aria-label={t('Masquer le mode d’emploi')}><X size={16} aria-hidden="true" /><span>{t('Compris')}</span></button>
    </header>
    <ol>{lesson.actions.slice(0, 3).map((action, index) => <li key={action}><span>{index + 1}</span><p>{t(replacedActions[action] ?? action)}</p></li>)}</ol>
  </section>;
}
