import { describe, expect, it } from 'vitest';
import { certificateCents } from './salaryCertificate';
describe('montants complémentaires du certificat', () => {
  it('conserve exactement les centimes et les corrections négatives', () => {
    expect(certificateCents('1.15')).toBe(115);
    expect(certificateCents('-125,05')).toBe(-12505);
    expect(certificateCents('5000.')).toBe(500000);
    for (const value of ['', '1e8', 'NaN', '12.345', '1000000001']) expect(certificateCents(value)).toBeNull();
  });
});
