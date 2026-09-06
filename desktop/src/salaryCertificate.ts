export const certificateBoxes: Record<string, string> = {
  '1': '1 · Salaire et allocations', '2_1': '2.1 · Pension et logement', '2_2': '2.2 · Voiture de service', '2_3': '2.3 · Autres avantages', '3': '3 · Prestations non périodiques', '4': '4 · Prestations en capital', '5': '5 · Droits de participation', '6': '6 · Conseil d’administration', '7': '7 · Autres prestations',
  '9': '9 · AVS / AI / APG / AC / AANP', '10_1': '10.1 · LPP ordinaire', '10_2': '10.2 · Rachats LPP retenus sur salaire', '12': '12 · Impôt à la source',
  '13_1_1': '13.1.1 · Voyage, repas, nuitées', '13_1_2': '13.1.2 · Autres frais effectifs', '13_2_1': '13.2.1 · Représentation', '13_2_2': '13.2.2 · Frais forfaitaires de voiture', '13_2_3': '13.2.3 · Autres frais forfaitaires', '13_3': '13.3 · Perfectionnement', 'exclude': 'Hors net fiscal · autre retenue',
};
export type CertificateIdentity = { name: string; address: string; avsNumber: string; birthDate: string; periodStart: string; periodEnd: string; employerContact: string; placeDate: string };
export type CertificateRow = { id: string; label: string; kind: 'earning' | 'deduction' | 'reimbursement'; amountCents: number; proposedBox: string; fixedBox: boolean; count: number };
export type CertificateSource = { id: string; period: string; paymentDate: string; defaultIncluded: boolean; rows: CertificateRow[] };
export type CertificateDraft = { employeeId: string; year: number; sourceHash: string; identity: CertificateIdentity; rows: CertificateRow[]; sources: CertificateSource[]; withholdingRows: CertificateRow[]; payslipCount: number; unpaidCount: number };
export type CertificateInput = { employeeId: string; year: number; sourceHash: string; identity: CertificateIdentity; sourceIds: string[]; realizationNote: string; allocations: Record<string,string>; extras: Array<{ boxId: string; label: string; amountCents: number }>; freeTransport: boolean; meals: boolean; effectiveExpensesAttested: boolean; benefits: string; remarks: string; reviewed: boolean };
export function certificateInput(draft: CertificateDraft): CertificateInput {
  return { employeeId: draft.employeeId, year: draft.year, sourceHash: draft.sourceHash, identity: { ...draft.identity }, sourceIds: draft.sources.filter(source => source.defaultIncluded).map(source => source.id), realizationNote: '', allocations: Object.fromEntries(draft.rows.map(row => [row.id, row.proposedBox])), extras: [], freeTransport: false, meals: false, effectiveExpensesAttested: false, benefits: '', remarks: '', reviewed: false };
}
export function certificateRows(draft: CertificateDraft, sourceIds: string[]) {
  const groups = new Map<string, CertificateRow>();
  for (const row of [...draft.sources.filter(source => sourceIds.includes(source.id)).flatMap(source => source.rows), ...draft.withholdingRows]) {
    const current = groups.get(row.id);
    if (current) { current.amountCents += row.amountCents; current.count += row.count; }
    else groups.set(row.id, { ...row });
  }
  return [...groups.values()];
}
export function certificateAllowedBoxes(kind: CertificateRow['kind']) {
  return kind === 'earning' ? ['1','2_1','2_2','2_3','3','4','5','6','7'] : kind === 'deduction' ? ['9','10_1','10_2','12','exclude'] : ['13_1_1','13_1_2','13_2_1','13_2_2','13_2_3','13_3'];
}

export function certificateCents(raw: string): number | null {
  const match = /^(-?)(\d{1,10})(?:[.,](\d{0,2}))?$/.exec(raw.trim());
  if (!match) return null;
  const cents = (Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'))) * (match[1] ? -1 : 1);
  return Number.isSafeInteger(cents) && Math.abs(cents) <= 100_000_000_000 ? cents : null;
}
