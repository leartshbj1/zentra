import { describe, expect, it } from 'vitest';
import { conflictFields, conflictValue, type BusinessConflictChange } from './businessConflictReview';

describe('human-readable conflict evidence', () => {
  it('keeps money exact beyond Number precision and distinguishes empty/absent values', () => {
    expect(conflictValue('total_cents', '9223372036854775807')).toBe('92233720368547758.07');
    expect(conflictValue('total_cents', '-1')).toBe('−0.01');
    expect(conflictValue('vat_bp', 810)).toBe('8.10 %');
    expect(conflictValue('quantity', 0)).toBe('0');
    expect(conflictValue('notes', '')).toBe('Vide');
    expect(conflictValue('notes', null)).toBe('Non renseigné');
  });
  it('detects different long-text tails even when the displayed prefixes are identical', () => {
    const image = (hash: string) => ({ fields: { notes: { value: 'Same preview', truncated: true, exact_integer: false, text_sha256: hash } }, truncated: true });
    const row: BusinessConflictChange = { sequence: '9007199254740993', key_json: '["a"]', table: 'clients', operation: 'update',
      base: image('a'), local: image('a'), shared: image('b'), first_conflict: true };
    expect(conflictFields(row)).toEqual([{ key: 'notes', changed: true }]);
    row.shared = image('a');
    expect(conflictFields(row)).toEqual([{ key: 'notes', changed: false }]);
    row.shared = null;
    expect(conflictFields(row)).toEqual([{ key: 'notes', changed: true }]);
  });
});
