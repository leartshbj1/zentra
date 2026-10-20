// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { quoteAutopilotReadFromRaw } from './bridge';
import { bytesToBase64, canPublishQuote, portalCards, portalPublishInput, savedPortal, savePortalEvents, savePortalLink, type PortalEvent } from './quotePortal';
import type { Quote } from './types';

const quote = (patch: Partial<Quote> = {}): Quote => ({
  id: 'q-1', number: 'D-2026-014', clientId: 'c-1', projectId: null, title: 'Rénovation salle de bain', issueDate: '2026-10-12', validUntil: '2026-11-11',
  currency: 'CHF', status: 'issued', notes: '', terms: '', createdAt: '2026-10-12T08:00:00Z',
  lines: [
    { id: 'l-1', description: 'Pose de carrelage', quantity: 12.5, unit: 'm²', unitPriceCents: 8_000, vatRateBp: 810 },
    { id: 'l-2', description: 'Déplacement', quantity: 1, unit: '', unitPriceCents: 6_000, discountBp: 1_000, vatRateBp: 810 },
  ],
  ...patch,
});
const workspace = { clients: [{ id: 'c-1', name: 'Claire Morel', company: 'Morel Immobilier SA' }], settings: { organization: { legalName: 'Bâtiments Rochat Sàrl' } } } as never;
const event = (patch: Partial<PortalEvent> = {}): PortalEvent => ({ eventId: 'e-1', documentId: 'q-1', kind: 'accepted', signerName: 'Claire Morel', comment: '', at: 1_792_467_000, ...patch });
const origin = { expectedWorkspaceScope: 'workspace-1', expectedMemberContextNonce: '0123456789abcdef0123456789abcdef' };
const envelope = (data: unknown) => ({ schemaVersion: 1, status: 'available', code: 'none', organizationId: 'org-1', workspaceScope: 'workspace-1', memberContextNonce: origin.expectedMemberContextNonce, data });

describe('quote portal', () => {
  it('publishes the issued quote with the amounts the app computes', () => {
    const input = portalPublishInput(quote(), workspace, 'JVBERi0xLjc=');
    // 12.5 × 80.00 = 1000.00 + TVA 8.1 % = 1081.00 ; 60.00 − 10 % = 54.00 + 4.37 = 58.37.
    expect(input.lines.map(line => line.totalCents)).toEqual([108_100, 5_837]);
    expect(input.totalCents).toBe(113_937);
    expect(input).toMatchObject({ kind: 'quote', documentId: 'q-1', clientKey: 'c-1', clientName: 'Morel Immobilier SA', companyName: 'Bâtiments Rochat Sàrl', validUntil: '2026-11-11' });
    expect(input.lines[0].quantity).toBe('12.5 m²');
    expect(portalPublishInput(quote(), workspace, 'not a pdf').pdfBase64).toBeNull();
  });

  it('offers the link only for an issued quote', () => {
    expect(canPublishQuote(quote())).toBe(true);
    for (const status of ['draft', 'accepted', 'refused', 'expired', 'cancelled'] as const) expect(canPublishQuote(quote({ status }))).toBe(false);
    expect(canPublishQuote(quote({ currency: 'USD' }))).toBe(false);
    expect(canPublishQuote(quote({ lines: [] }))).toBe(false);
  });

  it('encodes PDF bytes as base64', () => {
    expect(bytesToBase64([0x25, 0x50, 0x44, 0x46, 0x2d])).toBe('JVBERi0=');
    expect(bytesToBase64(new Uint8Array(100_000)).length).toBe(133_336);
  });

  it('shows the latest answer while the quote still waits for it', () => {
    const accepted = event();
    expect(portalCards([accepted], [quote()], [])).toHaveLength(1);
    expect(portalCards([accepted], [quote({ status: 'accepted' })], [])).toHaveLength(1);
    expect(portalCards([accepted], [quote()], [{ quoteId: 'q-1' }])).toHaveLength(0);
    expect(portalCards([event({ kind: 'declined' })], [quote({ status: 'refused' })], [])).toHaveLength(0);
    const later = event({ eventId: 'e-2', kind: 'declined', at: accepted.at + 60 });
    expect(portalCards([accepted, later], [quote()], []).map(card => card.event.eventId)).toEqual(['e-2']);
    expect(portalCards([event({ documentId: 'other' })], [quote()], [])).toHaveLength(0);
  });

  it('keeps links, events and the read position per company', () => {
    localStorage.clear();
    savePortalLink('org-1', 'q-1', { url: 'https://zentraapp.ch/p/abc', clientUrl: 'https://zentraapp.ch/p/c/xyz', expiresAt: '2027-01-10T00:00:00Z', publishedAt: 1 });
    savePortalEvents('org-1', { organizationId: 'org-1', items: [event()], nextCursor: 'c1' });
    savePortalEvents('org-1', { organizationId: 'org-1', items: [], nextCursor: null });
    expect(savedPortal('org-1')).toMatchObject({ cursor: 'c1', links: { 'q-1': { url: 'https://zentraapp.ch/p/abc' } }, events: { 'e-1': { signerName: 'Claire Morel' } } });
    expect(savedPortal('org-2').links).toEqual({});
  });

  it('reads the server replies with exact keys', () => {
    const page = { schemaVersion: 1, organizationId: 'org-1', items: [event()], nextCursor: null };
    const read = quoteAutopilotReadFromRaw<{ items: PortalEvent[] }>(envelope(page), origin, 'portalEvents');
    expect(read.data?.items[0].signerName).toBe('Claire Morel');
    expect(() => quoteAutopilotReadFromRaw(envelope({ ...page, items: [{ ...event(), ip: '1.2.3.4' }] }), origin, 'portalEvents')).toThrow();
    expect(() => quoteAutopilotReadFromRaw(envelope({ ...page, items: [event({ kind: 'paid' as never })] }), origin, 'portalEvents')).toThrow();
    const reply = { schemaVersion: 1, organizationId: 'org-1', documentId: 'q-1', url: 'https://zentraapp.ch/p/abc_D-1', clientUrl: 'https://zentraapp.ch/p/c/xyz', expiresAt: '2027-01-10T00:00:00Z' };
    expect(quoteAutopilotReadFromRaw<{ url: string }>(envelope(reply), origin, 'portalPublish').data?.url).toBe(reply.url);
    expect(() => quoteAutopilotReadFromRaw(envelope({ ...reply, url: 'https://zentraapp.ch/p/a?b=c' }), origin, 'portalPublish')).toThrow();
    expect(() => quoteAutopilotReadFromRaw(envelope({ ...reply, organizationId: 'org-2' }), origin, 'portalPublish')).toThrow();
  });
});
