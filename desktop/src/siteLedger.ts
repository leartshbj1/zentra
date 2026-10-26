/**
 * Fiche chantier : prévu par nature de coût (budget du chantier, repris du
 * devis en un clic), réel lu dans les heures, la régie, les achats et la
 * sous-traitance, marge en temps réel et post-calcul à la fin. Tout est
 * calculé ici, de façon déterministe, à partir des données enregistrées.
 */
import { matchingRate, type LaborRateTable } from './laborRates';
import { kitTotals } from './serviceKits';
import type { Project, Workspace } from './types';
import { documentLineTotals } from './utils';

export const SITE_CATEGORIES = ['labor', 'material', 'subcontract', 'machine', 'other'] as const;
export type SiteCategory = typeof SITE_CATEGORIES[number];
export type BudgetLine = { id: string; projectId: string; category: SiteCategory; label: string; amountCents: number; minutes: number | null };
export type Subcontract = { id: string; projectId: string; supplierId: string | null; label: string; agreedCents: number; closed: boolean };
export type SubcontractLink = { supplierInvoiceId: string; subcontractId: string };

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const integer = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0);
const category = (value: unknown): SiteCategory => (SITE_CATEGORIES as readonly string[]).includes(text(value)) ? text(value) as SiteCategory : 'other';

export function siteFromRaw(budget: readonly RawRow[], subcontracts: readonly RawRow[], links: readonly RawRow[]) {
  return {
    projectBudgetLines: [...budget].sort((a, b) => integer(a.position) - integer(b.position)).map((row): BudgetLine => ({
      id: text(row.id), projectId: text(row.project_id), category: category(row.category), label: text(row.label), amountCents: integer(row.amount_cents), minutes: row.minutes == null ? null : integer(row.minutes),
    })),
    projectSubcontracts: subcontracts.map((row): Subcontract => ({ id: text(row.id), projectId: text(row.project_id), supplierId: text(row.supplier_id) || null, label: text(row.label), agreedCents: integer(row.agreed_cents), closed: row.status === 'closed' })),
    subcontractLinks: links.map((row): SubcontractLink => ({ supplierInvoiceId: text(row.supplier_invoice_id), subcontractId: text(row.subcontract_id) })),
  };
}

type Amount = { cents: number; minutes: number };
const emptyByCategory = (): Record<SiteCategory, Amount> => ({ labor: { cents: 0, minutes: 0 }, material: { cents: 0, minutes: 0 }, subcontract: { cents: 0, minutes: 0 }, machine: { cents: 0, minutes: 0 }, other: { cents: 0, minutes: 0 } });
const isHourUnit = (unit: string) => /^(h|heure|heures|std|ore|hour|hours)\.?$/i.test(unit.trim());
const isSubcontractCategory = (value: string) => /sous[- ]?trait|subunterneh|subappalt|subcontract/i.test(value);

export type SubcontractStatus = { subcontract: Subcontract; billedCents: number; remainingCents: number; invoices: number };
export type SiteLedger = {
  contractNetCents: number;
  invoicedNetCents: number;
  planned: Record<SiteCategory, Amount>;
  actual: Record<SiteCategory, Amount>;
  plannedCents: number;
  actualCents: number;
  plannedMarginCents: number | null;
  actualMarginCents: number;
  /** Part du contrat déjà facturée, en pour mille (null sans contrat). */
  invoicedPermille: number | null;
  /** Part du budget déjà consommée, en pour mille (null sans budget). */
  spentPermille: number | null;
  subcontracts: SubcontractStatus[];
  uncostedRegieMinutes: number;
  draftSupplierInvoices: number;
  finished: boolean;
};

/** Prévu, réel et marge du chantier, à partir des données de l'entreprise. */
export function siteLedger(project: Project, workspace: Workspace): SiteLedger {
  const planned = emptyByCategory();
  for (const line of workspace.projectBudgetLines ?? []) {
    if (line.projectId !== project.id) continue;
    planned[line.category].cents += line.amountCents;
    planned[line.category].minutes += line.minutes ?? 0;
  }
  const actual = emptyByCategory();
  // Heures pointées : coût enregistré sur chaque pointage.
  for (const entry of workspace.timeEntries) {
    if (entry.projectId !== project.id) continue;
    actual.labor.minutes += entry.minutes;
    actual.labor.cents += Math.round((entry.minutes * entry.hourlyCostCents) / 60);
  }
  // Régie : heures au coût du tarif, machines à part, matériel au prix d'achat.
  const tables: readonly LaborRateTable[] = workspace.laborRateTables ?? [];
  let uncostedRegieMinutes = 0;
  for (const report of workspace.workReports ?? []) {
    if (report.projectId !== project.id || report.status === 'draft') continue;
    for (const line of report.lines) {
      if (line.kind === 'material') {
        const item = line.catalogItemId ? workspace.catalogItems.find(candidate => candidate.id === line.catalogItemId) : undefined;
        actual.material.cents += Math.round(line.quantity * (item?.purchaseCostCents ?? 0));
        continue;
      }
      const rate = line.laborRateId ? tables.flatMap(table => table.rates).find(candidate => candidate.id === line.laborRateId) ?? null
        : tables.map(table => matchingRate(table, line, tables)).find(Boolean) ?? null;
      const bucket = rate?.kind === 'machine' ? actual.machine : actual.labor;
      const minutes = isHourUnit(line.unit) ? Math.round(line.quantity * 60) : 0;
      bucket.minutes += minutes;
      if (rate?.costCents != null) bucket.cents += Math.round(line.quantity * rate.costCents);
      else if (bucket === actual.labor) uncostedRegieMinutes += minutes;
    }
  }
  // Achats validés : sous-traitance si la facture est reliée à une sous-traitance du chantier.
  const subcontracts = (workspace.projectSubcontracts ?? []).filter(item => item.projectId === project.id);
  const links = new Map((workspace.subcontractLinks ?? []).map(link => [link.supplierInvoiceId, link.subcontractId]));
  const billed = new Map<string, { cents: number; invoices: number }>();
  let draftSupplierInvoices = 0;
  for (const invoice of workspace.supplierInvoices) {
    const linked = links.get(invoice.id);
    const subcontract = linked ? subcontracts.find(item => item.id === linked) : undefined;
    const lines = invoice.lines.filter(line => (line.projectId ?? invoice.projectId) === project.id || (subcontract && !line.projectId));
    if (!lines.length) continue;
    if (invoice.documentStatus !== 'validated') { draftSupplierInvoices += 1; continue; }
    const cost = lines.reduce((sum, line) => sum + (line.costCents ?? line.netCents), 0);
    if (subcontract) {
      actual.subcontract.cents += cost;
      const current = billed.get(subcontract.id) ?? { cents: 0, invoices: 0 };
      billed.set(subcontract.id, { cents: current.cents + cost, invoices: current.invoices + 1 });
    } else {
      for (const line of lines) (isSubcontractCategory(line.category) ? actual.subcontract : actual.material).cents += line.costCents ?? line.netCents;
    }
  }
  for (const expense of workspace.expenses) {
    if (expense.projectId !== project.id || expense.archivedAt) continue;
    (isSubcontractCategory(expense.category) ? actual.subcontract : actual.material).cents += expense.costCents ?? expense.netCents;
  }
  const contractNetCents = workspace.quotes.filter(quote => quote.projectId === project.id && quote.status === 'accepted')
    .reduce((sum, quote) => sum + quote.lines.reduce((total, line) => total + documentLineTotals(line).netCents, 0), 0);
  const invoicedNetCents = workspace.invoices.filter(invoice => invoice.projectId === project.id && invoice.status !== 'draft' && invoice.status !== 'cancelled')
    .reduce((sum, invoice) => sum + invoice.lines.reduce((total, line) => total + documentLineTotals(line).netCents, 0), 0);
  const plannedCents = SITE_CATEGORIES.reduce((sum, key) => sum + planned[key].cents, 0);
  const actualCents = SITE_CATEGORIES.reduce((sum, key) => sum + actual[key].cents, 0);
  return {
    contractNetCents, invoicedNetCents, planned, actual, plannedCents, actualCents,
    plannedMarginCents: contractNetCents && plannedCents ? contractNetCents - plannedCents : null,
    actualMarginCents: invoicedNetCents - actualCents,
    invoicedPermille: contractNetCents > 0 ? Math.round((invoicedNetCents / contractNetCents) * 1_000) : null,
    spentPermille: plannedCents > 0 ? Math.round((actualCents / plannedCents) * 1_000) : null,
    subcontracts: subcontracts.map(subcontract => {
      const done = billed.get(subcontract.id) ?? { cents: 0, invoices: 0 };
      return { subcontract, billedCents: done.cents, remainingCents: subcontract.agreedCents - done.cents, invoices: done.invoices };
    }),
    uncostedRegieMinutes,
    draftSupplierInvoices,
    finished: project.status === 'completed' || project.status === 'closed',
  };
}

/**
 * Budget proposé depuis les devis acceptés du chantier : matériel au prix
 * d'achat du catalogue, heures au coût horaire moyen des collaborateurs. La
 * personne vérifie et corrige avant d'enregistrer.
 */
export function budgetFromQuotes(project: Project, workspace: Workspace): Omit<BudgetLine, 'id' | 'projectId'>[] {
  let materialCents = 0, laborMinutes = 0;
  for (const quote of workspace.quotes) {
    if (quote.projectId !== project.id || quote.status !== 'accepted') continue;
    for (const line of quote.lines) {
      const item = line.catalogItemId ? workspace.catalogItems.find(candidate => candidate.id === line.catalogItemId) : undefined;
      const kit = line.catalogItemId ? workspace.serviceKits?.find(candidate => candidate.catalogItemId === line.catalogItemId) : undefined;
      if (kit) {
        // Kit : son matériel au coût et ses heures, multipliés par la quantité du devis.
        const totals = kitTotals(kit.lines);
        materialCents += Math.round(line.quantity * totals.materialCostCents);
        laborMinutes += Math.round(line.quantity * totals.laborMinutes);
      } else if (isHourUnit(line.unit)) laborMinutes += Math.round(line.quantity * 60);
      else if (item?.kind === 'product') materialCents += Math.round(line.quantity * item.purchaseCostCents);
    }
  }
  const costs = workspace.employees.map(employee => employee.hourlyCostCents).filter(cost => cost > 0);
  const hourly = costs.length ? Math.round(costs.reduce((sum, cost) => sum + cost, 0) / costs.length) : 0;
  const lines: Omit<BudgetLine, 'id' | 'projectId'>[] = [];
  if (laborMinutes) lines.push({ category: 'labor', label: 'Main-d’œuvre selon devis', amountCents: Math.round((laborMinutes * hourly) / 60), minutes: laborMinutes });
  if (materialCents) lines.push({ category: 'material', label: 'Matériel selon devis', amountCents: materialCents, minutes: null });
  return lines;
}
