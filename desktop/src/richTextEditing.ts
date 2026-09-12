import { normalizeRichText, richPlainText, type RichRun, type RichText } from './documentComposition';

export type TextSelection = { start: number; end: number };
export type TextMarks = Required<Pick<RichRun, 'bold' | 'italic' | 'underline'>> & Pick<RichRun, 'color' | 'highlight' | 'fontFamily' | 'fontSize'>;
export const noTextMarks: TextMarks = { bold: false, italic: false, underline: false };

export function selectedParagraphs(value: RichText, selection: TextSelection): number[] {
  let offset = 0;
  return value.flatMap((p, index) => {
    const start = offset, end = start + richPlainText([p]).length;
    offset = end + 1;
    const selected = selection.start === selection.end
      ? selection.start >= start && selection.start <= end
      : selection.end > start && selection.start < Math.max(start + 1, end);
    return selected ? [index] : [];
  });
}

function runsAtSelection(value: RichText, selection: TextSelection): RichRun[] {
  let offset = 0;
  const runs: RichRun[] = [];
  for (const p of value) {
    const paragraphStart = offset;
    for (const run of p.runs) {
      const start = offset; offset += run.text.length;
      if (selection.start === selection.end
        ? selection.start > start && selection.start <= offset || selection.start === paragraphStart && selection.start === start
        : selection.end > start && selection.start < offset) runs.push(run);
    }
    offset++;
  }
  return runs;
}

export function typographyAtSelection(value: RichText, selection: TextSelection) {
  const runs = runsAtSelection(value, selection);
  const family = runs[0]?.fontFamily, size = runs[0]?.fontSize;
  return { fontFamily: runs.every(r => r.fontFamily === family) ? family || '' : 'mixed', fontSize: runs.every(r => r.fontSize === size) ? size || '' : 'mixed' };
}

export function marksAtSelection(value: RichText, selection: TextSelection): TextMarks {
  const runs = runsAtSelection(value, selection);
  const color = runs[0]?.color, highlight = runs[0]?.highlight, fontFamily = runs[0]?.fontFamily, fontSize = runs[0]?.fontSize;
  return { bold: !!runs.length && runs.every(r => r.bold), italic: !!runs.length && runs.every(r => r.italic), underline: !!runs.length && runs.every(r => r.underline), ...(color && runs.every(r => r.color === color) ? { color } : {}), ...(highlight && runs.every(r => r.highlight === highlight) ? { highlight } : {}), ...(fontFamily && runs.every(r => r.fontFamily === fontFamily) ? { fontFamily } : {}), ...(fontSize && runs.every(r => r.fontSize === fontSize) ? { fontSize } : {}) };
}

/** Apply explicit marks without toggling other formatting or removing any text. */
function setSelectionMarks(value: RichText, selection: TextSelection, marks: Partial<TextMarks>): RichText {
  let position = 0;
  return normalizeRichText(value.map(p => ({ ...p, runs: p.runs.flatMap(run => {
    const start = position; position += run.text.length;
    const a = Math.max(0, selection.start - start), b = Math.min(run.text.length, selection.end - start);
    return b <= a ? [run] : [{ ...run, text: run.text.slice(0, a) }, { ...run, text: run.text.slice(a, b), ...marks }, { ...run, text: run.text.slice(b) }].filter(r => r.text);
  }) })));
}

// Each paragraph separator counts as one character in the editor's selections.
export function setRichMarks(value: RichText, selection: TextSelection, marks: Partial<TextMarks>): RichText {
  let position = 0;
  return normalizeRichText(value.map(p => {
    const length = richPlainText([p]).length;
    const local = { start: Math.max(0, selection.start - position), end: Math.min(length, selection.end - position) };
    position += length + 1;
    return setSelectionMarks([p], local, marks)[0];
  }));
}

export function insertedTextRange(before: string, after: string): TextSelection {
  let start = 0, previousEnd = before.length, end = after.length;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (previousEnd > start && end > start && before[previousEnd - 1] === after[end - 1]) { previousEnd--; end--; }
  return { start, end };
}

export function richTextLimit(value: RichText, maxLength: number): string | null {
  if (richPlainText(value).length > maxLength) return `Ce texte peut contenir ${maxLength} caractères au maximum. Le texte précédent est conservé.`;
  if (value.length > 60) return 'Ce texte peut contenir 60 paragraphes au maximum. Regroupez certaines lignes avant de le coller. Le texte précédent est conservé.';
  if (value.some(p => p.runs.length > 500)) return 'Ce paragraphe comporte trop de changements de mise en forme. Simplifiez quelques passages. Le texte précédent est conservé.';
  return null;
}

/** Replace a selection structurally, so pasted paragraphs keep their own formatting. */
export function replaceRichSelection(value: RichText, selection: TextSelection, inserted: RichText): RichText {
  const source = value.length ? value : [{ runs: [] }];
  const length = richPlainText(source).length;
  const start = Math.max(0, Math.min(length, Math.min(selection.start, selection.end)));
  const end = Math.max(start, Math.min(length, Math.max(selection.start, selection.end)));
  function point(target: number) {
    for (let i = 0; i < source.length; i++) {
      const size = richPlainText([source[i]]).length;
      if (target <= size || i === source.length - 1) return { index: i, offset: target };
      target -= size + 1;
    }
    return { index: 0, offset: 0 };
  }
  function slice(runs: RichRun[], from: number, to: number) {
    let offset = 0;
    return runs.flatMap(run => {
      const start = offset; offset += run.text.length;
      const a = Math.max(0, from - start), b = Math.min(run.text.length, to - start);
      return b > a ? [{ ...run, text: run.text.slice(a, b) }] : [];
    });
  }
  const a = point(start), b = point(end);
  const prefix = slice(source[a.index].runs, 0, a.offset);
  const suffix = slice(source[b.index].runs, b.offset, Infinity);
  const middle = (inserted.length ? inserted : [{ ...source[a.index], runs: [] }]).map(p => ({ ...p, runs: [...p.runs] }));
  if (prefix.length) middle[0] = { ...source[a.index], runs: [...prefix, ...middle[0].runs] };
  middle[middle.length - 1].runs.push(...suffix);
  return normalizeRichText([...source.slice(0, a.index), ...middle, ...source.slice(b.index + 1)]);
}

export type ParagraphStyle = 'normal' | 'heading' | 'subheading';
export const paragraphStyleMarks: Record<ParagraphStyle, Partial<TextMarks>> = {
  normal: { bold: false, italic: false, underline: false, fontSize: undefined, fontFamily: undefined },
  heading: { bold: true, italic: false, underline: false, fontSize: 18 },
  subheading: { bold: true, italic: false, underline: false, fontSize: 12 },
};
export function setParagraphStyle(value: RichText, selection: TextSelection, style: ParagraphStyle): RichText {
  const source = value.length ? value : [{ runs: [] }];
  const selected = selectedParagraphs(source, selection);
  return normalizeRichText(source.map((p, i) => selected.includes(i)
    ? { ...p, runs: p.runs.map(run => ({ ...run, ...paragraphStyleMarks[style] })) }
    : p));
}
