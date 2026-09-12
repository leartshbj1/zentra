import { richPlainText, type RichText } from './documentComposition';
import { marksAtSelection, replaceRichSelection, richTextLimit, selectedParagraphs, type TextSelection } from './richTextEditing';

/** Literal Unicode search: punctuation is text, never a regular expression. */
export function findRichText(value: RichText, query: string, caseSensitive = false): TextSelection[] {
  if (!query) return [];
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(richPlainText(value).matchAll(new RegExp(pattern, caseSensitive ? 'gu' : 'giu')),
    match => ({ start: match.index, end: match.index + match[0].length }));
}

/** Replace original matches from right to left; inserted words are never searched again. */
export function replaceRichTextMatches(value: RichText, matches: TextSelection[], replacement: string, maxLength: number) {
  let next = value;
  replacement = replacement.replace(/\r\n?/g, '\n');
  const ordered = [...matches].sort((a, b) => a.start - b.start);
  const length = richPlainText(value).length;
  if (ordered.some((range, index) => !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > length || index > 0 && range.start < ordered[index - 1].end)) {
    return { value, error: 'Le texte a changé. Relancez la recherche avant de le remplacer.', count: 0 };
  }
  // Reject expansion before allocating potentially thousands of large replacements.
  const resultLength = ordered.reduce((size, range) => size + replacement.length - (range.end - range.start), length);
  if (resultLength > maxLength) return { value, error: `Ce texte peut contenir ${maxLength} caractères au maximum. Le texte précédent est conservé.`, count: 0 };
  for (const range of [...ordered].reverse()) {
    const paragraph = value[selectedParagraphs(value, { start: range.start, end: range.start })[0]];
    const marks = marksAtSelection(value, { start: range.start, end: range.start + 1 });
    const inserted = replacement.split('\n').map(text => ({ align: paragraph?.align, bullet: paragraph?.bullet, runs: text ? [{ text, ...marks }] : [] }));
    next = replaceRichSelection(next, range, inserted);
  }
  const error = richTextLimit(next, maxLength);
  return error ? { value, error, count: 0 } : { value: next, error: null, count: ordered.length };
}
