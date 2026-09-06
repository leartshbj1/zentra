import { describe, it, expect } from 'vitest';
import { payrollOcrRows } from './payrollOcrRows';
describe('position des mots OCR', () => {
  it('réunit le montant à droite avec sa rubrique même dans un autre bloc', () => {
    const header='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
    const tsv=[header, '5\t1\t9\t1\t1\t1\t480\t400\t80\t18\t94\t5000', '5\t1\t1\t1\t1\t1\t20\t400\t80\t18\t94\tSalaire', '5\t1\t1\t1\t1\t2\t108\t401\t80\t18\t94\tmensuel','5\t1\t8\t1\t1\t1\t400\t220\t100\t18\t94\tLausanne'].join('\n');
    expect(payrollOcrRows(tsv,'incorrect')).toBe('Lausanne\nSalaire mensuel 5000');
  });
});
