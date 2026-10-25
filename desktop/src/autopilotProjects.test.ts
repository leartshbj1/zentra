import { describe, expect, it } from 'vitest';
import { projectFromQuote, quotesToStartProject } from './autopilotProjects';
import type { Client, Project, Quote } from './types';

const line = (description: string, quantity: number, unit: string, unitPriceCents: number) =>
  ({ id: description, description, quantity, unit, unitPriceCents, vatRateBp: 810 });
const quote = (id: string, values: Partial<Quote> = {}) => ({ id, number: 'D-2026-00' + id, clientId: 'c1', projectId: null, title: 'Devis – Cuisine Dupont',
  issueDate: '2026-10-20', validUntil: '2026-11-19', currency: 'CHF', status: 'accepted', notes: '', terms: '', createdAt: '2026-10-20T08:00:00Z',
  lines: [line('Pose cuisine', 16, 'h', 9500), line('Plan de travail', 1, 'pce', 120000)], ...values }) as Quote;

describe('job site from an accepted quote', () => {
  it('lists recent accepted quotes that no project carries yet', () => {
    const projects = [{ id: 'p', notes: 'Repris du devis D-2026-002.', archivedAt: null } as Project];
    const rows = [quote('1'), quote('2'), quote('3', { status: 'issued' }), quote('4', { projectId: 'p' }), quote('5', { issueDate: '2026-07-01' })];
    expect(quotesToStartProject(rows, projects, '2026-10-25').map(row => row.id)).toEqual(['1']);
  });

  it('takes the client, address, net budget, planned hours and one task per line from the quote', () => {
    const client = { id: 'c1', name: 'Marie Dupont', company: '', address: 'Rue du Lac 5', postalCode: '1003', city: 'Lausanne' } as Client;
    const plan = projectFromQuote(quote('1'), client, '2026-10-25');
    expect(plan.data).toMatchObject({ clientId: 'c1', name: 'Cuisine Dupont', addressLine1: 'Rue du Lac 5', postalCode: '1003', city: 'Lausanne',
      status: 'planned', plannedStartDate: '2026-10-25', budgetCents: 16 * 9500 + 120000, plannedMinutes: 960, notes: 'Repris du devis D-2026-001.' });
    expect(plan.tasks).toEqual([{ title: 'Pose cuisine', sortOrder: 1 }, { title: 'Plan de travail', sortOrder: 2 }]);
  });
});
