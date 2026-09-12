import { normalizeRichText, richPlainText, type RichRun, type RichText } from './documentComposition';

export type TextSelection = { start: number; end: number };
export type TextMarks = Required<Pick<RichRun, 'bold' | 'italic' | 'underline'>>;
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

export function marksAtSelection(value: RichText, selection: TextSelection): TextMarks {
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
  return { bold: !!runs.length && runs.every(r => r.bold), italic: !!runs.length && runs.every(r => r.italic), underline: !!runs.length && runs.every(r => r.underline) };
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
