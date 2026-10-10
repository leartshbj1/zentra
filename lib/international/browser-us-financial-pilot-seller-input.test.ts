import { describe, expect, it } from 'vitest';
import { buildSellerReview, sellerCommandFromDraft } from './browser-us-financial-pilot-seller-input';
import type { UsFinancialPilotSellerCommand, UsFinancialPilotSellerRead } from './us-financial-pilot-seller';

const organizationId = '11111111-1111-4111-8111-111111111111';
function source(): UsFinancialPilotSellerRead {
  return { head: { consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision: 7, bankRevision: 2, sellerRevision: 4 },
    presentation: { origin: 'legacy-frozen', baseSellerRevision: 4, sellerRevision: 4, changeCount: 0, profile: { displayName: 'Synthetic Genève 🌍', contactEmail: 'seller@example.test', contactPhone: '+1 555 0100' }, updatedBy: 'synthetic-owner', updatedAt: '2026-10-10T09:00:00.123456Z', changeSha256: null } };
}
const command = (): UsFinancialPilotSellerCommand => ({ type: 'update_seller_presentation', displayName: 'Corrected Synthetic Seller', contactEmail: null, contactPhone: '+1 555 0120' });

describe('pure seller presentation input and review', () => {
  it('captures complete before/after and a closed command without creating a request identity', () => {
    const read = source(), draft = command(), review = buildSellerReview(read, draft);
    expect(review.source).toEqual(read); expect(review.command).toEqual(draft);
    expect(review.profile).toEqual({ displayName: draft.displayName, contactPhone: draft.contactPhone }); expect(review.changed).toBe(true);
    expect(Reflect.ownKeys(review)).toEqual(['source', 'command', 'profile', 'changed']);
    expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.source.head)).toBe(true);
    expect(Object.isFrozen(review.source.presentation.profile)).toBe(true); expect(Object.isFrozen(review.command)).toBe(true); expect(Object.isFrozen(review.profile)).toBe(true);
    (read.presentation.profile as { displayName: string }).displayName = 'Changed source'; (draft as { displayName: string }).displayName = 'Changed draft';
    expect(review.source.presentation.profile.displayName).toBe('Synthetic Genève 🌍'); expect(review.profile.displayName).toBe('Corrected Synthetic Seller');
  });
  it('converts empty contacts into explicit nulls while distinguishing contact removal', () => {
    const read = source(), cleared = sellerCommandFromDraft({ displayName: read.presentation.profile.displayName, contactEmail: '', contactPhone: '' });
    expect(cleared).toEqual({ type: 'update_seller_presentation', displayName: 'Synthetic Genève 🌍', contactEmail: null, contactPhone: null });
    expect(buildSellerReview(read, cleared).profile).toEqual({ displayName: 'Synthetic Genève 🌍' }); expect(buildSellerReview(read, cleared).changed).toBe(true);
  });
  it('recognizes unchanged fields independently of property order and unrelated F/B metadata', () => {
    const original = source(), read = { ...original, presentation: { ...original.presentation, profile: { contactPhone: '+1 555 0100', contactEmail: 'seller@example.test', displayName: 'Synthetic Genève 🌍' } } };
    const same: UsFinancialPilotSellerCommand = { type: 'update_seller_presentation', displayName: 'Synthetic Genève 🌍', contactEmail: 'seller@example.test', contactPhone: '+1 555 0100' };
    expect(buildSellerReview(read, same).changed).toBe(false);
    expect(buildSellerReview({ ...read, head: { ...read.head, revision: 8, bankRevision: 3 } }, same).changed).toBe(false);
  });
  it('preserves exact supported Unicode and the existing field limits', () => {
    const accepted = sellerCommandFromDraft({ displayName: 'Établissement synthétique Zürich 東京 🌍', contactEmail: 'seller@example.test', contactPhone: '+41 (0)22 555 01 00' });
    expect(accepted.displayName).toBe('Établissement synthétique Zürich 東京 🌍');
    expect(sellerCommandFromDraft({ displayName: 'x'.repeat(256), contactEmail: '', contactPhone: 'x'.repeat(80) }).contactPhone).toHaveLength(80);
    expect(() => sellerCommandFromDraft({ displayName: 'x'.repeat(257), contactEmail: '', contactPhone: '' })).toThrow('invalid_seller_input');
    expect(() => sellerCommandFromDraft({ displayName: 'Seller', contactEmail: '', contactPhone: 'x'.repeat(81) })).toThrow('invalid_seller_input');
  });
  it.each(['name-space', 'email-space', 'controls', 'empty-name', 'bad-email', 'extra', 'missing-null', 'legal-name', 'address', 'overflow'] as const)('rejects %s without preparing a review', kind => {
    const value = { ...command() } as Record<string, unknown>;
    if (kind === 'name-space') value.displayName = ' Seller ';
    if (kind === 'email-space') value.contactEmail = ' seller@example.test';
    if (kind === 'controls') value.displayName = 'Seller\nSecond line';
    if (kind === 'empty-name') value.displayName = '';
    if (kind === 'bad-email') value.contactEmail = 'not-an-email';
    if (kind === 'extra') value.requestId = 'injected';
    if (kind === 'missing-null') delete value.contactEmail;
    if (kind === 'legal-name') value.legalName = 'Injected LLC';
    if (kind === 'address') value.address = { country: 'US' };
    if (kind === 'overflow') value.displayName = '🌍'.repeat(10000);
    expect(() => buildSellerReview(source(), value as unknown as UsFinancialPilotSellerCommand)).toThrow('invalid_seller_input');
  });
  it('rejects an incoherent S source and hostile draft values without invoking accessors', () => {
    const read = source(); expect(() => buildSellerReview({ ...read, head: { ...read.head, sellerRevision: 5 } }, command())).toThrow('invalid_seller_input');
    let invoked = false; const draft = { displayName: 'Seller', contactEmail: '', contactPhone: '' };
    Object.defineProperty(draft, 'displayName', { enumerable: true, get: () => { invoked = true; return 'Injected'; } });
    expect(() => sellerCommandFromDraft(draft)).toThrow('invalid_seller_input'); expect(invoked).toBe(false);
    const symbolic = { ...command(), [Symbol('hidden')]: 'private' }; expect(() => buildSellerReview(read, symbolic)).toThrow('invalid_seller_input');
    const inherited = Object.assign(Object.create({ injected: true }), command()) as UsFinancialPilotSellerCommand;
    expect(() => buildSellerReview(read, inherited)).toThrow('invalid_seller_input');
  });
});
