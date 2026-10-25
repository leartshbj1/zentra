/**
 * Métré d'une position : même calcul que `src-tauri/src/measurement.rs`
 * (virgule fixe à 9 décimales, arrondi demi vers l'extérieur, quantité au
 * millième). L'écran l'utilise pour afficher la quantité en direct ; l'app
 * native la recalcule à l'enregistrement.
 */
export type MeasurementRow = { label: string; formula: string; deduct?: boolean };

const SCALE = 1_000_000_000n;
const LIMIT = 1_000_000_000n * SCALE;
export const MAX_MEASUREMENT_ROWS = 60;

export class MeasurementError extends Error {}

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n + d / 2n) / d;
  return negative ? -quotient : quotient;
}

function bounded(value: bigint): bigint {
  if ((value < 0n ? -value : value) > LIMIT) throw new MeasurementError('Le métré dépasse la taille admise.');
  return value;
}

const MINUS = new Set(['-', '−', '–']);
const TIMES = new Set(['*', '×', 'x', 'X', '·']);
const DIVIDE = new Set(['/', '÷', ':']);

/** Valeur d'une formule en virgule fixe à 9 décimales. */
export function evaluateFormula(formula: string): bigint {
  const text = formula.trim();
  if (!text) throw new MeasurementError('Une ligne de métré n’a pas de formule.');
  const chars = Array.from(text);
  if (chars.length > 200) throw new MeasurementError('Une formule de métré est trop longue (200 caractères au plus).');
  let index = 0;
  let depth = 0;
  const unreadable = () => new MeasurementError(`La formule « ${text} » n’est pas lisible.`);
  const peek = () => {
    while (index < chars.length && /\s/.test(chars[index])) index += 1;
    return chars[index];
  };
  const number = (): bigint => {
    let whole = 0n, fraction = 0n, decimals = 0, separator = false, digits = 0;
    while (index < chars.length) {
      const c = chars[index];
      if (c >= '0' && c <= '9') {
        const digit = BigInt(c.charCodeAt(0) - 48);
        if (separator) {
          if (decimals === 9) throw new MeasurementError(`La formule « ${text} » a trop de décimales.`);
          fraction = fraction * 10n + digit;
          decimals += 1;
        } else {
          whole = whole * 10n + digit;
          if (whole > 1_000_000_000n) throw new MeasurementError('Le métré dépasse la taille admise.');
        }
        digits += 1;
      } else if ((c === '.' || c === ',') && !separator) separator = true;
      else if (c === '\'' && !separator && digits > 0) { /* séparateur de milliers */ }
      else break;
      index += 1;
    }
    if (!digits) throw unreadable();
    return bounded(whole * SCALE + fraction * 10n ** BigInt(9 - decimals));
  };
  const factor = (): bigint => {
    depth += 1;
    if (depth > 20) throw unreadable();
    const c = peek();
    let value: bigint;
    if (c !== undefined && MINUS.has(c)) { index += 1; value = -factor(); }
    else if (c === '+') { index += 1; value = factor(); }
    else if (c === '(') {
      index += 1;
      value = expression();
      if (peek() !== ')') throw unreadable();
      index += 1;
    } else if (c !== undefined && (/[0-9]/.test(c) || c === '.' || c === ',')) value = number();
    else throw unreadable();
    depth -= 1;
    return value;
  };
  const term = (): bigint => {
    let value = factor();
    for (;;) {
      const c = peek();
      if (c !== undefined && TIMES.has(c)) { index += 1; value = bounded(roundDiv(value * factor(), SCALE)); }
      else if (c !== undefined && DIVIDE.has(c)) {
        index += 1;
        const right = factor();
        if (right === 0n) throw new MeasurementError(`La formule « ${text} » divise par zéro.`);
        value = bounded(roundDiv(value * SCALE, right));
      } else return value;
    }
  };
  const expression = (): bigint => {
    let value = term();
    for (;;) {
      const c = peek();
      if (c === '+') { index += 1; value = bounded(value + term()); }
      else if (c !== undefined && MINUS.has(c)) { index += 1; value = bounded(value - term()); }
      else return value;
    }
  };
  const value = expression();
  if (peek() !== undefined) throw unreadable();
  return value;
}

/** Quantité de la position en millièmes, déductions soustraites. */
export function measurementQuantityMilli(rows: readonly MeasurementRow[]): number {
  if (!rows.length) throw new MeasurementError('Le métré ne contient aucune ligne.');
  if (rows.length > MAX_MEASUREMENT_ROWS) throw new MeasurementError('Le métré contient trop de lignes (60 au plus).');
  let total = 0n;
  for (const row of rows) {
    if (Array.from(row.label.trim()).length > 120) throw new MeasurementError('Le libellé d’une ligne de métré est trop long (120 caractères au plus).');
    const value = evaluateFormula(row.formula);
    total = bounded(row.deduct ? total - value : total + value);
  }
  const milli = roundDiv(total, SCALE / 1_000n);
  if (milli < 0n) throw new MeasurementError('Les déductions du métré dépassent la quantité mesurée.');
  return Number(milli);
}

/** Quantité (nombre décimal au millième), ou un message si une ligne est fausse. */
export function measurementQuantity(rows: readonly MeasurementRow[]): { quantity: number } | { error: string } {
  try {
    return { quantity: measurementQuantityMilli(rows) / 1_000 };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Valeur d'une seule ligne, en millièmes (pour l'affichage), ou null. */
export function measurementRowMilli(row: MeasurementRow): number | null {
  try {
    return Number(roundDiv(evaluateFormula(row.formula), SCALE / 1_000n));
  } catch {
    return null;
  }
}

/** Lignes enregistrées (`measurements_json`), nettoyées ; vide si absent ou illisible. */
export function measurementRowsFromRaw(value: unknown): MeasurementRow[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return [];
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(row => row && typeof row === 'object' && typeof (row as MeasurementRow).formula === 'string'
    ? [{ label: typeof (row as MeasurementRow).label === 'string' ? (row as MeasurementRow).label : '', formula: (row as MeasurementRow).formula, ...((row as MeasurementRow).deduct ? { deduct: true } : {}) }]
    : []);
}

/** Valeur stockée : null sans ligne, sinon le JSON attendu par l'app native. */
export function measurementRowsToRaw(rows: readonly MeasurementRow[] | undefined): string | null {
  const kept = (rows ?? []).map(row => ({ label: row.label.trim(), formula: row.formula.trim(), deduct: Boolean(row.deduct) })).filter(row => row.formula);
  return kept.length ? JSON.stringify(kept) : null;
}

export type ChapterGroup<T> = { title: string | null; lines: T[]; netCents: number };

/** Chapitres : lignes consécutives de même titre, avec leur sous-total net. */
export function chapterGroups<T extends { sectionTitle?: string | null }>(lines: readonly T[], net: (line: T) => number): ChapterGroup<T>[] {
  const groups: ChapterGroup<T>[] = [];
  for (const line of lines) {
    const title = line.sectionTitle?.trim() || null;
    const last = groups[groups.length - 1];
    if (last && last.title === title) {
      last.lines.push(line);
      last.netCents += net(line);
    } else groups.push({ title, lines: [line], netCents: net(line) });
  }
  return groups;
}
