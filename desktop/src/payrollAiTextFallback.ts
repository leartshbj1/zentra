export type PayrollCoreTextFallback = {
  employeeName: string;
  grossCents: number;
  netCents: number;
  rawOutput: string;
};

export type PayrollLinesTextFallback = {
  lines: Array<{
    label: string;
    kind: 'earning' | 'deduction' | 'reimbursement' | 'employer';
    amountCents: number;
    sourcePage: number;
  }>;
  rawOutput: string;
};

const PRINTED_AMOUNT = String.raw`(?:\d{1,3}(?:['’\u00a0\u202f ]\d{3})+(?:[.,]\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;

const GROSS_LABELS = [
  String.raw`salaire\s+(?:mensuel\s+)?brut`,
  String.raw`total\s+brut`,
  String.raw`bruttolohn(?:summe)?`,
  String.raw`bruttogehalt`,
  String.raw`gross\s+(?:pay|salary|earnings)`,
  String.raw`(?:salario|stipendio)\s+lordo`,
  String.raw`totale\s+lordo`,
];

const NET_LABELS = [
  String.raw`net\s+(?:[àa]\s+)?payer`,
  String.raw`salaire\s+net`,
  String.raw`nett(?:o)?(?:lohn|gehalt)`,
  String.raw`auszahlungsbetrag`,
  String.raw`net\s+(?:pay|salary)`,
  String.raw`(?:salario|stipendio)\s+netto`,
  String.raw`netto\s+da\s+pagare`,
  String.raw`totale\s+netto`,
];

const EMPLOYEE_LABEL = String.raw`(?:collaborat(?:eur|rice)|employ[ée]e?|employee(?:\s+name)?|mitarbeiter(?:in)?|arbeitnehmer(?:in)?|dipendente|nom\s+(?:du\s+collaborateur|de\s+la\s+collaboratrice|de\s+l['’]employ[ée]e?))`;

const PAYROLL_LINE_RULES: ReadonlyArray<{
  kind: PayrollLinesTextFallback['lines'][number]['kind'];
  labels: readonly string[];
}> = [
  {
    kind: 'earning',
    labels: [
      String.raw`salaire\s+(?:mensuel\s+)?brut`,
      String.raw`salaire\s+de\s+base`,
      String.raw`(?:monthly|base)\s+salary`,
      String.raw`(?:monats|grund)lohn`,
      String.raw`salario\s+base`,
    ],
  },
  {
    kind: 'reimbursement',
    labels: [
      String.raw`remboursement(?:\s+de)?\s+frais`,
      String.raw`frais\s+rembours[ée]s`,
      String.raw`expense\s+reimbursement`,
      String.raw`spesen(?:entsch[äa]digung)?`,
      String.raw`rimborso\s+spese`,
    ],
  },
  {
    kind: 'deduction',
    labels: [
      String.raw`AVS\s*[/+\-]\s*AI\s*[/+\-]\s*APG`,
      String.raw`AHV\s*[/+\-]\s*IV\s*[/+\-]\s*EO`,
      String.raw`assurance[-\s]+ch[ôo]mage`,
      String.raw`ch[ôo]mage`,
      String.raw`unemployment\s+insurance`,
      String.raw`ALV`,
      String.raw`LPP`,
      String.raw`BVG`,
      String.raw`AANP`,
      String.raw`NBU`,
      String.raw`imp[ôo]t\s+[àa]\s+la\s+source`,
      String.raw`quellensteuer`,
    ],
  },
  {
    kind: 'employer',
    labels: [
      String.raw`cotisation\s+(?:AVS\s+)?(?:employeur|patronale)`,
      String.raw`contribution\s+employeur`,
      String.raw`arbeitgeberbeitrag`,
      String.raw`employer\s+contribution`,
      String.raw`contributo\s+del\s+datore`,
    ],
  },
];

function printedFrancsToCents(value: string): number | null {
  const raw = value.trim();
  if (!(new RegExp(`^${PRINTED_AMOUNT}$`, 'u')).test(raw)) return null;
  let normalized = raw.replace(/['’\u00a0\u202f ]/gu, '');
  const lastComma = normalized.lastIndexOf(',');
  const lastDot = normalized.lastIndexOf('.');
  let decimalIndex = -1;
  if (lastComma >= 0 && lastDot >= 0) decimalIndex = Math.max(lastComma, lastDot);
  else if (lastComma >= 0 && normalized.length - lastComma - 1 <= 2) decimalIndex = lastComma;
  else if (lastDot >= 0 && normalized.length - lastDot - 1 <= 2) decimalIndex = lastDot;
  const fractionText = decimalIndex >= 0 ? normalized.slice(decimalIndex + 1) : '';
  const francsText = (decimalIndex >= 0 ? normalized.slice(0, decimalIndex) : normalized).replace(/[.,]/g, '');
  const francs = Number(francsText);
  const fraction = fractionText ? Number(fractionText.padEnd(2, '0')) : 0;
  const cents = francs * 100 + fraction;
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function uniqueLabeledAmounts(text: string, labels: readonly string[]): number[] {
  const expression = new RegExp(
    String.raw`(?:${labels.join('|')})\s*(?:[:=\-]\s*)?(?:CHF\s*)?(${PRINTED_AMOUNT})(?:\s*CHF)?(?=\s*(?:[.;|\n\r]|$))`,
    'giu',
  );
  const amounts = [...text.matchAll(expression)]
    .map((match) => printedFrancsToCents(match[1] ?? ''))
    .filter((amount): amount is number => amount !== null);
  return [...new Set(amounts)];
}

function uniqueEmployeeNames(text: string): string[] {
  const expression = new RegExp(
    String.raw`(?:${EMPLOYEE_LABEL})\s*(?:[:=\-]\s*)([\p{L}\p{M}][\p{L}\p{M}'’\- ]{1,118}?)(?=\s*(?:[.;|\n\r]|$))`,
    'giu',
  );
  const names = [...text.matchAll(expression)]
    .map((match) => (match[1] ?? '').replace(/\s+/g, ' ').trim())
    .filter((name) => name.length >= 2 && name.length <= 120);
  const byComparableName = new Map<string, string>();
  for (const name of names) {
    const comparable = name.normalize('NFKC').toLocaleLowerCase('fr-CH');
    if (!byComparableName.has(comparable)) byComparableName.set(comparable, name);
  }
  return [...byComparableName.values()];
}

/**
 * Narrow, local fallback for the three fields needed to identify a useful
 * payslip draft. It only accepts explicitly labelled values from the PDF text
 * layer and rejects ambiguity; it never infers a name or an unlabelled amount.
 */
export function payrollCoreFromLocalText(
  extractedText: string,
  sourcePage: number,
): PayrollCoreTextFallback | null {
  const text = extractedText.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  const employeeNames = uniqueEmployeeNames(text);
  const grossAmounts = uniqueLabeledAmounts(text, GROSS_LABELS);
  const netAmounts = uniqueLabeledAmounts(text, NET_LABELS);
  if (employeeNames.length !== 1 || grossAmounts.length !== 1 || netAmounts.length !== 1) return null;

  const employeeName = employeeNames[0];
  const grossCents = grossAmounts[0];
  const netCents = netAmounts[0];
  if (netCents > grossCents * 2) return null;
  const normalizedPage = Math.max(1, Math.min(200, Math.round(sourcePage) || 1));
  return {
    employeeName,
    grossCents,
    netCents,
    rawOutput: JSON.stringify({
      employee_name: employeeName,
      gross_cents: grossCents,
      net_cents: netCents,
      source_page: normalizedPage,
    }),
  };
}

/**
 * Extract explicit payroll rows from the local text layer. The vocabulary is
 * deliberately finite: an unknown label is omitted rather than guessed into
 * a legal/accounting category. The review screen remains mandatory.
 */
export function payrollLinesFromLocalText(
  extractedText: string,
  sourcePage: number,
): PayrollLinesTextFallback | null {
  const text = extractedText.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  const normalizedPage = Math.max(1, Math.min(200, Math.round(sourcePage) || 1));
  const seen = new Set<string>();
  const lines: PayrollLinesTextFallback['lines'] = [];

  for (const rule of PAYROLL_LINE_RULES) {
    const expression = new RegExp(
      String.raw`(${rule.labels.join('|')})\s*(?:[:=\-]\s*)?(?:CHF\s*)?(${PRINTED_AMOUNT})(?:\s*CHF)?(?=\s*(?:[.;|\n\r]|$))`,
      'giu',
    );
    for (const match of text.matchAll(expression)) {
      const label = (match[1] ?? '').replace(/\s+/g, ' ').trim();
      const amountCents = printedFrancsToCents(match[2] ?? '');
      if (!label || amountCents === null) continue;
      const key = `${rule.kind}\u0000${label.normalize('NFKC').toLocaleLowerCase('fr-CH')}\u0000${amountCents}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ label, kind: rule.kind, amountCents, sourcePage: normalizedPage });
    }
  }
  if (!lines.length) return null;
  return {
    lines,
    rawOutput: JSON.stringify({
      source_page: normalizedPage,
      lines: lines.map((line) => [line.label, line.kind, line.amountCents]),
    }),
  };
}






