import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { documentSummary, validateUsSupplierDocumentDescriptor, validateUsSupplierDocumentRecord, type UsSupplierDocumentDescriptor } from './us-supplier-document-contract';

const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
const descriptor: UsSupplierDocumentDescriptor = { schemaVersion: 1, organizationId: org, id, contentSha256: 'a'.repeat(64), sizeBytes: 500,
  mediaType: 'application/pdf', fileName: 'Fictitious.pdf', documentText: 'Fictitious vendor invoice\nUSD 100.00', textSha256: createHash('sha256').update('Fictitious vendor invoice\nUSD 100.00').digest('hex'), createdBy: 'test-owner', createdAt: '2026-10-10T00:00:00.000Z' };
const record = { ...descriptor, stored: false, proposalId: null };
describe('US supplier document closed DTO validation', () => {
  it('captures immutable detached data and exposes only a bounded summary', () => {
    const candidate = { ...record }, captured = validateUsSupplierDocumentRecord(candidate, org); candidate.fileName = 'changed';
    expect(captured.fileName).toBe('Fictitious.pdf'); expect(Object.isFrozen(captured)).toBe(true);
    expect(documentSummary(captured)).toEqual({ schemaVersion: 1, organizationId: org, id, contentSha256: descriptor.contentSha256, sizeBytes: 500, mediaType: 'application/pdf', fileName: 'Fictitious.pdf', createdBy: 'test-owner', createdAt: descriptor.createdAt, stored: false, proposalId: null, readable: true });
    expect(JSON.stringify(documentSummary(captured))).not.toContain('documentText'); expect(JSON.stringify(documentSummary(captured))).not.toContain('textSha256');
  });
  it('accepts an unreadable immutable source without fabricating text', () => {
    const value = { ...record, documentText: null, textSha256: null };
    expect(validateUsSupplierDocumentRecord(value, org)).toEqual(value); expect(documentSummary(value).readable).toBe(false);
  });
  it.each([
    { extra: true }, { schemaVersion: 2 }, { organizationId: id }, { id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { contentSha256: 'A'.repeat(64) }, { sizeBytes: 0 }, { sizeBytes: 6 * 1024 * 1024 + 1 }, { sizeBytes: 1.5 },
    { mediaType: 'image/svg+xml' }, { fileName: '\nsecret' }, { fileName: 'x'.repeat(161) }, { documentText: '' }, { documentText: 'x'.repeat(16385) }, { documentText: 'é'.repeat(8193) },
    { documentText: null }, { textSha256: null }, { textSha256: 'f'.repeat(63) }, { documentText: '\u0000' }, { documentText: '\u0001' }, { createdBy: '' }, { createdAt: '2026-02-30T00:00:00Z' }, { createdAt: '2026-10-10' },
    { stored: 'true' }, { proposalId: id }, { proposalId: 'invalid' },
  ])('rejects malformed record %j', patch => { expect(() => validateUsSupplierDocumentRecord({ ...record, ...patch }, org)).toThrow(); });
  it('keeps descriptor and record schemas separate', () => {
    expect(validateUsSupplierDocumentDescriptor(descriptor, org)).toEqual(descriptor);
    expect(() => validateUsSupplierDocumentDescriptor(record, org)).toThrow(); expect(() => validateUsSupplierDocumentRecord(descriptor, org)).toThrow();
  });
  it('refuses accessors, sparse arrays, exotic prototypes and symbols without evaluating getters', () => {
    const getter = vi.fn(() => org), value = Object.defineProperty({ ...record }, 'organizationId', { get: getter, enumerable: true });
    expect(() => validateUsSupplierDocumentRecord(value, org)).toThrow(); expect(() => documentSummary(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    for (const candidate of [Array(1), new Date(), { ...record, [Symbol('private')]: 'secret' }, Object.create(record)]) expect(() => validateUsSupplierDocumentRecord(candidate, org)).toThrow();
  });
});
