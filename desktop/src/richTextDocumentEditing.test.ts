import { describe, expect, it } from 'vitest';
import { normalizeRichText, richPlainText } from './documentComposition';
import { replaceRichSelection, richTextLimit, setParagraphStyle } from './richTextEditing';

describe('document text selection and paragraph styles', () => {
  const source = normalizeRichText([{ align: 'right', runs: [{ text: 'Avant ', bold: true }, { text: 'milieu' }, { text: ' après', italic: true }] }, { runs: [{ text: 'Suite intacte' }] }]);
  const pasted = normalizeRichText([{ align: 'center', runs: [{ text: 'Titre', bold: true, fontSize: 18 }] }, { bullet: true, runs: [{ text: 'Condition', color: '#793c32' }] }]);
  it('pastes multiple formatted paragraphs into a selected passage without losing surrounding words', () => {
    const result = replaceRichSelection(source, { start: 6, end: 12 }, pasted);
    expect(richPlainText(result)).toBe('Avant Titre\nCondition après\nSuite intacte');
    expect(result[0].align).toBe('right');
    expect(result[0].runs[0]).toMatchObject({ text: 'Avant ', bold: true });
    expect(result[0].runs[1]).toMatchObject({ text: 'Titre', fontSize: 18 });
    expect(result[1]).toMatchObject({ bullet: true, runs: [{ text: 'Condition', color: '#793c32' }, { text: ' après', italic: true }] });
    expect(result[2]).toEqual(source[1]);
  });
  it('uses the pasted alignment when replacing a full paragraph', () => {
    const result = replaceRichSelection(source, { start: 0, end: 18 }, pasted);
    expect(result[0].align).toBe('center');
    expect(richPlainText(result)).toBe('Titre\nCondition\nSuite intacte');
  });
  it('replaces a selection crossing paragraphs without resurrecting deleted text', () => {
    const result = replaceRichSelection(source, { start: 6, end: 24 }, pasted);
    expect(richPlainText(result)).toBe('Avant Titre\nCondition intacte');
  });
  it('supports insertion at both ends and in an empty editor', () => {
    expect(replaceRichSelection([], { start: 0, end: 0 }, pasted)).toEqual(pasted);
    expect(richPlainText(replaceRichSelection(source, { start: 0, end: 0 }, pasted))).toBe('Titre\nConditionAvant milieu après\nSuite intacte');
    const end = richPlainText(source).length;
    expect(richPlainText(replaceRichSelection(source, { start: end, end }, pasted))).toBe('Avant milieu après\nSuite intacteTitre\nCondition');
  });
  it('handles a reversed selection and deletion without mutating the original', () => {
    expect(richPlainText(replaceRichSelection(source, { start: 12, end: 6 }, []))).toBe('Avant  après\nSuite intacte');
    expect(richPlainText(source)).toBe('Avant milieu après\nSuite intacte');
  });
  it('retains pasted text above limits for an explicit refusal instead of silent truncation', () => {
    const result = replaceRichSelection([], { start: 0, end: 0 }, [{ runs: [{ text: 'a'.repeat(5001) }] }]);
    expect(richPlainText(result)).toHaveLength(5001);
    expect(richTextLimit(result, 5000)).toContain('texte précédent est conservé');
  });
  it('applies a heading to the whole current paragraph while preserving colours and the following paragraphs', () => {
    const result = setParagraphStyle(source, { start: 7, end: 7 }, 'heading');
    expect(richPlainText(result)).toBe(richPlainText(source));
    expect(result[0].runs.every(run => run.bold && run.fontSize === 18 && !run.italic)).toBe(true);
    expect(result[1]).toEqual(source[1]);
    const normal = setParagraphStyle(result, { start: 7, end: 7 }, 'normal');
    expect(normal[0].runs.every(run => !run.bold && run.fontSize === undefined)).toBe(true);
  });
  it('applies a style to every selected paragraph and leaves a valid empty paragraph ready for typing', () => {
    const result = setParagraphStyle(source, { start: 3, end: 22 }, 'subheading');
    expect(result.every(p => p.runs.every(run => run.bold && run.fontSize === 12))).toBe(true);
    expect(setParagraphStyle([], { start: 0, end: 0 }, 'heading')).toEqual([{ runs: [], align: 'left', bullet: false }]);
  });
});
