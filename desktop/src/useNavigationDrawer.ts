import { useEffect, useRef, type RefObject } from 'react';

/** The compact menu behaves as a sheet for mouse, touch and keyboard users. */
export function useNavigationDrawer(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  const previousFocus = useRef<HTMLElement | null>(null);
  close.current = onClose;
  useEffect(() => {
    if (open) return;
    // WebKit blurs a focused control as soon as its ancestor becomes inert,
    // before the opening effect can inspect it. Remember it while still closed.
    const remember = (node: EventTarget | null) => {
      if (node instanceof HTMLElement && node !== document.body && node !== document.documentElement) previousFocus.current = node;
    };
    remember(document.activeElement);
    const focus = (event: FocusEvent) => remember(event.target);
    document.addEventListener('focusin', focus, true);
    return () => document.removeEventListener('focusin', focus, true);
  }, [open]);
  useEffect(() => {
    const drawer = ref.current?.closest<HTMLElement>('.sidebar');
    if (!open || !drawer) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = active && active !== document.body && active !== document.documentElement ? active : previousFocus.current;
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
