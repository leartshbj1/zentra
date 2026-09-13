import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';

/** Keep the native picker and reveal its full selected label when the field is too narrow. */
export function PayrollSelect({ onChange, children, ...props }: Omit<ComponentProps<'select'>, 'ref'>) {
  const control = useRef<HTMLSelectElement>(null);
  const measure = useRef<CanvasRenderingContext2D | null>(null);
  const [caption, setCaption] = useState('');
  function refresh() {
    const select = control.current;
    if (!select) return;
    const text = select.selectedOptions[0]?.textContent ?? '';
    const style = getComputedStyle(select);
    const context = measure.current ??= document.createElement('canvas').getContext('2d');
    if (context) context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const width = context ? context.measureText(text).width + Math.max(0, text.length - 1) * (parseFloat(style.letterSpacing) || 0) : Infinity;
    const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    setCaption(width > available ? text : '');
  }
  useLayoutEffect(refresh);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(refresh);
    if (control.current) observer.observe(control.current);
    return () => observer.disconnect();
  }, []);
  return <span className="payroll-select">
    <select {...props} ref={control} onChange={event => { onChange?.(event); refresh(); }}>{children}</select>
    {caption && <small className="payroll-select__caption" aria-hidden="true">{caption}</small>}
  </span>;
}
