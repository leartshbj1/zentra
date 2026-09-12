import { describe, expect, it } from 'vitest';
import { documentCompositions, normalizeComposition, normalizeRichText, richPlainText } from './documentComposition';
import { formatRichSelection } from './RichTextEditor';

describe('document composition', () => {
  it('keeps existing documents on their original renderer until a design is chosen', () => {
    expect(documentCompositions()).toEqual({});
    const styles = documentCompositions({ invoices: normalizeComposition({ fontFamily: 'times' }) });
    expect(styles.invoices?.fontFamily).toBe('times');
    expect(styles.quotes).toBeUndefined();
  });
  it('formats exactly the selected words, including a selection across paragraphs', () => {
    const value=normalizeRichText([{runs:[{text:'Paiement sous 30 jours.'}]},{runs:[{text:'Merci beaucoup.'}]}]);
    const bold=formatRichSelection(value,{start:0,end:8},'bold');
    expect(bold[0].runs[0]).toMatchObject({text:'Paiement',bold:true});
    expect(bold[0].runs[1].bold).toBe(false);
    const cross=formatRichSelection(bold,{start:20,end:29},'italic');
    expect(cross[0].runs.at(-1)).toMatchObject({text:'rs.',italic:true});
    expect(cross[1].runs[0]).toMatchObject({text:'Merci',italic:true});
    expect(richPlainText(cross)).toBe(richPlainText(value));
    const off=formatRichSelection(bold,{start:0,end:8},'bold');
    expect(off[0].runs[0].bold).toBe(false);
  });
  it('stores pasted markup as text and only allows known layout values', () => {
    const text=normalizeRichText([{runs:[{text:'<script>bonjour</script>',html:'<img>'}]}]);
    expect(text[0].runs[0].text).toBe('<script>bonjour</script>');
    expect(text[0].runs[0]).not.toHaveProperty('html');
    const style=normalizeComposition({bodySize:99,marginMm:0,fontFamily:'url(remote)' as never});
    expect(style).toMatchObject({bodySize:12,marginMm:12,fontFamily:'helvetica'});
  });
});
