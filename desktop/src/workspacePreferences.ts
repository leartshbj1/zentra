import { useSyncExternalStore } from 'react';

export const navigationIds = ['dashboard', 'agenda', 'projects', 'clients', 'catalog', 'quotes', 'invoices', 'reminders', 'time', 'team', 'expenses', 'bank', 'reports', 'accounting', 'automation', 'settings'] as const;
export type ShortcutId = typeof navigationIds[number];
export const quickActionIds = ['client', 'project', 'quote', 'invoice', 'purchase', 'employee', 'agenda', 'clients'] as const;
export type QuickActionId = typeof quickActionIds[number];
export type WorkspacePreferences = { version: 1; shortcuts: ShortcutId[]; actions: QuickActionId[] };
export const workspacePreferencesKey = 'zentra.workspace.preferences.v1';
export const defaultPreferences: WorkspacePreferences = { version: 1, shortcuts: ['dashboard', 'projects', 'quotes', 'agenda'], actions: ['client', 'project', 'quote', 'purchase'] };

function four<T extends string>(input: unknown, allowed: readonly T[], fallback: readonly T[]): T[] {
  const values = Array.isArray(input) ? input.filter((id): id is T => typeof id === 'string' && allowed.includes(id as T)) : [];
  return [...new Set([...values, ...fallback])].slice(0, 4);
}
export function parseWorkspacePreferences(raw: string | null): WorkspacePreferences {
  try {
    const data = raw ? JSON.parse(raw) : null;
    if (data?.version === 1) return { version: 1, shortcuts: four(data.shortcuts, navigationIds, defaultPreferences.shortcuts), actions: four(data.actions, quickActionIds, defaultPreferences.actions) };
  } catch { /* A damaged preference never blocks the workspace. */ }
  return { ...defaultPreferences, shortcuts: [...defaultPreferences.shortcuts], actions: [...defaultPreferences.actions] };
}
/** Entitlements affect the rendered shortcuts, never erase the user's saved choice. */
export function availableShortcuts(preferences: WorkspacePreferences, automationActive: boolean): ShortcutId[] {
  return four(preferences.shortcuts.filter(id => id !== 'automation' || automationActive), navigationIds, defaultPreferences.shortcuts);
}
export function selectedShortcut(view: string, items: readonly ShortcutId[]): ShortcutId | 'menu' {
  if (items.includes(view as ShortcutId)) return view as ShortcutId;
  return ['orders', 'invoices'].includes(view) && items.includes('quotes') ? 'quotes' : 'menu';
}
/** Choosing an already visible item swaps positions; a shortcut can never appear twice. */
export function replaceShortcut<T extends string>(items: readonly T[], index: number, id: T): T[] {
  if (index < 0 || index >= items.length) return [...items];
  const result = [...items], previous = result.indexOf(id);
  if (previous >= 0) result[previous] = result[index];
  result[index] = id;
  return result;
}
let cached: WorkspacePreferences | undefined;
const listeners = new Set<() => void>();
function read() {
  if (!cached) { try { cached = parseWorkspacePreferences(localStorage.getItem(workspacePreferencesKey)); } catch { cached = parseWorkspacePreferences(null); } }
  return cached;
}
function notify() { listeners.forEach(listener => listener()); }
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === workspacePreferencesKey || event.key === null) { cached = undefined; read(); notify(); }
});
export function saveWorkspacePreferences(value: WorkspacePreferences): boolean {
  cached = parseWorkspacePreferences(JSON.stringify(value));
  let persisted = true;
  try { localStorage.setItem(workspacePreferencesKey, JSON.stringify(cached)); } catch { persisted = false; }
  notify();
  return persisted;
}
export function useWorkspacePreferences() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, read, read);
}
