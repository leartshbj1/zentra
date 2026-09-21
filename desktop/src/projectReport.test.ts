import { it, expect } from 'vitest';
import { turnoverByCurrency } from './salesFinancials';
import { buildProjectReport } from './projectReport';
import type { Invoice, Workspace, Project } from './types';
const invoice = (
  id: string,
  amount: number,
  extra: Partial<Invoice> = {},
): Invoice =>
  ({
    id,
    number: id,
    title: 'Travaux',
    status: 'issued',
    currency: 'CHF',
    issueDate: '2026-09-01',
    projectId: 'p',
    type: 'standard',
    lines: [
      {
        id: 'l',
        description: 'Prestation',
        quantity: 1,
        unit: 'h',
        unitPriceCents: amount,
        vatRateBp: 810,
      },
    ],
    ...extra,
  }) as Invoice;
it('shows annual net invoiced revenue with deposit deductions, credits and separate currencies', () => {
  const invoices = [
    invoice('acompte', 30000, { type: 'deposit' }),
    invoice('solde', 70000, { type: 'final' }),
    invoice('avoir', -10000, { type: 'credit_note' }),
    invoice('brouillon', 999999, { status: 'draft' }),
    invoice('annule', 999999, { status: 'cancelled' }),
    invoice('ancien', 999999, { issueDate: '2025-01-01' }),
    invoice('eur', 20000, { currency: 'EUR' }),
  ];
  expect(turnoverByCurrency(invoices, 2026)).toEqual([
    { currency: 'CHF', netCents: 90000 },
    { currency: 'EUR', netCents: 20000 },
  ]);
});
it('exports only the selected project and chosen sections, with credit-aware financial figures', () => {
  const p = {
    id: 'p',
    clientId: 'c',
    name: 'Projet A',
    status: 'in_progress',
    budgetCents: 100000,
    plannedMinutes: 600,
    notes: 'Conditions\nDeuxième ligne',
  } as Project;
  const w = {
    projects: [p],
    clients: [{ id: 'c', name: 'Client A' }],
    invoices: [
      invoice('A', 100000),
      invoice('B', 900000, { projectId: 'other' }),
    ],
    quotes: [],
    payments: [],
    timeEntries: [],
    expenses: [],
    supplierInvoices: [],
    supplierCreditNotes: [],
    projectMilestones: [],
    projectTasks: [],
    agendaEvents: [],
    attachments: [],
    employees: [],
  } as unknown as Workspace;
  const report = buildProjectReport(w, p, ['overview', 'documents']);
  expect(report.sections.map((s) => s.title)).toEqual([
    'Le projet',
    'Situation financière',
    'Documents du projet',
    'Notes du projet',
  ]);
  expect(JSON.stringify(report)).not.toContain('9000');
  expect(report.sections.at(-1)?.rows[0][0]).toBe(p.notes);
});
