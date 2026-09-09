import { useEffect, useRef, type RefObject } from 'react';

/** The compact menu behaves as a sheet for mouse, touch and keyboard users. */
export function useNavigationDrawer(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const drawer = ref.current?.closest<HTMLElement>('.sidebar');
    if (!open || !drawer) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => [...drawer.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]')].filter(node => node.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => (drawer.querySelector<HTMLElement>('[aria-current="page"]') ?? items()[0])?.focus({preventScroll:true}));
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = items();
      const first = controls[0]; const last = controls.at(-1);
      if (!drawer.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus({preventScroll:true}); };
  }, [open, ref]);
}
