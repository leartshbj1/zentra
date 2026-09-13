export function isSalesDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export type InvoiceDates = { issueDate: string; dueDate: string; serviceDateFrom: string; serviceDateTo: string };
export type InvoiceDateIssue = { field: keyof InvoiceDates; message: string };

export function invoiceDateIssues(dates: InvoiceDates): InvoiceDateIssue[] {
  const issues: InvoiceDateIssue[] = [];
  if (!isSalesDate(dates.issueDate)) issues.push({ field: 'issueDate', message: 'Choisissez une date d’émission valide.' });
  if (!isSalesDate(dates.dueDate)) issues.push({ field: 'dueDate', message: 'Choisissez la date limite de paiement dans le champ « Échéance ».' });
  else if (isSalesDate(dates.issueDate) && dates.dueDate < dates.issueDate) issues.push({ field: 'dueDate', message: 'L’échéance doit être le jour de l’émission ou après. Corrigez l’une de ces deux dates.' });
  if (!isSalesDate(dates.serviceDateFrom)) issues.push({ field: 'serviceDateFrom', message: 'Indiquez le début de la prestation facturée. Pour une seule journée, cette date suffit.' });
  if (dates.serviceDateTo && !isSalesDate(dates.serviceDateTo)) issues.push({ field: 'serviceDateTo', message: 'Choisissez une date de fin de prestation valide, ou laissez ce champ vide.' });
  else if (isSalesDate(dates.serviceDateFrom) && dates.serviceDateTo && dates.serviceDateTo < dates.serviceDateFrom) issues.push({ field: 'serviceDateTo', message: 'La fin de la prestation doit être le même jour que son début ou après.' });
  return issues;
}

export function invoiceDatesError(dates: InvoiceDates): string {
  return invoiceDateIssues(dates)[0]?.message ?? '';
}

export function paymentInput(amount: string, date: string, issueDate: string, balanceCents: number): { amountCents: number; error: string } {
  const value = amount.trim().replace(',', '.');
  const amountCents = Math.round(Number(value) * 100);
  if (!/^\d+(\.\d{1,2})?$/.test(value) || !Number.isSafeInteger(amountCents) || amountCents <= 0)
    return { amountCents: 0, error: 'Indiquez le montant réellement reçu, supérieur à zéro, avec deux décimales au maximum.' };
  if (amountCents > balanceCents) return { amountCents, error: 'Ce montant dépasse ce qu’il reste à encaisser. Vérifiez le solde affiché et le montant reçu.' };
  if (!isSalesDate(date)) return { amountCents, error: 'Choisissez la date à laquelle vous avez reçu l’argent.' };
  if (date < issueDate) return { amountCents, error: 'Le paiement ne peut pas précéder l’émission de cette facture. Vérifiez la date de réception.' };
  return { amountCents, error: '' };
}
