import { Minus, Plus } from 'lucide-react';
import { useId } from 'react';
import type { DocumentComposition } from './documentComposition';

const format = (value: number) => new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 2 }).format(value);
export function CustomMeasureOption({ value, choices, unit = 'pt' }: { value: number; choices: number[]; unit?: string }) {
  return choices.includes(value) ? null : <option value={value} title="Valeur personnalisée">{format(value)} {unit}</option>;
}

type Measure = { field: 'bodySize' | 'titleSize' | 'marginMm' | 'lineSpacing' | 'logoHeight' | 'tablePadding' | 'topMarginMm' | 'logoGap' | 'blockSpacing'; label: string; min: number; max: number; step: number; unit: string; fallback?: number };
const typography: Measure[] = [
  { field: 'bodySize', label: 'Taille du texte', min: 8, max: 12, step: .5, unit: 'pt' },
  { field: 'titleSize', label: 'Taille du titre', min: 18, max: 34, step: 1, unit: 'pt' },
];
const layout: Measure[] = [
  { field: 'marginMm', label: 'Marges', min: 12, max: 25, step: .5, unit: 'mm' },
  { field: 'lineSpacing', label: 'Interligne', min: 1.15, max: 1.8, step: .05, unit: '×' },
  { field: 'logoHeight', label: 'Hauteur maximale du logo', min: 24, max: 72, step: 1, unit: 'pt' },
  { field: 'tablePadding', label: 'Espace dans les lignes', min: 4, max: 10, step: .5, unit: 'pt' },
  { field: 'topMarginMm', label: 'Début du contenu', min: 12, max: 45, step: .5, unit: 'mm' },
  { field: 'logoGap', label: 'Espace sous le logo', min: 0, max: 36, step: 1, unit: 'pt', fallback: 14 },
  { field: 'blockSpacing', label: 'Espace entre les blocs', min: .5, max: 2, step: .05, unit: '×', fallback: 1 },
];

/** Every step is supported by the existing PDF composition contract. */
export function DocumentPrecisionControls({ section, design, disabled, onChange, onGestureStart, onGestureEnd }: {
  section: 'typography' | 'layout'; design: DocumentComposition; disabled: boolean; onChange: (patch: Partial<DocumentComposition>) => void;
  onGestureStart: () => void; onGestureEnd: () => void;
}) {
  const id = useId();
  return <details className="design-studio__precision">
    <summary>{section === 'typography' ? 'Réglage précis de la typographie' : 'Réglage précis de la page'}</summary>
    <p>Déplacez un curseur ou utilisez − et + pour affiner. L’aperçu PDF suit vos réglages.</p>
    <fieldset disabled={disabled}>
      <legend className="sr-only">{section === 'typography' ? 'Tailles personnalisées' : 'Mesures personnalisées'}</legend>
      {(section === 'typography' ? typography : layout).map(measure => {
        const value = design[measure.field] ?? measure.fallback ?? design.marginMm;
        const change = (next: number) => onChange({ [measure.field]: Math.round(Math.max(measure.min, Math.min(measure.max, next)) * 100) / 100 });
        return <div className="design-measure" key={measure.field}>
          <div className="design-measure__label"><label htmlFor={`${id}-${measure.field}`}>{measure.label}</label><output htmlFor={`${id}-${measure.field}`}>{format(value)} {measure.unit}</output></div>
          <div className="design-measure__control">
            <button type="button" aria-label={`Réduire : ${measure.label}`} disabled={disabled || value <= measure.min} onClick={() => change(value - measure.step)}><Minus size={16} /></button>
            <input id={`${id}-${measure.field}`} type="range" aria-label={`Réglage précis : ${measure.label}`} aria-valuetext={`${format(value)} ${measure.unit}`} value={value} min={measure.min} max={measure.max} step={measure.step} onPointerDown={onGestureStart} onPointerUp={onGestureEnd} onPointerCancel={onGestureEnd} onBlur={onGestureEnd} onKeyDown={e => { if (!e.repeat && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key)) onGestureStart(); }} onKeyUp={onGestureEnd} onChange={e => change(Number(e.target.value))} />
            <button type="button" aria-label={`Augmenter : ${measure.label}`} disabled={disabled || value >= measure.max} onClick={() => change(value + measure.step)}><Plus size={16} /></button>
          </div>
          {measure.field === 'topMarginMm' && <div className="design-measure__inherit"><small>{design.topMarginMm == null ? 'Suit les marges du document.' : 'Marge du haut indépendante.'}</small>{design.topMarginMm != null && <button type="button" onClick={() => onChange({ topMarginMm: undefined })}>Suivre les marges</button>}</div>}
          {measure.field === 'logoHeight' && <small>Le logo garde ses proportions, dans la largeur choisie plus haut.</small>}
        </div>;
      })}
    </fieldset>
  </details>;
}
