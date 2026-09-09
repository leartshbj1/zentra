import { useEffect, useRef, useState } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';

declare const __ZENTRA_PLATFORM__: string;
export type NativeDestination = 'dashboard' | 'projects' | 'quotes' | 'menu';
export const isNativeMacOS = typeof __ZENTRA_PLATFORM__ !== 'undefined' && __ZENTRA_PLATFORM__ === 'macos';
const destinations: readonly string[] = ['dashboard', 'projects', 'quotes', 'menu'];

/** Keep the web controls until AppKit or UIKit confirms its native navigation. */
export function useNativeNavigation(selected: NativeDestination, visible: boolean, onNavigate: (destination: NativeDestination) => void) {
  const [available, setAvailable] = useState(false);
  const current = useRef({ selected, visible, onNavigate });
  current.current = { selected, visible, onNavigate };
  const synchronize = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof __ZENTRA_PLATFORM__ === 'undefined' || !['ios', 'macos'].includes(__ZENTRA_PLATFORM__) || !isTauri()) return;
    let disposed = false;
    let pending = Promise.resolve();
    const hasDialog = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((node) => node.getClientRects().length > 0);
    let dialogOpen = hasDialog();
    const channel = new Channel<{ id: string }>((event) => {
      if (!disposed && current.current.visible && !hasDialog() && destinations.includes(event.id)) current.current.onNavigate(event.id as NativeDestination);
    });
    const update = () => {
      pending = pending.then(async () => {
        const state = current.current;
        try {
          const result = await invoke<{ available: boolean }>(isNativeMacOS ? 'configure_macos_navigation' : 'plugin:zentra-mobile|configure_navigation', {
            selected: state.selected, visible: !disposed && state.visible && !hasDialog(), onNavigate: channel,
          });
          if (!disposed) setAvailable(result.available);
        } catch {
          // An older installation keeps its fully functional HTML controls.
          if (!disposed) setAvailable(false);
        }
      });
    };
    synchronize.current = update;
    const observer = new MutationObserver(() => {
      const next = hasDialog();
      if (next !== dialogOpen) { dialogOpen = next; update(); }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden'] });
    update();
    return () => { disposed = true; observer.disconnect(); synchronize.current = null; update(); };
  }, []);

  useEffect(() => { synchronize.current?.(); }, [selected, visible]);
  return available;
}
