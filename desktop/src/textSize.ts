import { useSyncExternalStore } from 'react';
import './text-size.css';

const key = 'zentra.text-size.v1';
export const textSizes = [100, 125, 150, 175, 200] as const;
export type TextSize = typeof textSizes[number];
export function normalizeTextSize(value: unknown): TextSize {
  const number = Number(value);
  return textSizes.includes(number as TextSize) ? number as TextSize : 100;
}
let preference: TextSize = 100;
try { preference = normalizeTextSize(localStorage.getItem(key)); } catch { /* Session only. */ }
const listeners = new Set<() => void>();
function apply() {
  const root = document.documentElement;
  root.dataset.appTextSize = String(preference);
  root.style.setProperty('--zentra-ui-text-scale', String(preference / 100));
  listeners.forEach(notify => notify());
}
export function setTextSize(value: TextSize): boolean {
  if (!textSizes.includes(value)) return false;
  preference = value;
  let saved = true;
  try { localStorage.setItem(key, String(value)); } catch { saved = false; }
  apply();
  return saved;
}
export function useTextSize() {
  return useSyncExternalStore(notify => { listeners.add(notify); return () => { listeners.delete(notify); }; }, () => preference);
}
window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) { preference = normalizeTextSize(event.newValue); apply(); }
});
apply();
