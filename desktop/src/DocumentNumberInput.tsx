import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { documentNumberEntry, type DocumentNumberKind } from './documentNumberEntry';

export function DocumentNumberInput({ id, kind, label, value, startEmpty = false, rawValue, onRawChange, onChange, onValidityChange }: {
  id: string; kind: DocumentNumberKind; label: string; value: number; startEmpty?: boolean;
  onChange: (value: number) => void; onValidityChange: (id: string, error: string) => void;
  rawValue?: string; onRawChange?: (value: string) => void;
}) {
  const display = (n: number) => String(kind === 'quantity' ? n : n / 100);
  const [localRaw, setRaw] = useState(() => startEmpty ? '' : display(value));
  const raw = rawValue ?? localRaw;
  const [touched, setTouched] = useState(false);
  const published = useRef(value), element = useRef<HTMLInputElement>(null);
  const wasControlled = useRef(rawValue !== undefined);
  const result = documentNumberEntry(raw, kind);
  useEffect(() => {
    if (value !== published.current || (rawValue === undefined && wasControlled.current)) { published.current = value; setRaw(display(value)); }
    wasControlled.current = rawValue !== undefined;
  }, [value, rawValue]);
  useLayoutEffect(() => {
    element.current?.setCustomValidity(result.error);
    onValidityChange(id, result.error);
    return () => onValidityChange(id, '');
  }, [id, result.error, onValidityChange]);
  return <input data-document-number-id={id} ref={element} type="text" inputMode="decimal" aria-label={label} aria-invalid={touched && !!result.error} title={touched ? result.error : undefined}
    value={raw} required={kind !== 'discount'} maxLength={64} autoComplete="off" onBlur={() => setTouched(true)} onChange={event => {
      const next = event.target.value; setRaw(next); onRawChange?.(next);
      const parsed = documentNumberEntry(next, kind);
      if (parsed.value !== null) { published.current = parsed.value; onChange(parsed.value); }
    }} />;
}
