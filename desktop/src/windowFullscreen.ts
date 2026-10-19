import { isTauri } from '@tauri-apps/api/core';
import { diagnosticInvoke as invoke } from './diagnostics';

let fullscreen = false;
let pending = false;
const openDialog = () => !!document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')
  || !!document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');

/** Which key, if any, changes full screen: F11 switches, Échap leaves it when nothing else is open. */
export function fullscreenAction(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented' | 'repeat'>,
  isFullscreen: boolean, dialogOpen: boolean): 'toggle' | 'exit' | 'sync' | null {
  if (event.defaultPrevented || event.repeat) return null;
  if (event.key === 'F11' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) return 'toggle';
  if (event.key === 'Escape' && !dialogOpen) return isFullscreen ? 'exit' : 'sync';
  return null;
}

/** Listens for F11 and Échap on the desktop app; the native window does the switch. */
export function installFullscreenShortcuts(): () => void {
  if (!isTauri()) return () => {};
  const onKey = (event: KeyboardEvent) => {
    const mode = fullscreenAction(event, fullscreen, openDialog());
    if (!mode || pending) return;
    if (mode === 'toggle') event.preventDefault();
    pending = true;
    // "sync": the window may be full screen through the system button; leaving is harmless otherwise.
    void invoke<boolean>('set_window_fullscreen', { mode: mode === 'sync' ? 'exit' : mode })
      .then(value => { fullscreen = value === true; })
      .catch(() => { /* The window stays as it is. */ })
      .finally(() => { pending = false; });
  };
  // Bubble phase: a dialog or field that handles Échap first keeps it.
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
