import { useEffect, useRef, useState } from 'react';
import { t, useAppLanguage } from './language';
import { signaturePath, signatureReady, type Point } from './workReports';

/** Zone de signature au doigt ou à la souris ; rend un chemin SVG compact. */
export function SignaturePad({ disabled, onChange }: { disabled: boolean; onChange: (path: string) => void }) {
  useAppLanguage();
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  function context() {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return null;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = getComputedStyle(element).color;
    return { element, ctx };
  }
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = element.getBoundingClientRect();
    element.width = Math.round(rect.width * ratio);
    element.height = Math.round(rect.height * ratio);
    element.getContext('2d')?.scale(ratio, ratio);
  }, []);
  const point = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const publish = () => {
    const rect = canvas.current?.getBoundingClientRect();
    const path = signaturePath(strokes.current, rect?.width ?? 600, rect?.height ?? 200);
    setEmpty(!signatureReady(path));
    onChange(signatureReady(path) ? path : '');
  };
  function clear() {
    strokes.current = [];
    const found = context();
    found?.ctx.clearRect(0, 0, found.element.width, found.element.height);
    publish();
  }
  return <div className="signature-pad">
    <canvas
      ref={canvas}
      aria-label={t('Zone de signature')}
      onPointerDown={(event) => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drawing.current = true;
        const start = point(event);
        strokes.current.push([start]);
        const found = context();
        found?.ctx.beginPath();
        found?.ctx.moveTo(start.x, start.y);
      }}
      onPointerMove={(event) => {
        if (!drawing.current) return;
        const next = point(event);
        strokes.current[strokes.current.length - 1].push(next);
        const found = context();
        found?.ctx.lineTo(next.x, next.y);
        found?.ctx.stroke();
      }}
      onPointerUp={() => { drawing.current = false; publish(); }}
      onPointerCancel={() => { drawing.current = false; publish(); }}
    />
    <div className="signature-pad__footer">
      <small>{t(empty ? 'Signez dans le cadre, au doigt ou à la souris.' : 'Signature prête.')}</small>
      <button type="button" disabled={disabled || empty} onClick={clear}>{t('Effacer')}</button>
    </div>
  </div>;
}

/** Affichage d'une signature enregistrée. */
export function SignatureView({ path, label }: { path: string; label: string }) {
  return <svg className="signature-view" viewBox="0 0 600 200" role="img" aria-label={label}>
    <path d={path} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
