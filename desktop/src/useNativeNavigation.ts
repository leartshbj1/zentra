import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { createNativeNavigationSession, type NativeDestination, type NativeNavigationItem } from './nativeNavigationSession';
export type { NativeDestination } from './nativeNavigationSession';

declare const __ZENTRA_PLATFORM__: string;
export const isNativeMacOS = typeof __ZENTRA_PLATFORM__ !== 'undefined' && __ZENTRA_PLATFORM__ === 'macos';

/** Keep the web controls until AppKit or UIKit confirms its native navigation. */
export function useNativeNavigation(selected: NativeDestination, visible: boolean, onNavigate: (destination: NativeDestination) => void, items?: NativeNavigationItem[]) {
  const [available, setAvailable] = useState(false);
  const current = useRef({ selected, visible, onNavigate, items });
  current.current = { selected, visible, onNavigate, items };
  const itemsKey = JSON.stringify(items);
  const synchronize = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof __ZENTRA_PLATFORM__ === 'undefined' || !['ios', 'macos'].includes(__ZENTRA_PLATFORM__) || !isTauri()) return;
    const hasDialog = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((node) => node.getClientRects().length > 0);
    let dialogOpen = hasDialog();
    const session = createNativeNavigationSession(
      isNativeMacOS ? 'configure_macos_navigation' : 'plugin:zentra-mobile|configure_navigation',
      () => ({ ...current.current, visible: current.current.visible && !hasDialog() }),
      setAvailable,
    );
    const update = () => { void session.update(); };
    synchronize.current = update;
    const observer = new MutationObserver(() => {
      const next = hasDialog();
      if (next !== dialogOpen) { dialogOpen = next; update(); }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden'] });
    update();
    return () => { observer.disconnect(); synchronize.current = null; void session.dispose(); };
  }, []);

  useEffect(() => { synchronize.current?.(); }, [selected, visible, itemsKey]);
  return available;
}
