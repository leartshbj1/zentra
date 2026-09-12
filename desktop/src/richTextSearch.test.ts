import { describe, expect, it } from 'vitest';
import { normalizeRichText, richPlainText, type RichText } from './documentComposition';
import { findRichText, replaceRichTextMatches } from './richTextSearch';

const text = (content: string): RichText => normalizeRichText(content.split('\n').map(text => ({ runs: [{ text }] })));
describe('literal document search', () => {
  it('finds across styled runs and preserves UTF-16 editor offsets', () => {
    const value = [{ runs: [{ text: '😀 Dé', bold: true }, { text: 'lai délai DÉLAI' }] }];
    expect(findRichText(value, 'délai')).toEqual([{ start: 3, end: 8 }, { start: 9, end: 14 }, { start: 15, end: 20 }]);
    expect(findRichText(value, 'Délai', true)).toEqual([{ start: 3, end: 8 }]);
  });
  it('treats punctuation literally, rejects empty query and uses nonoverlapping matches', () => {
    expect(findRichText(text('.* [a] $& .*'), '.*')).toEqual([{ start: 0, end: 2 }, { start: 10, end: 12 }]);
    expect(findRichText(text('a'), '')).toEqual([]);
    expect(findRichText(text('aaaaa'), 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    expect(findRichText(text('z'), '(a+)+$')).toEqual([]);
  });
  it('retains Unicode case-folding offsets and paragraph boundaries', () => {
    expect(findRichText(text('İii\nCHF CHF'), 'i')).toEqual([{ start: 1, end: 2 }, { start: 2, end: 3 }]);
    expect(findRichText(text('paiement\nà réception'), 'paiement à')).toEqual([]);
    expect(findRichText(text('paiement\nà réception'), 'paiement\nà')).toEqual([{ start: 0, end: 10 }]);
  });
});
describe('structured replacements', () => {
  it('inherits first matched character style and keeps surrounding formatting and lists', () => {
    const value: RichText = normalizeRichText([{ align: 'right', bullet: true, runs: [
      { text: 'Avant ', italic: true }, { text: 'Délai', bold: true, fontFamily: 'times', fontSize: 18, color: '#793c32' }, { text: ' de paiement après', underline: true },
    ] }, { runs: [{ text: 'Autre texte' }] }]);
    const original = structuredClone(value);
    const result = replaceRichTextMatches(value, findRichText(value, 'Délai de paiement'), 'Conditions', 5000);
    expect(result.error).toBeNull(); expect(result.count).toBe(1);
    expect(richPlainText(result.value)).toBe('Avant Conditions après\nAutre texte');
    expect(result.value[0]).toMatchObject({ align: 'right', bullet: true, runs: [
      { text: 'Avant ', italic: true }, { text: 'Conditions', bold: true, fontFamily: 'times', fontSize: 18, color: '#793c32' }, { text: ' après', underline: true },
    ] });
    expect(value).toEqual(original);
  });
  it('replaces all original matches once even when the replacement contains the query', () => {
    const value = text('CHF CHF\nCHF');
    const result = replaceRichTextMatches(value, findRichText(value, 'CHF'), 'CHF $&', 5000);
    expect(result.count).toBe(3); expect(richPlainText(result.value)).toBe('CHF $& CHF $&\nCHF $&');
  });
  it('allows deletion and keeps blank paragraphs', () => {
    const value = text('CHF\nCHF\nAutre');
    const result = replaceRichTextMatches(value, findRichText(value, 'CHF'), '', 5000);
    expect(richPlainText(result.value)).toBe('\n\nAutre'); expect(result.value).toHaveLength(3);
  });
  it('preserves each paragraphs alignment when whole paragraphs are replaced', () => {
    const value: RichText = [{ align: 'center', runs: [{ text: 'Merci' }] }, { bullet: true, runs: [{ text: 'Merci' }] }];
    const result = replaceRichTextMatches(value, findRichText(value, 'Merci'), 'Merci beaucoup', 5000);
    expect(result.value[0].align).toBe('center'); expect(result.value[1].bullet).toBe(true);
  });
  it('refuses an oversized replacement atomically for the footer and full text', () => {
    for (const max of [180, 5000]) {
      const value = text('aa');
      const result = replaceRichTextMatches(value, findRichText(value, 'a'), 'b'.repeat(max), max);
      expect(result.value).toBe(value); expect(result.count).toBe(0); expect(result.error).toContain(`${max} caractères`);
    }
  });
  it('refuses too many paragraphs and invalid or overlapping ranges without mutating', () => {
    const value = text('abc');
    expect(replaceRichTextMatches(value, [{ start: 0, end: 1 }], '\n'.repeat(61), 5000).error).toContain('60 paragraphes');
    for (const ranges of [[{ start: -1, end: 1 }], [{ start: 2, end: 9 }], [{ start: 1, end: 1 }], [{ start: 0, end: 2 }, { start: 1, end: 3 }]]) {
      expect(replaceRichTextMatches(value, ranges, 'a', 5000)).toMatchObject({ value, count: 0 });
      expect(replaceRichTextMatches(value, ranges, 'a', 5000).error).toContain('texte a changé');
    }
  });
  it('rejects a large replace-all expansion before constructing it', () => {
    const value = text('a'.repeat(5000));
    const result = replaceRichTextMatches(value, findRichText(value, 'a'), 'b'.repeat(5000), 5000);
    expect(result.value).toBe(value); expect(result.count).toBe(0); expect(result.error).toContain('5000 caractères');
  });
});
