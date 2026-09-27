import { createContext, useContext, useId, useLayoutEffect } from 'react';
import { t, useAppLanguage } from './language';
import { MessageCircle } from 'lucide-react';
import type { AssistantFacts } from './assistantGuide';

export type AssistantAction = { label: string; run: () => void };
export type AssistantScreen = { screen: string; facts?: AssistantFacts; actions?: AssistantAction[]; scope?: string };
export const AssistantContext = createContext<null | {
  open: () => void;
  register: (id: string, priority: number, context: AssistantScreen) => void;
  remove: (id: string) => void;
  setLauncherHost: (host: HTMLElement | null) => void;
}>(null);

/** The workspace reserves space for help instead of covering the last row or action. */
export function AssistantLauncherSlot() {
  const assistant = useContext(AssistantContext);
  return assistant ? <span className="assistant-launcher-slot" ref={assistant.setLauncherHost} /> : null;
}

export function useAssistantScreen(context: AssistantScreen, priority = 0) {
  const assistant = useContext(AssistantContext);
  const id = useId();
  // Register current values after every render without triggering a parent render.
  useLayoutEffect(() => { assistant?.register(id, priority, context); });
  useLayoutEffect(() => () => assistant?.remove(id), [assistant, id]);
}

export function AssistantHelpButton({ compact = false }: { compact?: boolean }) {
  useAppLanguage();
  const assistant = useContext(AssistantContext);
  if (!assistant) return null;
  return <button type="button" className={`assistant-help ${compact ? 'assistant-help--compact' : ''}`} onClick={assistant.open} aria-label={t('Demander à l’assistant Zentra')} title={t('Demander à l’assistant Zentra')}><MessageCircle size={19} aria-hidden="true" />{!compact && <span>{t('Assistant')}</span>}</button>;
}
