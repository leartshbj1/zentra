import { cloneElement, useRef, useState, type ChangeEvent, type InputHTMLAttributes, type MutableRefObject, type ReactElement, type Ref } from 'react';
import { X } from 'lucide-react';
import { t, useAppLanguage } from './language';
import './ZClearInput.css';

// Transitions.dev « Input clear with dissolve », adapted to React-controlled inputs: the old words fly down
// and blur out while the placeholder settles back in, with one soft streak under each word.
type SearchInput = ReactElement<InputHTMLAttributes<HTMLInputElement>>;

const ease = (s: number) => 1 - Math.pow(1 - s, 3);

function streaks(input: HTMLInputElement, text: string, dark: boolean) {
  const style = getComputedStyle(input);
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return '';
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const width = input.clientWidth || 280;
  const left = input.offsetLeft + (parseFloat(style.paddingLeft) || 0);
  const rgb = dark ? '255,255,255' : '0,0,0';
  const layers: string[] = [];
  let x = 0;
  for (const part of text.split(/(\s+)/)) {
    const w = ctx.measureText(part).width;
    if (part.trim()) {
      const cx = left + x + w / 2;
      const hw = Math.max(w * 0.45, 8) * 1.5;
      for (const l of [{ dx: 0, rw: hw * 0.8, rh: 7, a: 0.22 }, { dx: hw * 0.45, rw: hw * 0.55, rh: 8, a: 0.18 }, { dx: -hw * 0.4, rw: hw * 0.65, rh: 6, a: 0.16 }, { dx: hw * 0.15, rw: hw * 0.9, rh: 5, a: 0.14 }]) {
        layers.push(`radial-gradient(ellipse ${Math.max(l.rw, 2).toFixed(1)}px ${l.rh}px at ${((cx + l.dx) / width * 100).toFixed(2)}% 100%, rgba(${rgb},${l.a}), transparent)`);
      }
    }
    x += w;
  }
  return layers.join(', ');
}

/** Wraps one search field: a clear button appears once something is typed, and clearing dissolves the words. */
export function ZClearInput({ children, className }: { children: SearchInput; className?: string }) {
  useAppLanguage();
  const input = useRef<HTMLInputElement | null>(null);
  const mirror = useRef<HTMLSpanElement>(null);
  const placeholder = useRef<HTMLSpanElement>(null);
  const glow = useRef<HTMLSpanElement>(null);
  const [clearing, setClearing] = useState(false);
  const props = children.props;
  const value = String(props.value ?? '');
  const disabled = Boolean(props.disabled || props.readOnly);

  const align = (element: HTMLElement, field: HTMLInputElement) => {
    const style = getComputedStyle(field);
    Object.assign(element.style, {
      left: `${field.offsetLeft + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0)}px`,
      top: `${field.offsetTop}px`, height: `${field.offsetHeight}px`,
      width: `${Math.max(0, field.clientWidth - (parseFloat(style.paddingLeft) || 0))}px`,
      font: style.font, letterSpacing: style.letterSpacing, color: style.color,
    });
  };

  const clear = () => {
    const field = input.current;
    if (!field || !value || clearing) return;
    const focused = document.activeElement === field;
    const empty = { target: { ...field, value: '' }, currentTarget: { ...field, value: '' } } as unknown as ChangeEvent<HTMLInputElement>;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const [m, p, g] = [mirror.current, placeholder.current, glow.current];
    if (reduce || !m || !p || !g) {
      props.onChange?.(empty);
      if (focused) field.focus({ preventScroll: true });
      return;
    }
    align(m, field); align(p, field);
    m.textContent = value.replace(/ /g, ' ');
    p.textContent = field.placeholder;
    p.style.color = '';
    g.style.background = streaks(field, value, document.documentElement.dataset.appTheme === 'dark');
    setClearing(true);
    props.onChange?.(empty);
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const out = ease(Math.min(1, elapsed / 400));
      m.style.transform = `translateY(${(out * 12).toFixed(1)}px)`;
      m.style.opacity = (1 - out).toFixed(3);
      m.style.filter = `blur(${(out * 2).toFixed(1)}px)`;
      const back = ease(Math.min(1, elapsed / 400));
      p.style.transform = `translateY(${(-12 + back * 12).toFixed(1)}px)`;
      p.style.opacity = (0.9 + back * 0.1).toFixed(3);
      p.style.filter = `blur(${(2 - back * 2).toFixed(1)}px)`;
      const gp = Math.min(1, Math.max(0, elapsed - 50) / 950);
      g.style.opacity = ((gp < 0.15 ? gp / 0.15 : 1 - (gp - 0.15) / 0.85) * 0.6).toFixed(3);
      if (elapsed < 1000) { requestAnimationFrame(tick); return; }
      for (const element of [m, p]) { element.style.transform = ''; element.style.opacity = ''; element.style.filter = ''; }
      m.textContent = ''; g.style.background = ''; g.style.opacity = '0';
      setClearing(false);
      if (focused) field.focus({ preventScroll: true });
    };
    requestAnimationFrame(tick);
  };

  return <span className={`z-clear${clearing ? ' is-clearing' : ''}${className ? ` ${className}` : ''}`}>
    {cloneElement(children, { ref: (element: HTMLInputElement | null) => {
      input.current = element;
      // React 19 keeps the caller's own ref in props; keep it working.
      const own = (props as { ref?: Ref<HTMLInputElement> }).ref;
      if (typeof own === 'function') own(element);
      else if (own) (own as MutableRefObject<HTMLInputElement | null>).current = element;
    } } as Partial<InputHTMLAttributes<HTMLInputElement>>)}
    <span ref={mirror} className="z-clear__mirror" aria-hidden="true" />
    <span ref={placeholder} className="z-clear__placeholder" aria-hidden="true" />
    <span ref={glow} className="z-clear__glow" aria-hidden="true" />
    {value && !disabled ? <button type="button" className="z-clear__button" aria-label={t('Effacer la recherche')}
      onPointerDown={event => { if (document.activeElement === input.current) event.preventDefault(); }}
      onMouseDown={event => { if (document.activeElement === input.current) event.preventDefault(); }}
      onClick={clear}><X size={13} aria-hidden="true" /></button> : null}
  </span>;
}
