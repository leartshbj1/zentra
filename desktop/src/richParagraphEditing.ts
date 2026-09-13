import { normalizeRichText, richPlainText, type RichParagraph, type RichText } from './documentComposition';
import { marksAtSelection, replaceRichSelection, selectedParagraphs, type TextMarks, type TextSelection } from './richTextEditing';

export type ParagraphFormat = Omit<RichParagraph, 'runs'>;
export function paragraphMarkers(value: RichText): string[] {
  const counters = [0, 0, 0, 0];
  return value.map(p => {
    if (!p.numbered) { counters.fill(0); return p.bullet ? '•' : ''; }
    const depth = p.indent ?? 0;
    counters.fill(0, depth + 1);
    return `${++counters[depth]}.`;
  });
}

export function paragraphFormatAt(value: RichText, selection: TextSelection) {
  const selected = selectedParagraphs(value, selection).map(index => value[index]);
  const after = selected[0]?.spaceAfter ?? 0;
  return {
    bullet: !!selected.length && selected.every(p => p.bullet),
    numbered: !!selected.length && selected.every(p => p.numbered),
    canIndent: !selected.length || selected.some(p => (p.indent ?? 0) < 3),
    canOutdent: selected.some(p => (p.indent ?? 0) > 0),
    spaceAfter: selected.every(p => (p.spaceAfter ?? 0) === after) ? after : 'mixed' as const,
  };
}

export function formatParagraphs(value: RichText, selection: TextSelection, change: ParagraphFormat | 'indent' | 'outdent'): RichText {
  const source = value.length ? value : [{ runs: [] }];
  const selected = selectedParagraphs(source, selection);
  return normalizeRichText(source.map((p, index) => {
    if (!selected.includes(index)) return p;
    if (typeof change === 'string') return { ...p, indent: Math.max(0, Math.min(3, (p.indent ?? 0) + (change === 'indent' ? 1 : -1))) };
    return { ...p, ...change };
  }));
}

/** Inserting a paragraph must not move the formatting of the following paragraphs. */
export function insertParagraphText(value: RichText, selection: TextSelection, text: string, marks?: TextMarks): RichText {
  const source = value.length ? value : [{ runs: [] }];
  const paragraph = source[selectedParagraphs(source, { start: selection.start, end: selection.start })[0] ?? 0];
  const format = { ...paragraph, runs: [] };
  const style = marks ?? marksAtSelection(source, selection);
  const inserted = text.replace(/\r\n?/g, '\n').split('\n').map(part => ({ ...format, runs: part ? [{ text: part, ...style }] : [] }));
  return replaceRichSelection(source, selection, inserted);
}

export function leaveEmptyList(value: RichText, selection: TextSelection): RichText | null {
  if (selection.start !== selection.end) return null;
  const p = value[selectedParagraphs(value, selection)[0]];
  if (!p || !(p.bullet || p.numbered) || richPlainText([p])) return null;
  return formatParagraphs(value, selection, { bullet: false, numbered: false, indent: 0 });
}
