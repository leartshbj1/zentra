import { describe, expect, it } from 'vitest';
import { documentCompositions, normalizeComposition, normalizeRichText } from './documentComposition';

describe('document composition', () => {
  it('keeps existing documents on their original renderer until a design is chosen', () => {
    expect(documentCompositions()).toEqual({});
    const styles = documentCompositions({ invoices: normalizeComposition({ fontFamily: 'times' }) });
    expect(styles.invoices?.fontFamily).toBe('times');
    expect(styles.quotes).toBeUndefined();
  });
  it('stores pasted markup as text and only allows known layout values', () => {
    const text=normalizeRichText([{runs:[{text:'<script>bonjour</script>',html:'<img>'}]}]);
    expect(text[0].runs[0].text).toBe('<script>bonjour</script>');
    expect(text[0].runs[0]).not.toHaveProperty('html');
    const style=normalizeComposition({bodySize:99,marginMm:0,fontFamily:'url(remote)' as never});
    expect(style).toMatchObject({bodySize:12,marginMm:12,fontFamily:'helvetica'});
  });
});
