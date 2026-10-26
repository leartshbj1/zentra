// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressBillingDialog, parseDecimalInput } from './ProgressBillingDialog';
import type { Invoice, Quote, Workspace } from './types';

vi.mock('./language', () => ({ useAppLanguage: () => 'fr', getAppLocale: () => 'fr-CH', getAppLanguage: () => 'fr', t: (text: string, values?: Record<string, unknown>) => text.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? '')) }));

const quote = {
  id: 'q', number: 'D-2026-0007', clientId: 'c', projectId: null, title: 'Cage d’escalier', issueDate: '2026-09-01', validUntil: '2026-10-01', currency: 'CHF', status: 'accepted', notes: '', terms: '', createdAt: '',
  lines: [
    { id: 'a', description: 'Peinture murs', quantity: 200, unit: 'm²', unitPriceCents: 2_500, vatRateBp: 810, sectionTitle: 'Cage' },
    { id: 'b', description: 'Plâtrerie', quantity: 1, unit: 'forfait', unitPriceCents: 800_000, vatRateBp: 810, sectionTitle: 'Cage' },
  ],
} as Quote;
const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function render(workspace: Partial<Workspace>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<ProgressBillingDialog quote={quote} workspace={{ invoices: [], ...workspace } as Workspace} busy={false} close={() => undefined} onCreate={async () => true} />));
  return document.body.innerHTML;
}

describe('situation SIA 118 à l’écran', () => {
  it('lit les nombres saisis à la suisse', () => {
    expect(parseDecimalInput('37,5')).toBe(37.5);
    expect(parseDecimalInput("1'250")).toBe(1250);
    expect(parseDecimalInput('abc')).toBeNull();
    expect(parseDecimalInput('-3')).toBeNull();
  });

  it('propose la première situation avec les positions regroupées par chapitre', async () => {
    const html = await render({});
    expect(html).toContain('Situation n° 1');
    expect(html).toContain('Décompte final');
    expect(html).toContain('<h3>Cage</h3>');
    expect(html).toContain('Peinture murs');
    expect(html).toContain('Retenue de garantie (%)');
    expect(html).toContain('value="10"');
    expect(html).toContain('Rien de nouveau à facturer depuis la situation précédente.');
  });

  it('bloque une nouvelle situation tant que la précédente est un brouillon', async () => {
    const bill = { id: 'b1', quoteId: 'q', invoiceId: 'i1', sequence: 1, kind: 'situation' as const, progressDate: '2026-10-01', retentionBp: 1_000, cumulativeNetCents: 1, cumulativeRetentionCents: 0, retentionByRate: {}, previousNetCents: 0, netCents: 1, roundingCents: 0, lines: [] };
    const html = await render({ progressBills: [bill], progressPlans: [{ quoteId: 'q', retentionBp: 500, roundToFive: true }], invoices: [{ id: 'i1', status: 'draft' } as Invoice] });
    expect(html).toContain('La situation n° 1 est encore un brouillon.');
  });
});
