// Contrats et abonnements : échéance en cours, dernier jour pour résilier,
// et alertes à 60 jours. Calcul de dates seulement, sans rien écrire.
import type { Contract } from './types';

const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

/** Ajoute des mois en restant sur le dernier jour du mois si nécessaire (31.01 + 1 mois = 28/29.02). */
export function addMonths(date: string, months: number): string {
  const value = parse(date);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const last = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, last));
  return iso(value);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

/** Fin de la période en cours : la date de fin, reconduite tant qu'elle est passée. Null : durée indéterminée. */
export function currentEnd(contract: Pick<Contract, 'endDate' | 'autoRenew' | 'renewalMonths'>, today: string): string | null {
  if (!contract.endDate) return null;
  if (!contract.autoRenew) return contract.endDate;
  // Toujours depuis la date d'origine : pas de dérive au fil des fins de mois.
  let end = contract.endDate;
  for (let period = 1; end < today && period < 1200; period += 1) end = addMonths(contract.endDate, period * contract.renewalMonths);
  return end;
}

/** Dernier jour pour envoyer la résiliation (fin de période moins le préavis). */
export function noticeDeadline(contract: Pick<Contract, 'endDate' | 'autoRenew' | 'renewalMonths' | 'noticeMonths'>, today: string): string | null {
  const end = currentEnd(contract, today);
  return end ? addMonths(end, -contract.noticeMonths) : null;
}

/** Prochaine décision encore possible : fin de période et dernier jour pour résilier, à partir d'aujourd'hui. */
export function nextDecision(contract: Pick<Contract, 'endDate' | 'autoRenew' | 'renewalMonths' | 'noticeMonths'>, today: string): { end: string; deadline: string } | null {
  const end = currentEnd(contract, today);
  if (!end || !contract.endDate) return null;
  if (!contract.autoRenew) return { end, deadline: addMonths(end, -contract.noticeMonths) };
  for (let period = 0; period < 1200; period += 1) {
    const candidate = period === 0 ? end : addMonths(contract.endDate, Math.round(monthsBetween(contract.endDate, end) / contract.renewalMonths + period) * contract.renewalMonths);
    const deadline = addMonths(candidate, -contract.noticeMonths);
    if (deadline >= today) return { end: candidate, deadline };
  }
  return null;
}

function monthsBetween(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

export type ContractAlert =
  | { kind: 'notice'; contract: Contract; deadline: string; end: string; days: number }
  | { kind: 'ending'; contract: Contract; end: string; days: number };

/**
 * Contrats actifs qui demandent une décision dans les `horizon` jours :
 * reconduction tacite → dernier jour pour résilier ; sans reconduction → fin du contrat.
 */
export function contractAlerts(contracts: readonly Contract[], today: string, horizon = 60): ContractAlert[] {
  const alerts: ContractAlert[] = [];
  for (const contract of contracts) {
    if (contract.status !== 'active') continue;
    const end = currentEnd(contract, today);
    if (!end) continue;
    if (contract.autoRenew) {
      // Délai déjà passé pour cette période : la prochaine décision porte sur la suivante.
      const next = nextDecision(contract, today);
      const days = next ? daysBetween(today, next.deadline) : -1;
      if (next && days >= 0 && days <= horizon) alerts.push({ kind: 'notice', contract, deadline: next.deadline, end: next.end, days });
    } else {
      const days = daysBetween(today, end);
      if (days >= 0 && days <= horizon) alerts.push({ kind: 'ending', contract, end, days });
    }
  }
  return alerts.sort((a, b) => a.days - b.days);
}

/** Montant mensuel moyen, pour comparer et prévoir (une fois : 0). */
export function monthlyCents(contract: Pick<Contract, 'amountCents' | 'frequency'>): number {
  switch (contract.frequency) {
    case 'monthly': return contract.amountCents;
    case 'quarterly': return Math.round(contract.amountCents / 3);
    case 'yearly': return Math.round(contract.amountCents / 12);
    default: return 0;
  }
}

/** Échéances de paiement d'un contrat entre deux dates (incluses), alignées sur sa date de début. */
export function contractDueDates(contract: Pick<Contract, 'startDate' | 'frequency' | 'status' | 'terminatedOn' | 'endDate' | 'autoRenew' | 'renewalMonths'>, from: string, to: string): string[] {
  const step = contract.frequency === 'monthly' ? 1 : contract.frequency === 'quarterly' ? 3 : contract.frequency === 'yearly' ? 12 : 0;
  const stop = contract.status === 'terminated' ? contract.terminatedOn ?? from : contract.autoRenew ? null : contract.endDate;
  if (!step) return contract.startDate >= from && contract.startDate <= to && (!stop || contract.startDate <= stop) ? [contract.startDate] : [];
  const dates: string[] = [];
  for (let index = 0; index < 1200; index += 1) {
    const date = addMonths(contract.startDate, index * step);
    if (date > to || (stop && date > stop)) break;
    if (date >= from) dates.push(date);
  }
  return dates;
}
