import { describe, expect, it } from 'vitest';
import { normalizeRichText, richPlainText } from './documentComposition';
import { formatParagraphs, insertParagraphText, leaveEmptyList, paragraphFormatAt, paragraphMarkers } from './richParagraphEditing';
import { replaceRichSelection, setRichMarks } from './richTextEditing';

const source = () => normalizeRichText([
  { numbered: true, indent: 1, spaceAfter: 6, runs: [{ text: 'Première condition', bold: true }] },
  { align: 'right', runs: [{ text: 'Deuxième condition', italic: true }] },
]);
describe('paragraph layout in a document editor', () => {
  it('keeps absent settings absent and bounds paragraph options', () => {
    expect(normalizeRichText([{ runs: [] }])[0]).toEqual({ runs: [], align: 'left', bullet: false });
    expect(normalizeRichText([{ numbered: true, bullet: true, indent: 9, spaceAfter: 99, runs: [] }])[0]).toMatchObject({ numbered: true, bullet: false, indent: 3, spaceAfter: 18 });
    expect(normalizeRichText([{ indent: NaN, spaceAfter: Infinity, runs: [] }])[0]).not.toHaveProperty('spaceAfter');
  });
  it('numbers each indent level and restarts after a plain paragraph', () => {
    const value = normalizeRichText([0, 1, 1, 0, 1, 3, 0].map(indent => ({ numbered: true, indent, runs: [] })));
    value.push({ runs: [] }, { numbered: true, runs: [] });
    expect(paragraphMarkers(value)).toEqual(['1.', '1.', '2.', '2.', '1.', '1.', '3.', '', '1.']);
  });
  it('modifies selected paragraphs without changing text or other paragraph styles', () => {
    const value = source(), next = formatParagraphs(value, { start: 2, end: 4 }, 'indent');
    expect(next[0].indent).toBe(2); expect(next[1]).toEqual(value[1]);
    expect(richPlainText(next)).toBe(richPlainText(value)); expect(value[0].indent).toBe(1);
    expect(formatParagraphs(value, { start: 0, end: 100 }, { spaceAfter: 12 }).every(p => p.spaceAfter === 12)).toBe(true);
  });
  it('bounds both indent actions and exposes mixed spacing', () => {
    const value = source(), all = { start: 0, end: 100 };
    expect(paragraphFormatAt(value, all).spaceAfter).toBe('mixed');
    let next = value;
    for (let i=0; i<5; i++) next = formatParagraphs(next, all, 'indent');
    expect(next.every(p => p.indent === 3)).toBe(true);
    expect(paragraphFormatAt(next, all).canIndent).toBe(false);
    for (let i=0; i<5; i++) next = formatParagraphs(next, all, 'outdent');
    expect(next.every(p => !p.indent)).toBe(true); expect(paragraphFormatAt(next, all).canOutdent).toBe(false);
  });
  it('splits a paragraph while keeping the following paragraph and inline marks intact', () => {
    const value = source(), next = insertParagraphText(value, { start: 8, end: 8 }, '\n');
    expect(richPlainText(next)).toBe('Première\n condition\nDeuxième condition');
    expect(next[0]).toMatchObject({ numbered: true, indent: 1, spaceAfter: 6 });
    expect(next[1]).toMatchObject({ numbered: true, indent: 1, spaceAfter: 6, runs: [{ text: ' condition', bold: true }] });
    expect(next[2]).toEqual(value[1]);
  });
  it('continues an empty list and exits it without adding another blank paragraph', () => {
    const value = source().slice(0, 1), end = richPlainText(value).length;
    const next = insertParagraphText(value, { start: end, end }, '\n');
    expect(paragraphMarkers(next)).toEqual(['1.', '2.']);
    const result = leaveEmptyList(next, { start: end + 1, end: end + 1 })!;
    expect(result).toHaveLength(2); expect(result[1].numbered).toBeUndefined(); expect(result[1].indent).toBeUndefined();
    expect(leaveEmptyList(value, { start: end, end })).toBeNull();
  });
  it('preserves paragraph layout through character formatting and structured paste', () => {
    const value = source();
    const next = setRichMarks(value, { start: 0, end: 3 }, { fontFamily: 'times', color: '#182b49' });
    expect(next[0]).toMatchObject({ numbered: true, indent: 1, spaceAfter: 6 });
    expect(replaceRichSelection([], { start: 0, end: 0 }, next)).toEqual(next);
  });
  it('starts a formatted paragraph in an empty editor and normalizes pasted newlines', () => {
    const value = formatParagraphs([], { start: 0, end: 0 }, { numbered: true });
    const next = insertParagraphText(value, { start: 0, end: 0 }, 'Une\r\nDeux');
    expect(paragraphMarkers(next)).toEqual(['1.', '2.']); expect(richPlainText(next)).toBe('Une\nDeux');
  });
});
