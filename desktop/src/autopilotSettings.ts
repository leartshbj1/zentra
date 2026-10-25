import { useCallback, useEffect, useState } from 'react';

/**
 * How Autopilote behaves on this device for one company: paused or not, which
 * domains only show the cards it is sure of, and which exact cases it may
 * validate alone. Everything is off by default; automatic validation only covers
 * cases that are exact and undoable, and every one is journalled.
 */
export const AUTO_VALIDATION_CASES = ['qrmail', 'contact-complete'] as const;
export type AutoValidationCase = (typeof AUTO_VALIDATION_CASES)[number];
export type AutopilotBehaviour = Readonly<{
  paused: boolean;
  /** Domain labels (see autopilotKinds) where cards marked "À vérifier" stay hidden. */
  onlySure: readonly string[];
  autoValidate: readonly AutoValidationCase[];
}>;

const KEY = 'zentra.autopilot.behaviour.v1';
const EVENT = 'zentra-autopilot-behaviour';
export const DEFAULT_BEHAVIOUR: AutopilotBehaviour = Object.freeze({ paused: false, onlySure: [], autoValidate: [] });

function clean(raw: unknown): AutopilotBehaviour {
  if (!raw || typeof raw !== 'object') return DEFAULT_BEHAVIOUR;
  const value = raw as Record<string, unknown>;
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string').slice(0, 40) : [];
  return Object.freeze({
    paused: value.paused === true,
    onlySure: strings(value.onlySure),
    autoValidate: strings(value.autoValidate).filter((item): item is AutoValidationCase => (AUTO_VALIDATION_CASES as readonly string[]).includes(item)),
  });
}

export function readBehaviour(organizationId: string): AutopilotBehaviour {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, unknown>;
    return clean(all[organizationId]);
  } catch {
    return DEFAULT_BEHAVIOUR;
  }
}

export function saveBehaviour(organizationId: string, change: Partial<AutopilotBehaviour>): AutopilotBehaviour {
  const next = clean({ ...readBehaviour(organizationId), ...change });
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, unknown>;
    all[organizationId] = next;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* this device only: the default (everything validated by hand) stays */ }
  window.dispatchEvent(new Event(EVENT));
  return next;
}

/** The behaviour of this company, refreshed when another screen changes it. */
export function useAutopilotBehaviour(organizationId: string | null | undefined) {
  const [value, setValue] = useState<AutopilotBehaviour>(() => organizationId ? readBehaviour(organizationId) : DEFAULT_BEHAVIOUR);
  useEffect(() => {
    if (!organizationId) { setValue(DEFAULT_BEHAVIOUR); return; }
    const refresh = () => setValue(readBehaviour(organizationId));
    refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, [organizationId]);
  const update = useCallback((change: Partial<AutopilotBehaviour>) => { if (organizationId) setValue(saveBehaviour(organizationId, change)); }, [organizationId]);
  return [value, update] as const;
}

/** Cards a person still sees: none while paused; in "only sure" domains, not those marked to check. */
export function visibleCards<T extends Readonly<{ key: string }>>(cards: readonly T[], behaviour: AutopilotBehaviour,
  kindOf: (key: string) => string | null, confidenceOf: (card: T) => 'high' | 'check' | null): T[] {
  if (behaviour.paused) return [];
  return cards.filter(card => {
    const kind = kindOf(card.key);
    return !(kind && behaviour.onlySure.includes(kind) && confidenceOf(card) === 'check');
  });
}
