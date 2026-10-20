import type { Quote } from './types';
import { documentTotals } from './utils';

export type OpportunityStage = 'lead' | 'contact' | 'quote' | 'won' | 'lost';
export type Opportunity = {
  id: string;
  clientId: string | null;
  prospectName: string;
  title: string;
  stage: OpportunityStage;
  amountCents: number;
  expectedCloseDate: string | null;
  quoteId: string | null;
  notes: string;
  lostReason: string;
  stageChangedAt: string;
  createdAt: string;
  updatedAt: string;
};

export const OPEN_STAGES = ['lead', 'contact', 'quote'] as const;
/** Probabilité par défaut de chaque étape, en points de base. */
export const STAGE_PROBABILITY_BP: Record<OpportunityStage, number> = { lead: 1_000, contact: 3_000, quote: 6_000, won: 10_000, lost: 0 };

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const stages: readonly OpportunityStage[] = ['lead', 'contact', 'quote', 'won', 'lost'];

export function opportunityFromRaw(row: RawRow): Opportunity {
  return {
    id: text(row.id), clientId: text(row.client_id) || null, prospectName: text(row.prospect_name), title: text(row.title),
    stage: stages.find(stage => stage === row.stage) ?? 'lead', amountCents: typeof row.amount_cents === 'number' ? row.amount_cents : 0,
    expectedCloseDate: text(row.expected_close_date) || null, quoteId: text(row.quote_id) || null, notes: text(row.notes), lostReason: text(row.lost_reason),
    stageChangedAt: text(row.stage_changed_at), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
  };
}

/** L'état du devis lié fait foi : émis → devis, accepté → gagnée, refusé ou expiré → perdue. */
export function effectiveStage(opportunity: Opportunity, quotes: readonly Pick<Quote, 'id' | 'status'>[]): OpportunityStage {
  const quote = opportunity.quoteId ? quotes.find(row => row.id === opportunity.quoteId) : undefined;
  if (!quote) return opportunity.stage;
  if (quote.status === 'accepted') return 'won';
  if (quote.status === 'refused' || quote.status === 'expired' || quote.status === 'cancelled') return 'lost';
  return opportunity.stage === 'won' || opportunity.stage === 'lost' ? opportunity.stage : 'quote';
}

/** Montant hors TVA : celui du devis lié, sinon le montant estimé. */
export function effectiveAmount(opportunity: Opportunity, quotes: readonly Pick<Quote, 'id' | 'lines'>[]): number {
  const quote = opportunity.quoteId ? quotes.find(row => row.id === opportunity.quoteId) : undefined;
  return quote ? documentTotals(quote.lines).netCents : opportunity.amountCents;
}

export type PipelineRow = { opportunity: Opportunity; stage: OpportunityStage; amountCents: number };
export type PipelineSummary = { open: number; openCents: number; weightedCents: number; wonCents: number; lostCount: number };

export function pipelineRows(opportunities: readonly Opportunity[], quotes: readonly Pick<Quote, 'id' | 'status' | 'lines'>[]): PipelineRow[] {
  return opportunities.map(opportunity => ({ opportunity, stage: effectiveStage(opportunity, quotes), amountCents: effectiveAmount(opportunity, quotes) }))
    .sort((a, b) => (a.opportunity.expectedCloseDate ?? '9999').localeCompare(b.opportunity.expectedCloseDate ?? '9999') || a.opportunity.createdAt.localeCompare(b.opportunity.createdAt));
}

/** Prévision pondérée : montant × probabilité de l'étape, arrondi au centime ; gagnées de l'année. */
export function pipelineSummary(rows: readonly PipelineRow[], year: string): PipelineSummary {
  const open = rows.filter(row => (OPEN_STAGES as readonly string[]).includes(row.stage));
  return {
    open: open.length,
    openCents: open.reduce((sum, row) => sum + row.amountCents, 0),
    weightedCents: open.reduce((sum, row) => sum + Math.round(row.amountCents * STAGE_PROBABILITY_BP[row.stage] / 10_000), 0),
    wonCents: rows.filter(row => row.stage === 'won' && (row.opportunity.stageChangedAt || row.opportunity.updatedAt).startsWith(year)).reduce((sum, row) => sum + row.amountCents, 0),
    lostCount: rows.filter(row => row.stage === 'lost' && (row.opportunity.stageChangedAt || row.opportunity.updatedAt).startsWith(year)).length,
  };
}

export function nextStage(stage: OpportunityStage): OpportunityStage | null {
  return stage === 'lead' ? 'contact' : stage === 'contact' ? 'quote' : null;
}

/** Opportunités ouvertes sans nouvelle depuis 21 jours, ou dont la date prévue est passée. */
export type StalledOpportunity = PipelineRow & { reason: 'quiet' | 'overdue'; days: number };
export function stalledOpportunities(rows: readonly PipelineRow[], today: string): StalledOpportunity[] {
  const day = (iso: string) => Math.floor(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / 86_400_000);
  return rows.flatMap((row): StalledOpportunity[] => {
    if (!(OPEN_STAGES as readonly string[]).includes(row.stage)) return [];
    if (row.opportunity.expectedCloseDate && row.opportunity.expectedCloseDate < today) return [{ ...row, reason: 'overdue', days: day(today) - day(row.opportunity.expectedCloseDate) }];
    const quiet = day(today) - day(row.opportunity.updatedAt || row.opportunity.createdAt);
    return quiet >= 21 ? [{ ...row, reason: 'quiet', days: quiet }] : [];
  });
}
