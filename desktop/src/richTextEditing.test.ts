import { describe, expect, it } from 'vitest';
import { normalizeRichText, richPlainText, type RichText } from './documentComposition';
import { insertedTextRange, marksAtSelection, richTextLimit, selectedParagraphs, setRichMarks, typographyAtSelection } from './richTextEditing';

describe('rich text editing without losing content', () => {
  it('changes the font and size of a selection and keeps surrounding text and paragraphs intact', () => {
    const original = normalizeRichText([{ runs: [{ text: 'Titre et conditions', bold: true }] }, { runs: [{ text: 'Deuxième ligne' }] }]);
    const selected = setRichMarks(original, { start: 0, end: 5 }, { fontFamily: 'times', fontSize: 18 });
    expect(richPlainText(selected)).toBe(richPlainText(original));
    expect(selected[0].runs[0]).toMatchObject({ text: 'Titre', bold: true, fontFamily: 'times', fontSize: 18 });
    expect(selected[0].runs[1].fontFamily).toBeUndefined();
    expect(selected[1]).toEqual(original[1]);
    expect(marksAtSelection(selected, { start: 1, end: 4 })).toMatchObject({ fontFamily: 'times', fontSize: 18 });
    expect(marksAtSelection(selected, { start: 0, end: 9 }).fontSize).toBeUndefined();
    expect(typographyAtSelection(selected, { start: 0, end: 9 })).toEqual({ fontFamily: 'mixed', fontSize: 'mixed' });
    expect(typographyAtSelection(selected, { start: 1, end: 4 })).toEqual({ fontFamily: 'times', fontSize: 18 });
    const inherited = setRichMarks(selected, { start: 0, end: 5 }, { fontFamily: undefined, fontSize: undefined });
    expect(inherited).toEqual(original);
  });
  it('keeps distinct fonts and sizes and discards unsupported typography', () => {
    const result = normalizeRichText([{ runs: [{ text: 'a', fontSize: 18, fontFamily: 'times' }, { text: 'b', fontSize: 18, fontFamily: 'times' }, { text: 'c', fontSize: 12, fontFamily: 'times' }, { text: 'd', fontFamily: 'url(remote)', fontSize: Infinity }, { text: 'e', fontSize: 25 }] }]);
    expect(result[0].runs.map(r => [r.text, r.fontSize, r.fontFamily])).toEqual([['ab', 18, 'times'], ['c', 12, 'times'], ['de', undefined, undefined]]);
  });
  it('retains an oversized paste so the editor can reject it explicitly', () => {
    const value = Array.from({ length: 65 }, (_, i) => ({ runs: [{ text: `Ligne ${i}` }] }));
    const normalized = normalizeRichText(value);
    expect(normalized).toHaveLength(65);
    expect(richPlainText(normalized)).toContain('Ligne 64');
    expect(richTextLimit(normalized, 5000)).toContain('60 paragraphes');
  });
  it('coalesces equivalent formatting and reports excessive alternating runs', () => {
    const same = normalizeRichText([{ runs: Array.from({ length: 600 }, () => ({ text: 'a', bold: true })) }]);
    expect(same[0].runs).toEqual([{ text: 'a'.repeat(600), bold: true, italic: false, underline: false }]);
    expect(richTextLimit(same, 5000)).toBeNull();
    const alternating = normalizeRichText([{ runs: Array.from({ length: 600 }, (_, i) => ({ text: 'a', bold: !!(i % 2) })) }]);
    expect(richPlainText(alternating)).toHaveLength(600);
    expect(richTextLimit(alternating, 5000)).toContain('changements de mise en forme');
  });
  it('uses the selected paragraphs only, including caret and newline boundaries', () => {
    const value: RichText = [{ runs: [{ text: 'abc' }], bullet: true }, { runs: [{ text: 'def' }] }];
    expect(selectedParagraphs(value, { start: 1, end: 1 })).toEqual([0]);
    expect(selectedParagraphs(value, { start: 0, end: 4 })).toEqual([0]);
    expect(selectedParagraphs(value, { start: 4, end: 4 })).toEqual([1]);
    expect(selectedParagraphs(value, { start: 2, end: 6 })).toEqual([0, 1]);
  });
  it('applies explicit marks across paragraph boundaries without changing text', () => {
    const before: RichText = [{ runs: [{ text: 'Déjà', bold: true }] }, { runs: [{ text: 'merci', italic: true }] }];
    const after = setRichMarks(before, { start: 2, end: 7 }, { bold: false, underline: true });
    expect(richPlainText(after)).toBe('Déjà\nmerci');
    expect(marksAtSelection(after, { start: 2, end: 7 })).toEqual({ bold: false, italic: false, underline: true });
    expect(after[0].runs[0]).toMatchObject({ text: 'Dé', bold: true });
    expect(after[1].runs[0]).toMatchObject({ text: 'me', italic: true, underline: true });
    expect(after[1].runs[1]).toMatchObject({ text: 'rci', italic: true, underline: false });
  });
  it('identifies inserted, replaced and deleted text', () => {
    expect(insertedTextRange('Bonjour.', 'Bonjour à tous.')).toEqual({ start: 7, end: 14 });
    expect(insertedTextRange('ABC', 'AXYC')).toEqual({ start: 1, end: 3 });
    expect(insertedTextRange('ABC', 'AC')).toEqual({ start: 1, end: 1 });
  });
  it('colors only selected words and clears their formatting without changing the rest', () => {
    const value = normalizeRichText([{ runs: [{ text: 'Paiement sous 30 jours.', bold: true }] }, { runs: [{ text: 'Merci.', italic: true }] }]);
    const colored = setRichMarks(value, { start: 9, end: 16 }, { color: '#793c32', highlight: '#fff0a6' });
    expect(colored[0].runs.map(r => [r.text, r.color, r.highlight])).toEqual([
      ['Paiement ', undefined, undefined], ['sous 30', '#793c32', '#fff0a6'], [' jours.', undefined, undefined],
    ]);
    expect(marksAtSelection(colored, { start: 9, end: 16 })).toMatchObject({ color: '#793c32', highlight: '#fff0a6', bold: true });
    expect(marksAtSelection(colored, { start: 0, end: 16 }).color).toBeUndefined();
    const cleared = setRichMarks(colored, { start: 9, end: 16 }, { bold: false, italic: false, underline: false, color: undefined, highlight: undefined });
    expect(richPlainText(cleared)).toBe(richPlainText(value));
    expect(cleared[0].runs[0].bold).toBe(true);
    expect(cleared[0].runs[1]).toEqual({ text: 'sous 30', bold: false, italic: false, underline: false });
    expect(cleared[1]).toEqual(value[1]);
  });
  it('normalizes color codes without merging differently colored words', () => {
    const value = normalizeRichText([{ runs: [{ text: 'a', color: '#AABBCC' }, { text: 'b', color: '#aabbcc' }, { text: 'c', color: '#123456' }, { text: 'd', color: 'url(remote)', highlight: '#abcd' }] }]);
    expect(value[0].runs.map(r => [r.text, r.color])).toEqual([['ab', '#aabbcc'], ['c', '#123456'], ['d', undefined]]);
    expect(value[0].runs[2].highlight).toBeUndefined();
  });
});
